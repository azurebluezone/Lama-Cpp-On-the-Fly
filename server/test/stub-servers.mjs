#!/usr/bin/env node
/**
 * Test fixtures — a fake world with the shapes this build must handle:
 *   node stub-servers.mjs stdio            # MCP over stdio
 *   node stub-servers.mjs http 9945        # MCP + OpenAI + Anthropic over TCP
 *   node stub-servers.mjs http /tmp/x.sock # same over a Unix socket
 * Nothing here is used by production code; it exists so tests can prove
 * handshakes rather than claim them.
 */
import http from "node:http";
import fs from "node:fs";

const mode = process.argv[2] || "http";
const target = process.argv[3] || "9945";

const MCP_TOOLS = [{
  name: "echo",
  description: "Echo a value back",
  inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
}];

function rpcReply(msg) {
  if (msg.method === "initialize") {
    return { jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "stub", version: "1.0.0" } } };
  }
  if (msg.method === "tools/list") return { jsonrpc: "2.0", id: msg.id, result: { tools: MCP_TOOLS } };
  if (msg.method === "tools/call") {
    return {
      jsonrpc: "2.0", id: msg.id,
      result: { content: [{ type: "text", text: `echo:${msg.params?.arguments?.value ?? ""}` }] },
    };
  }
  if (msg.method === "notifications/initialized") return null;
  return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `no method ${msg.method}` } };
}

if (mode === "stdio") {
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      const reply = rpcReply(msg);
      if (reply) process.stdout.write(JSON.stringify(reply) + "\n");
    }
  });
  process.stdin.on("end", () => process.exit(0));
} else {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
      let j = {};
      try { j = JSON.parse(body || "{}"); } catch {}
      if (req.url === "/mcp") {
        const reply = rpcReply(j);
        return reply ? send(200, reply) : send(202, {});
      }
      if (req.url === "/v1/models") return send(200, { data: [{ id: "stub-model" }] });
      if (req.url === "/v1/chat/completions") {
        return send(200, {
          object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
        });
      }
      if (req.url === "/v1/messages") {
        return send(200, {
          content: [{ type: "text", text: "hi" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 5, output_tokens: 1 },
        });
      }
      send(404, { error: "not found" });
    });
  });
  if (/^\d+$/.test(target)) {
    server.listen(Number(target), "127.0.0.1", () => console.log(`READY http://127.0.0.1:${server.address().port}`));
  } else {
    try { fs.unlinkSync(target); } catch {}
    server.listen(target, () => {
      try { fs.chmodSync(target, 0o660); } catch {}
      console.log(`READY unix://${target}`);
    });
  }
}
