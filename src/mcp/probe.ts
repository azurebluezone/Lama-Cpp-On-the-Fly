import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { McpRow } from "../types.ts";

export interface McpProbeResult {
  ok: boolean;
  detail: string;
  tools: Array<{ name: string; description?: string }>;
}

interface RpcMessage {
  id?: number;
  result?: unknown;
  error?: { message?: string };
}

function waitFor(
  rl: ReturnType<typeof createInterface>,
  id: number,
  timeoutMs: number,
): Promise<RpcMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timeout after ${timeoutMs}ms waiting for id ${id}`));
    }, timeoutMs);
    const onLine = (line: string): void => {
      try {
        const message = JSON.parse(line) as RpcMessage;
        if (message.id !== id) return;
        cleanup();
        resolve(message);
      } catch {
        // ignore non-JSON lines
      }
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      rl.off("line", onLine);
    };
    rl.on("line", onLine);
  });
}

export async function probeStdio(row: McpRow, timeoutMs = 5000): Promise<McpProbeResult> {
  if (row.transport !== "stdio") {
    return {
      ok: false,
      detail: `${row.transport} MCP is orchestrator-side; llama.cpp only accepts stdio. No engine probe was attempted.`,
      tools: [],
    };
  }
  if (!row.command) return { ok: false, detail: "stdio row has no command", tools: [] };
  const env = { ...process.env, ...(JSON.parse(row.env_json || "{}") as Record<string, string>) };
  const args = JSON.parse(row.args_json || "[]") as string[];
  const child = spawn(row.command, args, {
    cwd: row.cwd || process.cwd(),
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const rl = createInterface({ input: child.stdout });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
    if (stderr.length > 4096) stderr = stderr.slice(-4096);
  });
  try {
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "lama-probe", version: "0.1.0" },
        },
      })}\n`,
    );
    const init = await waitFor(rl, 1, timeoutMs);
    if (init.error) return { ok: false, detail: init.error.message ?? "initialize failed", tools: [] };
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
    const list = await waitFor(rl, 2, timeoutMs);
    if (list.error) return { ok: false, detail: list.error.message ?? "tools/list failed", tools: [] };
    const result = list.result as { tools?: Array<{ name?: string; description?: string }> } | undefined;
    const tools = (result?.tools ?? [])
      .filter((tool): tool is { name: string; description?: string } => typeof tool.name === "string")
      .map((tool) => ({ name: tool.name, ...(tool.description ? { description: tool.description } : {}) }));
    return { ok: true, detail: `initialize + tools/list ok (${tools.length} tools)`, tools };
  } catch (error) {
    return { ok: false, detail: `${(error as Error).message}${stderr ? `; stderr: ${stderr.slice(0, 200)}` : ""}`, tools: [] };
  } finally {
    rl.close();
    child.kill("SIGTERM");
  }
}
