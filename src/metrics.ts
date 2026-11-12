import fs from "node:fs";
import os from "node:os";
import type { Config } from "./config.ts";
import type { Store } from "./db.ts";

/**
 * Linux-first system + engine metrics, read from /proc and Node built-ins.
 * No dependency, no shell command, no background daemon: the admin samples on demand and
 * the SSE loop samples once per tick so the percentage reflects a real interval.
 */
export interface CpuMetrics {
  percent: number;
  cores: number;
  load1: number;
  load5: number;
  load15: number;
}

export interface MemoryMetrics {
  total: number;
  used: number;
  available: number;
  percent: number;
  swap_total: number;
  swap_used: number;
  swap_percent: number;
  source: "proc-meminfo" | "os";
}

export interface DiskMetrics {
  path: string;
  total: number;
  free: number;
  used: number;
  percent: number;
}

export interface ProcessMetrics {
  pid: number;
  rss: number;
  cpu_percent: number;
  uptime_s: number;
}

export interface EngineMetrics extends ProcessMetrics {
  threads: number | null;
}

export interface MetricsSnapshot {
  at: string;
  interval_ms: number;
  cpu: CpuMetrics;
  memory: MemoryMetrics;
  disk: DiskMetrics;
  process: ProcessMetrics;
  engine: EngineMetrics | null;
  model: { id: string; name: string; alias: string } | null;
}

interface CpuTimes {
  idle: number;
  total: number;
}

interface ProcTimes {
  ticks: number;
  rss: number;
  threads: number;
  started_ticks: number;
  at: number;
}

function readFile(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function cpuTimes(): CpuTimes {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    const times = cpu.times;
    idle += times.idle;
    total += times.user + times.nice + times.sys + times.idle + times.irq;
  }
  return { idle, total };
}

function procTimes(pid: number): ProcTimes | null {
  if (process.platform !== "linux") return null;
  const stat = readFile(`/proc/${pid}/stat`);
  if (!stat) return null;
  // Field 2 (comm) may contain spaces, so parse from the closing parenthesis.
  const end = stat.lastIndexOf(")");
  if (end < 0) return null;
  const fields = stat.slice(end + 2).trim().split(/\s+/);
  // After comm (field 3 = index 0): utime 14→11, stime 15→12, num_threads 20→17,
  // starttime 22→19, rss 24→21 (index 20 is itrealvalue, a trap for off-by-one parsers).
  const utime = Number(fields[11]);
  const stime = Number(fields[12]);
  const threads = Number(fields[17]);
  const started = Number(fields[19]);
  const rssPages = Number(fields[21]);
  if (![utime, stime, started, rssPages].every(Number.isFinite)) return null;
  return {
    ticks: utime + stime,
    rss: Math.max(0, rssPages) * 4096,
    threads: Number.isFinite(threads) ? threads : 0,
    started_ticks: started,
    at: Date.now(),
  };
}

function memory(): MemoryMetrics {
  const raw = readFile("/proc/meminfo");
  if (!raw) {
    const total = os.totalmem();
    const available = os.freemem();
    return {
      total,
      available,
      used: total - available,
      percent: total ? Math.round(((total - available) / total) * 1000) / 10 : 0,
      swap_total: 0,
      swap_used: 0,
      swap_percent: 0,
      source: "os",
    };
  }
  const values = new Map<string, number>();
  for (const line of raw.split("\n")) {
    const match = /^(\w+):\s+(\d+)/.exec(line);
    if (match?.[1] && match[2]) values.set(match[1], Number(match[2]) * 1024);
  }
  const total = values.get("MemTotal") ?? 0;
  const available = values.get("MemAvailable") ?? values.get("MemFree") ?? 0;
  const used = Math.max(0, total - available);
  const swapTotal = values.get("SwapTotal") ?? 0;
  const swapFree = values.get("SwapFree") ?? 0;
  const swapUsed = Math.max(0, swapTotal - swapFree);
  return {
    total,
    available,
    used,
    percent: total ? Math.round((used / total) * 1000) / 10 : 0,
    swap_total: swapTotal,
    swap_used: swapUsed,
    swap_percent: swapTotal ? Math.round((swapUsed / swapTotal) * 1000) / 10 : 0,
    source: "proc-meminfo",
  };
}

function disk(root: string): DiskMetrics {
  try {
    const stat = fs.statfsSync(root);
    const total = stat.bsize * stat.blocks;
    const free = stat.bsize * stat.bavail;
    return {
      path: root,
      total,
      free,
      used: Math.max(0, total - free),
      percent: total ? Math.round(((total - free) / total) * 1000) / 10 : 0,
    };
  } catch {
    return { path: root, total: 0, free: 0, used: 0, percent: 0 };
  }
}

export class MetricsCollector {
  private readonly cfg: Config;
  private readonly store: Store;
  private lastCpu: CpuTimes | null = null;
  private lastProcess: { cpu: NodeJS.CpuUsage; at: number } | null = null;
  private readonly lastEngine = new Map<number, ProcTimes>();
  private lastAt = 0;

  constructor(cfg: Config, store: Store) {
    this.cfg = cfg;
    this.store = store;
  }

  private cpu(): CpuMetrics {
    const now = Date.now();
    const current = cpuTimes();
    const previous = this.lastCpu;
    let percent = 0;
    if (previous) {
      const total = current.total - previous.total;
      const idle = current.idle - previous.idle;
      if (total > 0) percent = Math.max(0, Math.min(100, (1 - idle / total) * 100));
    }
    this.lastCpu = current;
    const load = os.loadavg();
    return {
      percent: Math.round(percent * 10) / 10,
      cores: os.cpus().length,
      load1: Math.round((load[0] ?? 0) * 100) / 100,
      load5: Math.round((load[1] ?? 0) * 100) / 100,
      load15: Math.round((load[2] ?? 0) * 100) / 100,
    };
  }

  private processMetrics(): ProcessMetrics {
    const now = Date.now();
    const usage = process.cpuUsage();
    const percent = this.lastProcess
      ? (() => {
          const micros = usage.user - this.lastProcess.cpu.user + (usage.system - this.lastProcess.cpu.system);
          const elapsed = Math.max(1, now - this.lastProcess.at) * 1000;
          return Math.round((micros / elapsed) * 1000) / 10;
        })()
      : 0;
    this.lastProcess = { cpu: usage, at: now };
    return {
      pid: process.pid,
      rss: process.memoryUsage().rss,
      cpu_percent: percent,
      uptime_s: Math.round(process.uptime()),
    };
  }

  private engineMetrics(): EngineMetrics | null {
    const state = this.store.engineState();
    if (!state.pid || process.platform !== "linux") return null;
    const current = procTimes(state.pid);
    if (!current) return null;
    const previous = this.lastEngine.get(state.pid);
    let percent = 0;
    if (previous) {
      const ticks = Math.max(0, current.ticks - previous.ticks);
      const seconds = Math.max(0.001, (current.at - previous.at) / 1000);
      const hz = 100; // USER_HZ on Linux; llama.cpp does not change it.
      percent = Math.round((ticks / hz / seconds) * 1000) / 10;
    }
    this.lastEngine.set(state.pid, current);
    const bootSeconds = os.uptime() - current.started_ticks / 100;
    return {
      pid: state.pid,
      rss: current.rss,
      cpu_percent: Math.max(0, Math.min(100 * Math.max(1, os.cpus().length), percent)),
      threads: current.threads,
      uptime_s: Math.max(0, Math.round(bootSeconds)),
    };
  }

  sample(): MetricsSnapshot {
    const now = Date.now();
    const interval = this.lastAt ? now - this.lastAt : 0;
    this.lastAt = now;
    const engine = this.engineMetrics();
    const state = this.store.engineState();
    const row = state.model_id ? this.store.getModel(state.model_id) : undefined;
    return {
      at: new Date(now).toISOString(),
      interval_ms: interval,
      cpu: this.cpu(),
      memory: memory(),
      disk: disk(this.cfg.root),
      process: this.processMetrics(),
      engine,
      model: row ? { id: row.id, name: row.name, alias: row.model_id } : null,
    };
  }
}

/** Human-readable size, used by the API consumers and the UI (kept server-side once). */
export function formatBytes(value: number | null | undefined): string {
  if (!value || value < 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let index = 0;
  let amount = value;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index += 1;
  }
  return `${amount.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}
