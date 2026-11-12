#!/usr/bin/env node
import { createInterface } from "node:readline";
import { MCP_TOOLS, callTool } from "./tools.ts";

const SERVER_INFO = { name: "lama-tools", version: "0.1.0" };
const PROTOCOL_VERSION = "2024-11-05";

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
}

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id: JsonRpcId, value: unknown): void {
  send({ jsonrpc: "2.0", id, result: value });
}

function error(id: JsonRpcId, code: number, message: string, data?: unknown): void {
  send({ jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } });
}

async function handle(request: JsonRpcRequest): Promise<void> {
  const id = request.id ?? null;
  if (request.method === undefined) {
    error(id, -32600, "invalid request");
    return;
  }

  if (request.method === "initialize") {
    result(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
    });
    return;
  }

  if (request.method === "notifications/initialized" || request.method === "initialized") return;

  if (request.method === "ping") {
    result(id, {});
    return;
  }

  if (request.method === "tools/list") {
    result(id, { tools: MCP_TOOLS });
    return;
  }

  if (request.method === "tools/call") {
    const params = request.params as { name?: unknown; arguments?: unknown } | undefined;
    const name = typeof params?.name === "string" ? params.name : "";
    const args =
      params?.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
        ? (params.arguments as Record<string, unknown>)
        : {};
    try {
      const value = await callTool(name, args);
      result(id, { content: [{ type: "text", text: JSON.stringify(value) }] });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      result(id, { content: [{ type: "text", text: JSON.stringify({ error: message }) }], isError: true });
    }
    return;
  }

  if (request.method === "resources/list") {
    result(id, { resources: [] });
    return;
  }

  if (request.method === "prompts/list") {
    result(id, { prompts: [] });
    return;
  }

  error(id, -32601, `method not found: ${request.method}`);
}

function main(): void {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      error(null, -32700, "parse error");
      return;
    }
    void handle(request).catch((cause: unknown) => {
      const message = cause instanceof Error ? cause.message : String(cause);
      error(request.id ?? null, -32603, `internal error: ${message}`);
    });
  });
  rl.on("close", () => process.exit(0));
  process.stderr.write(`lama-tools MCP server ready (${MCP_TOOLS.length} tools)\n`);
}

main();
