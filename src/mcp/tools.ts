import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

const MAX_BYTES = 1024 * 1024;
const SECRET_PATTERN = /(^|[/\\])(\.ssh|\.gnupg)([/\\]|$)|(^|[/\\])\.env($|\.)|\.pem$|\.key$|(^|[/\\])id_(rsa|ed25519)($|\.)/i;

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const MCP_TOOLS: ToolDefinition[] = [
  {
    name: "read_file",
    description: "Read a UTF-8 text file inside the configured workspace. Refuses secrets and paths outside the workspace.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Path relative to the workspace" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "write_file",
    description: "Write a UTF-8 text file inside the configured workspace. Refuses paths outside the workspace and secrets.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the workspace" },
        content: { type: "string", description: "File content, at most 1 MiB" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "list_dir",
    description: "List entries in a directory inside the workspace.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Directory relative to the workspace (default: .)" } },
      additionalProperties: false,
    },
  },
  {
    name: "run_shell",
    description:
      "Run one read-only command from an allow-list without a shell. Metacharacters, interpreters and write flags are refused.",
    inputSchema: {
      type: "object",
      properties: { cmd: { type: "string", description: "Command line, e.g. 'ls -la models'" } },
      required: ["cmd"],
      additionalProperties: false,
    },
  },
  {
    name: "http_fetch",
    description: "Fetch an HTTP/HTTPS URL and return status, headers and up to 1 MiB of text.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        method: { type: "string", enum: ["GET", "HEAD"] },
        headers: { type: "object", additionalProperties: { type: "string" } },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
];

/** Short, human explanation shown in the MCP matrix (not in the integration docs). */
export const TOOL_USE_CASES: Record<string, string> = {
  read_file: "Read a workspace file before editing or to gather evidence.",
  write_file: "Write or update a workspace file; refuses secrets and paths outside the workspace.",
  list_dir: "Inspect a workspace directory before choosing a file.",
  run_shell: "Run one read-only allow-listed command (ls, wc, head, git status) without a shell.",
  http_fetch: "Fetch an HTTP/HTTPS URL for read-only checks such as /health or /v1/models.",
};

export function workspaceRoot(): string {
  return path.resolve(process.env.LAMA_WORKSPACE || process.cwd());
}

function assertSafeRelative(input: unknown): string {
  const raw = typeof input === "string" && input.trim() ? input.trim() : ".";
  if (raw.includes("\0")) throw new Error("path contains NUL");
  if (SECRET_PATTERN.test(raw)) throw new Error("refusing a secret-looking path");
  const root = workspaceRoot();
  const target = path.resolve(root, raw);
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error("path escapes the workspace");
  return target;
}

async function resolveExisting(input: unknown): Promise<string> {
  const target = assertSafeRelative(input);
  const real = await fs.realpath(target);
  const root = await fs.realpath(workspaceRoot());
  if (real !== root && !real.startsWith(root + path.sep)) throw new Error("resolved path escapes the workspace");
  return real;
}

async function readFileTool(args: Record<string, unknown>): Promise<unknown> {
  const target = await resolveExisting(args.path);
  const stat = await fs.stat(target);
  if (!stat.isFile()) throw new Error("not a regular file");
  if (stat.size > MAX_BYTES) throw new Error(`file is larger than ${MAX_BYTES} bytes`);
  return { path: target, content: await fs.readFile(target, "utf8") };
}

async function writeFileTool(args: Record<string, unknown>): Promise<unknown> {
  const rawPath = assertSafeRelative(args.path);
  const content = typeof args.content === "string" ? args.content : "";
  if (Buffer.byteLength(content) > MAX_BYTES) throw new Error(`content is larger than ${MAX_BYTES} bytes`);
  await fs.mkdir(path.dirname(rawPath), { recursive: true, mode: 0o700 });
  const parent = await fs.realpath(path.dirname(rawPath));
  const root = await fs.realpath(workspaceRoot());
  if (parent !== root && !parent.startsWith(root + path.sep)) throw new Error("parent escapes the workspace");
  await fs.writeFile(rawPath, content, { encoding: "utf8", mode: 0o600 });
  return { path: rawPath, bytes: Buffer.byteLength(content) };
}

async function listDirTool(args: Record<string, unknown>): Promise<unknown> {
  const target = await resolveExisting(args.path ?? ".");
  const stat = await fs.stat(target);
  if (!stat.isDirectory()) throw new Error("not a directory");
  const entries = await fs.readdir(target, { withFileTypes: true });
  return {
    path: target,
    entries: entries.slice(0, 500).map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? "dir" : entry.isFile() ? "file" : "other",
    })),
  };
}

const SHELL_ALLOWLIST = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "stat",
  "file",
  "du",
  "df",
  "uname",
  "date",
  "pwd",
  "which",
  "rg",
  "grep",
  "find",
]);

function splitCommand(input: string): string[] {
  if (/[;&|$><`\\\n\r]/.test(input)) throw new Error("shell metacharacters are refused");
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (const ch of input.trim()) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (quote) throw new Error("unterminated quote");
  if (current) out.push(current);
  return out;
}

function runShellTool(args: Record<string, unknown>): unknown {
  const line = typeof args.cmd === "string" ? args.cmd : "";
  const parts = splitCommand(line);
  if (parts.length === 0) throw new Error("empty command");
  const binary = parts[0] ?? "";
  if (!SHELL_ALLOWLIST.has(binary)) throw new Error(`command ${binary} is not in the allow-list`);
  for (const arg of parts.slice(1)) {
    if (/(^|[/\\])(\.ssh|\.env|id_rsa|id_ed25519)/i.test(arg)) throw new Error("refusing a secret-looking path");
    if (binary === "find" && /^-(exec|execdir|delete|ok|okdir)$/i.test(arg)) throw new Error("find write/exec flags are refused");
    if (binary === "sed" && /^-i/.test(arg)) throw new Error("in-place edits are refused");
  }
  const result = spawnSync(binary, parts.slice(1), {
    cwd: workspaceRoot(),
    shell: false,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: MAX_BYTES,
  });
  return {
    command: parts,
    status: result.status,
    signal: result.signal,
    stdout: (result.stdout ?? "").slice(0, MAX_BYTES),
    stderr: (result.stderr ?? "").slice(0, 16_384),
  };
}

async function httpFetchTool(args: Record<string, unknown>): Promise<unknown> {
  const raw = typeof args.url === "string" ? args.url : "";
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("only http/https is allowed");
  const method = args.method === "HEAD" ? "HEAD" : "GET";
  const headers: Record<string, string> = {};
  if (args.headers && typeof args.headers === "object" && !Array.isArray(args.headers)) {
    for (const [key, value] of Object.entries(args.headers as Record<string, unknown>)) {
      if (typeof value === "string") headers[key] = value;
    }
  }
  const response = await fetch(url, { method, headers, signal: AbortSignal.timeout(15_000) });
  const text = method === "HEAD" ? "" : (await response.text()).slice(0, MAX_BYTES);
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: text,
  };
}

export async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "read_file":
      return readFileTool(args);
    case "write_file":
      return writeFileTool(args);
    case "list_dir":
      return listDirTool(args);
    case "run_shell":
      return runShellTool(args);
    case "http_fetch":
      return httpFetchTool(args);
    default:
      throw new Error(`unknown tool ${name}`);
  }
}
