#!/usr/bin/env node
// mmap-ram-proof.mjs — prove from live /proc data how the running llama engine holds its GGUF:
// read-only shared mmap (file-backed page cache) vs anonymous heap copy. Also reports swap state.

import fs from "node:fs";

const KIB = 1024;
const MIB = 1024 * 1024;

function read(path) {
  try {
    return fs.readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function kv(block) {
  const out = {};
  for (const line of block.split("\n")) {
    const match = line.match(/^(\w+):\s+(\d+)\s*kB$/);
    if (match) out[match[1]] = Number(match[2]);
  }
  return out;
}

function findEngine() {
  for (const name of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const cmdline = read(`/proc/${name}/cmdline`);
    if (!cmdline) continue;
    const args = cmdline.split("\0").filter(Boolean);
    const model = args.find((arg) => arg.endsWith(".gguf"));
    if (!model || !args.some((arg) => arg === "serve")) continue;
    return { pid: Number(name), model, args };
  }
  return null;
}

const engine = findEngine();
if (!engine) {
  console.log("MMAP_ERROR=engine_not_running");
  process.exit(1);
}

const { pid, model, args } = engine;
const meminfo = kv(read("/proc/meminfo"));
const status = kv(read(`/proc/${pid}/status`));

let mappedBytes = 0;
let mainPerm = "none";
const perms = new Set();
for (const line of read(`/proc/${pid}/maps`).split("\n")) {
  if (!line.includes(model)) continue;
  const fields = line.split(/\s+/);
  const [startHex, endHex] = fields[0].split("-");
  const size = Number.parseInt(endHex, 16) - Number.parseInt(startHex, 16);
  perms.add(fields[1]);
  if (size > mappedBytes) {
    mappedBytes = size;
    mainPerm = fields[1];
  }
}

let fileRssKb = 0;
let fileSwapKb = 0;
let inModel = false;
for (const line of read(`/proc/${pid}/smaps`).split("\n")) {
  if (line.includes(model)) { inModel = true; continue; }
  if (!inModel) continue;
  if (line.startsWith("Rss:")) fileRssKb += Number(line.split(/\s+/)[1]);
  if (line.startsWith("Swap:")) fileSwapKb += Number(line.split(/\s+/)[1]);
  if (line.startsWith("VmFlags:")) inModel = false;
}

const fileBytes = fs.statSync(model).size;
const coverage = (100 * mappedBytes) / fileBytes;
const mmapEnabled = !args.includes("--no-mmap") && mappedBytes > 0 && mainPerm === "r--s";
const swapTotalKb = meminfo.SwapTotal ?? -1;
const vmSwapKb = status.VmSwap ?? -1;
const mlockedKb = status.VmLck ?? -1;
const fileBackedRssMb = Math.round(fileRssKb / KIB);
const anonymousRssMb = Math.round((status.RssAnon ?? 0) / KIB);

const ok =
  swapTotalKb === 0 &&
  vmSwapKb === 0 &&
  fileSwapKb === 0 &&
  mlockedKb === 0 &&
  mmapEnabled &&
  fileBackedRssMb > 1024 &&
  coverage > 90;

console.log(`pid=${pid}`);
console.log(`model=${model}`);
console.log(`swap_total_kb=${swapTotalKb} swap_used_kb=${swapTotalKb - (meminfo.SwapFree ?? 0)}`);
console.log(`vm_swap_kb=${vmSwapKb} mlocked_kb=${mlockedKb} no_mmap_flag=${args.includes("--no-mmap")}`);
console.log(`file_bytes=${fileBytes} mapped_bytes=${mappedBytes} coverage_pct=${coverage.toFixed(2)}`);
console.log(`vma_perms=${[...perms].join(",")} main_vma_perm=${mainPerm}`);
console.log(`file_backed_rss_mb=${fileBackedRssMb} anonymous_rss_mb=${anonymousRssMb} mmap_enabled=${mmapEnabled}`);

const summary = {
  swap_total_kb: swapTotalKb,
  swap_used_kb: swapTotalKb - (meminfo.SwapFree ?? 0),
  gguf_vma_perm: mainPerm,
  gguf_shared_mapping: mappedBytes > 0 && mainPerm === "r--s",
  mmap_enabled: mmapEnabled,
  mlocked_kb: mlockedKb,
  vm_swap_kb: vmSwapKb,
  file_backed_rss_mb: fileBackedRssMb,
  anonymous_rss_mb: anonymousRssMb,
  mapped_coverage_pct: Number(coverage.toFixed(2)),
  pid,
};
console.log(`MMAP_SUMMARY ${JSON.stringify(summary)}`);
process.exit(ok ? 0 : 1);
