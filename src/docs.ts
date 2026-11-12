import type { Config } from "./config.ts";
import type { Store } from "./db.ts";
import type { TransportRow } from "./types.ts";
import { liveTransport } from "./engine.ts";

/**
 * Provider-style documentation generated from the live registry. Everything below is built
 * from real values (transport endpoint, model alias, UDS path), so a third party can copy a
 * block and run it. The same data drives the Transports view and the Markdown download.
 */
export interface DocBlock {
  kind: "text" | "code" | "table" | "note";
  title?: string;
  text?: string;
  language?: string;
  head?: string[];
  rows?: string[][];
}

export interface DocSection {
  id: string;
  title: string;
  summary: string;
  blocks: DocBlock[];
}

export interface TransportDocs {
  transport: { id: string; name: string; protocol: string; endpoint: string };
  generated_at: string;
  model_alias: string;
  gateway_url: string;
  sections: DocSection[];
}

function endpointOf(transport: TransportRow): string {
  if (transport.protocol === "uds") return transport.socket_path ?? "";
  return `${transport.protocol}://${transport.host ?? "127.0.0.1"}:${transport.port ?? 9932}`;
}

function curl(transport: TransportRow, pathPart: string, payload: string, extra = ""): string {
  if (transport.protocol === "uds") {
    return `curl -sS -N --unix-socket ${transport.socket_path} http://localhost${pathPart} \\\n  -H 'content-type: application/json' \\\n  -d '${payload}'${extra ? ` \\\n  ${extra}` : ""}`;
  }
  return `curl -sS -N ${endpointOf(transport)}${pathPart} \\\n  -H 'content-type: application/json' \\\n  -d '${payload}'${extra ? ` \\\n  ${extra}` : ""}`;
}

function nodeSnippet(transport: TransportRow, pathPart: string, payload: string): string {
  if (transport.protocol === "uds") {
    return `import http from "node:http";

const body = JSON.stringify(${payload});
const req = http.request({
  socketPath: ${JSON.stringify(transport.socket_path ?? "")},
  path: ${JSON.stringify(pathPart)},
  method: "POST",
  headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
}, (res) => {
  res.setEncoding("utf8");
  res.on("data", (chunk) => process.stdout.write(chunk));
});
req.end(body);`;
  }
  return `const response = await fetch(${JSON.stringify(`${endpointOf(transport)}${pathPart}`)}, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(${payload}),
});
const data = await response.json();
console.log(data);`;
}

export function buildTransportDocs(
  store: Store,
  cfg: Config,
  storedTransport: TransportRow,
  modelAlias: string,
): TransportDocs {
  // A blue-green reload moves the engine; generated curl blocks must point at
  // the live port, not the boot-time row.
  const transport = liveTransport(store, cfg, storedTransport);
  const endpoint = endpointOf(transport);
  const isUds = transport.protocol === "uds";
  const gatewayUrl = `http://${cfg.gatewayHost}:${cfg.gatewayPort}`;
  const chatPayload = `{"model":${JSON.stringify(modelAlias)},"messages":[{"role":"user","content":"hello"}],"max_tokens":64}`;
  const streamPayload = `{"model":${JSON.stringify(modelAlias)},"messages":[{"role":"user","content":"hello"}],"max_tokens":128,"stream":true}`;
  const anthropicPayload = `{"model":${JSON.stringify(modelAlias)},"max_tokens":64,"messages":[{"role":"user","content":"hello"}]}`;
  const anthropicStream = `{"model":${JSON.stringify(modelAlias)},"max_tokens":128,"stream":true,"messages":[{"role":"user","content":"hello"}]}`;
  const toolPayload = `{
  "model": ${JSON.stringify(modelAlias)},
  "max_tokens": 256,
  "messages": [{"role": "user", "content": "List the files in the workspace."}],
  "tools": [{
    "type": "function",
    "function": {
      "name": "list_dir",
      "description": "List entries in a directory inside the workspace.",
      "parameters": {
        "type": "object",
        "properties": {"path": {"type": "string"}},
        "additionalProperties": false
      }
    }
  }]
}`;

  const sections: DocSection[] = [
    {
      id: "connection",
      title: "Connection",
      summary: "One engine, one model at a time. Pick the transport that matches your process boundary.",
      blocks: [
        {
          kind: "table",
          head: ["Field", "Value"],
          rows: [
            ["Transport", `${transport.name} (${transport.protocol})`],
            ["Endpoint", endpoint],
            ["Model alias", modelAlias],
            ["Health", isUds ? `curl --unix-socket ${transport.socket_path} http://localhost/health` : `curl ${endpoint}/health`],
            ["Gateway proxy", `${gatewayUrl}/v1`],
            ["Auth", "Engine API key when LAMA_ENGINE_API_KEY is set; the gateway proxy is loopback-only or uses LAMA_API_KEY."],
          ],
        },
        {
          kind: "note",
          text: isUds
            ? "The socket directory is 0700 and the socket is 0660, owned by the user that runs the manager. A different user cannot connect even though /tmp is world-writable."
            : "Bind the engine to 127.0.0.1 unless a firewall fronts it. The gateway proxy is the safer public entry point.",
        },
      ],
    },
    {
      id: "models",
      title: "Models and aliases",
      summary: "The `model` field must match the alias the engine was started with, not the file name.",
      blocks: [
        {
          kind: "text",
          text: `The current alias is ${modelAlias}. It is derived from the registry row (model_id) and passed to llama.cpp as --alias. Clients that send the GGUF file name instead get a 404/400 from the engine. List the live catalogue with:`,
        },
        { kind: "code", language: "bash", text: curl(transport, "/v1/models", "") },
      ],
    },
    {
      id: "openai-chat",
      title: "OpenAI-compatible chat",
      summary: "POST /v1/chat/completions, with and without streaming, plus tool calls.",
      blocks: [
        { kind: "text", text: "Non-streaming: the response contains choices[0].message.content." },
        { kind: "code", language: "bash", text: curl(transport, "/v1/chat/completions", chatPayload) },
        { kind: "code", language: "typescript", text: nodeSnippet(transport, "/v1/chat/completions", chatPayload) },
        { kind: "text", text: "Streaming: send \"stream\": true. Each line is `data: {json}` and the stream ends with `data: [DONE]`." },
        { kind: "code", language: "bash", text: curl(transport, "/v1/chat/completions", streamPayload) },
        {
          kind: "code",
          language: "text",
          text: `data: {"choices":[{"delta":{"role":"assistant","content":""}}]}
data: {"choices":[{"delta":{"content":"Hel"}}]}
data: {"choices":[{"delta":{"content":"lo"}}]}
data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":9,"completion_tokens":2}}
data: [DONE]`,
        },
        { kind: "text", text: "Tool calls: pass an OpenAI `tools` array. The model may answer with `choices[0].message.tool_calls`; parsing never executes a tool by itself." },
        { kind: "code", language: "bash", text: curl(transport, "/v1/chat/completions", toolPayload) },
      ],
    },
    {
      id: "anthropic-messages",
      title: "Anthropic Messages",
      summary: "POST /v1/messages with the system prompt in the top-level `system` field.",
      blocks: [
        { kind: "text", text: "Non-streaming: content is an array of blocks; text lives in `content[0].text`. Usage is `usage.input_tokens` / `usage.output_tokens`." },
        { kind: "code", language: "bash", text: curl(transport, "/v1/messages", anthropicPayload) },
        { kind: "text", text: "Streaming uses named events: `message_start`, `content_block_delta`, `message_delta`, `message_stop`." },
        { kind: "code", language: "bash", text: curl(transport, "/v1/messages", anthropicStream) },
        {
          kind: "code",
          language: "text",
          text: `event: message_start
data: {"type":"message_start","message":{"usage":{"input_tokens":9,"output_tokens":0}}}

event: content_block_delta
data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}

event: message_delta
data: {"type":"message_delta","usage":{"output_tokens":2}}

event: message_stop
data: {"type":"message_stop"}`,
        },
        { kind: "text", text: "Anthropic tools use the same `tools` array but each entry has `name`, `description` and `input_schema`. A tool request arrives as a `tool_use` content block." },
        {
          kind: "code",
          language: "bash",
          text: curl(
            transport,
            "/v1/messages",
            `{"model":${JSON.stringify(modelAlias)},"max_tokens":256,"messages":[{"role":"user","content":"List the files in the workspace."}],"tools":[{"name":"list_dir","description":"List entries in a directory inside the workspace.","input_schema":{"type":"object","properties":{"path":{"type":"string"}},"additionalProperties":false}}]}`,
          ),
        },
      ],
    },
    {
      id: "system-prompt",
      title: "System prompt",
      summary: "llama.cpp stores no prompt. The caller sends it; the manager versions it.",
      blocks: [
        {
          kind: "text",
          text: "Fetch the managed text once and prepend it to every conversation. OpenAI shape: messages[0] = {role: \"system\", content}. Anthropic shape: top-level system = \"...\".",
        },
        { kind: "code", language: "bash", text: `TOKEN=$(grep '^LAMA_ADMIN_TOKEN=' .env | cut -d= -f2)\ncurl -sS -H "authorization: Bearer $TOKEN" ${gatewayUrl}/api/system-prompt.txt` },
        {
          kind: "code",
          language: "json",
          text: `{
  "model": ${JSON.stringify(modelAlias)},
  "messages": [
    {"role": "system", "content": "<paste the managed prompt>"},
    {"role": "user", "content": "hello"}
  ],
  "max_tokens": 128
}`,
        },
      ],
    },
    {
      id: "parser",
      title: "Tool-call parser",
      summary: "Some models emit markers instead of native tool_calls. Parse before executing.",
      blocks: [
        { kind: "text", text: "The parser accepts native tool_calls, `TOOL: name` + `ARGS: {json}` markers, and a bare JSON block. It never executes. Send text to POST /api/tools/parse; execution is POST /api/tools/call." },
        {
          kind: "code",
          language: "bash",
          text: `TOKEN=$(grep '^LAMA_ADMIN_TOKEN=' .env | cut -d= -f2)\ncurl -sS -X POST ${gatewayUrl}/api/tools/parse \\\n  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \\\n  -d '{"text":"TOOL: read_file\\nARGS: {\\"path\\":\\"README.md\\"}"}'`,
        },
      ],
    },
    {
      id: "errors",
      title: "Status codes and failures",
      summary: "What the engine and the manager return when something is wrong.",
      blocks: [
        {
          kind: "table",
          head: ["Status", "Meaning", "What to do"],
          rows: [
            ["200", "Success", "Parse the body or keep reading the stream."],
            ["400", "Bad JSON, unknown model alias, missing field", "Check the alias with GET /v1/models."],
            ["401", "Auth required", "Send Authorization: Bearer for the manager proxy or engine."],
            ["404", "Unknown path or model", "Use /v1/chat/completions or /v1/messages and the exact alias."],
            ["500", "Engine failed while generating", "Read the engine log under logs/ and retry after /health is 200."],
            ["502", "Manager could not reach the engine", "Load a model in Runtime; check engine state and the UDS path."],
          ],
        },
        {
          kind: "note",
          text: "TTL expiry unloads the model and removes the socket. A request after expiry fails until a model is loaded again.",
        },
      ],
    },
    {
      id: "realtime",
      title: "Real-time events",
      summary: "The gateway exposes SSE for logs, requests, engine transitions and metrics.",
      blocks: [
        {
          kind: "text",
          text: "GET /api/events with the admin token returns text/event-stream. Named events: hello, audit, request, engine, metrics, mcp, tool, ping. This is for dashboards; no business logic depends on it.",
        },
        {
          kind: "code",
          language: "bash",
          text: `TOKEN=$(grep '^LAMA_ADMIN_TOKEN=' .env | cut -d= -f2)\ncurl -sS -N -H "authorization: Bearer $TOKEN" ${gatewayUrl}/api/events`,
        },
      ],
    },
  ];

  return {
    transport: { id: transport.id, name: transport.name, protocol: transport.protocol, endpoint },
    generated_at: new Date().toISOString(),
    model_alias: modelAlias,
    gateway_url: gatewayUrl,
    sections,
  };
}

export function docsToMarkdown(docs: TransportDocs): string {
  const lines: string[] = [
    `# ${docs.transport.name} — integration guide`,
    "",
    `Endpoint: \`${docs.transport.endpoint}\`  `,
    `Model alias: \`${docs.model_alias}\`  `,
    `Generated: ${docs.generated_at}`,
    "",
  ];
  for (const section of docs.sections) {
    lines.push(`## ${section.title}`, "", section.summary, "");
    for (const block of section.blocks) {
      if (block.kind === "text" && block.text) lines.push(block.text, "");
      if (block.kind === "note" && block.text) lines.push(`> ${block.text}`, "");
      if (block.kind === "code" && block.text) {
        const fence = block.language && block.language !== "text" ? block.language : "";
        lines.push(`\`\`\`${fence}`, block.text, "```", "");
      }
      if (block.kind === "table" && block.head && block.rows) {
        lines.push(`| ${block.head.join(" | ")} |`, `| ${block.head.map(() => "---").join(" | ")} |`);
        for (const row of block.rows) lines.push(`| ${row.join(" | ")} |`);
        lines.push("");
      }
    }
  }
  return `${lines.join("\n")}\n`;
}
