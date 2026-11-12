import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Store } from "./db.ts";

// Hugging Face Hub client on the standard library only: global fetch (Node >= 18)
// and node:fs streams. A dependency must earn its place; the Hub is plain HTTPS.
const HF_ORIGIN = "https://huggingface.co";
const HF_TOKEN_KEY = "hf_token";

export interface HfFile {
  path: string;
  size: number;
}

export interface HfDownloadResult {
  path: string;
  bytes: number;
}

function authHeaders(token: string | null): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {};
}

export function maskToken(token: string): string {
  if (token.length <= 8) return "****";
  return `${token.slice(0, 3)}****${token.slice(-4)}`;
}

export function getToken(store: Store): string | null {
  return store.setting(HF_TOKEN_KEY) || null;
}

export function setToken(store: Store, token: string): void {
  store.setSetting(HF_TOKEN_KEY, token);
}

export function clearToken(store: Store): void {
  store.setSetting(HF_TOKEN_KEY, "");
}

export function sanitizeFileName(file: string): string {
  const base = file.split("/").pop() ?? "";
  const safe = base.replace(/[^A-Za-z0-9._-]/g, "_");
  if (!safe || safe === "." || safe === "..") throw new Error(`unsafe file name: ${file}`);
  return safe;
}

export function resolveUrl(repo: string, file: string): string {
  const cleanRepo = repo.replace(/^\/+|\/+$/g, "");
  const cleanFile = file.replace(/^\/+/g, "");
  return `${HF_ORIGIN}/${cleanRepo}/resolve/main/${cleanFile}`;
}

export async function listGgufFiles(repo: string, token: string | null): Promise<HfFile[]> {
  const url = `${HF_ORIGIN}/api/models/${repo.replace(/^\/+|\/+$/g, "")}?blobs=true`;
  const res = await fetch(url, { headers: authHeaders(token), signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`HF list ${repo}: HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`);
  const data = (await res.json()) as { siblings?: Array<{ rfilename: string; size?: number }> };
  return (data.siblings ?? [])
    .filter((row) => row.rfilename.toLowerCase().endsWith(".gguf"))
    .map((row) => ({ path: row.rfilename, size: typeof row.size === "number" ? row.size : 0 }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Read at most `bytes` from the start of a resolve URL. The reader is capped and
 * cancelled on purpose: even if the CDN answers 200 with the full file, memory
 * stays bounded.
 */
export async function fetchRange(url: string, token: string | null, bytes: number): Promise<number> {
  const res = await fetch(url, {
    headers: { ...authHeaders(token), range: `bytes=0-${bytes - 1}` },
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status !== 200 && res.status !== 206) throw new Error(`range fetch ${url}: HTTP ${res.status}`);
  if (!res.body) throw new Error(`range fetch ${url}: empty body`);
  const reader = res.body.getReader();
  let received = 0;
  while (received < bytes) {
    const { done, value } = await reader.read();
    if (done) break;
    received += Math.min(value.length, bytes - received);
    if (received >= bytes) {
      await reader.cancel();
      break;
    }
  }
  if (received === 0) throw new Error(`range fetch ${url}: 0 bytes received`);
  return received;
}

/**
 * Download one repository file into destDir. A `<name>.part` file carries the
 * bytes across restarts and is renamed only after the byte count is verified,
 * so a failed or interrupted run never leaves a half file under the final name.
 */
export async function downloadFile(
  repo: string,
  file: string,
  destDir: string,
  token: string | null,
  onProgress?: (bytesDone: number, bytesTotal: number) => void,
): Promise<HfDownloadResult> {
  fs.mkdirSync(destDir, { recursive: true });
  const name = sanitizeFileName(file);
  if (!name.toLowerCase().endsWith(".gguf")) throw new Error(`only .gguf files are downloaded, got: ${file}`);
  const dest = path.join(destDir, name);
  const part = `${dest}.part`;

  let offset = 0;
  try {
    offset = fs.statSync(part).size;
  } catch {
    offset = 0;
  }

  const headers: Record<string, string> = { ...authHeaders(token) };
  if (offset > 0) headers.range = `bytes=${offset}-`;
  const res = await fetch(resolveUrl(repo, file), { headers, redirect: "follow" });

  if (res.status === 416) {
    if (offset === 0) throw new Error(`HF download ${repo}/${file}: HTTP 416`);
    // The partial file is stale against the remote size; start over once.
    fs.rmSync(part, { force: true });
    return downloadFile(repo, file, destDir, token, onProgress);
  }
  if (res.status !== 200 && res.status !== 206) {
    throw new Error(`HF download ${repo}/${file}: HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`);
  }

  const resumed = res.status === 206 && offset > 0;
  const contentLength = Number(res.headers.get("content-length") ?? 0);
  const total = resumed && contentLength ? offset + contentLength : contentLength;
  if (!res.body) throw new Error(`HF download ${repo}/${file}: empty body`);

  let done = offset;
  const body = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream);
  body.on("data", (chunk: Buffer) => {
    done += chunk.length;
    onProgress?.(done, total);
  });
  await pipeline(body, fs.createWriteStream(part, { flags: resumed ? "a" : "w" }));

  if (total > 0 && done !== total) throw new Error(`incomplete download: ${done}/${total} bytes`);
  fs.renameSync(part, dest);
  return { path: dest, bytes: done };
}
