import type { Config } from "./config.ts";
import type { Store } from "./db.ts";

/**
 * Copy-paste integration guide for the three languages people actually script this with
 * (Node, Python, PHP) plus curl. Every block is built from the live endpoint, socket path and
 * model alias, so a paste runs as-is; the admin token is always read from the environment and
 * never rendered into the page or the Markdown export.
 */
export type DocLanguage = "bash" | "node" | "python" | "php";

export interface DocExample {
  language: DocLanguage;
  label: string;
  code: string;
}

export interface DocScenario {
  id: string;
  title: string;
  summary: string;
  notes: string[];
  examples: DocExample[];
}

export interface DocStep {
  title: string;
  body: string;
  code?: string;
}

export interface IntegrationDocs {
  generated_at: string;
  model_alias: string;
  gateway_url: string;
  engine_url: string;
  uds_path: string | null;
  languages: Array<{ id: DocLanguage; label: string }>;
  scenarios: DocScenario[];
  uds: { summary: string; examples: DocExample[] };
  install: { title: string; intro: string; steps: DocStep[]; finish: string };
}

const REPO = "https://github.com/azurebluezone/Lama-Cpp-On-the-Fly.git";

function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/__([A-Z]+)__/g, (match, key: string) => vars[key] ?? match);
}

function example(language: DocLanguage, label: string, template: string, vars: Record<string, string>): DocExample {
  return { language, label, code: fill(template.trim(), vars) };
}

const CHAT_BODY = '{"model":"__ALIAS__","messages":[{"role":"user","content":"Say hello in five words."}],"max_tokens":64}';
const STREAM_BODY = '{"model":"__ALIAS__","messages":[{"role":"user","content":"Count from one to five."}],"max_tokens":64,"stream":true}';
const ANTHROPIC_BODY = '{"model":"__ALIAS__","max_tokens":64,"messages":[{"role":"user","content":"Say hello in five words."}]}';
const TOOL_BODY = `{
  "model": "__ALIAS__",
  "max_tokens": 256,
  "messages": [{"role": "user", "content": "List the files in the workspace using the list_dir tool."}],
  "tools": [{
    "type": "function",
    "function": {
      "name": "list_dir",
      "description": "List entries in a workspace directory.",
      "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "additionalProperties": false}
    }
  }]
}`;

function scenarios(vars: Record<string, string>): DocScenario[] {
  const http = vars.HTTP ?? "";
  const admin = vars.ADMIN ?? "";
  const alias = vars.ALIAS ?? "";
  return [
    {
      id: "nonstream",
      title: "Non-streaming chat",
      summary: "Send one request, wait for the full answer, print choices[0].message.content.",
      notes: [
        "Use this for scripts, tests and anything that cannot consume a stream.",
        "max_tokens caps the answer; omit temperature for the model default.",
        `The alias is ${alias}. Sending the .gguf file name instead returns 400/404.`,
      ],
      examples: [
        example(
          "bash",
          "curl",
          `curl -sS __HTTP__/v1/chat/completions \\
  -H 'content-type: application/json' \\
  -d '${CHAT_BODY}'`,
          vars,
        ),
        example(
          "node",
          "Node.js 18+ (fetch)",
          `const res = await fetch("__HTTP__/v1/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    model: "__ALIAS__",
    messages: [{ role: "user", content: "Say hello in five words." }],
    max_tokens: 64,
  }),
});
if (!res.ok) throw new Error("HTTP " + res.status + ": " + (await res.text()));
const data = await res.json();
console.log(data.choices[0].message.content);`,
          vars,
        ),
        example(
          "python",
          "Python 3 (stdlib only)",
          `import json
import urllib.request

payload = {
    "model": "__ALIAS__",
    "messages": [{"role": "user", "content": "Say hello in five words."}],
    "max_tokens": 64,
}
req = urllib.request.Request(
    "__HTTP__/v1/chat/completions",
    data=json.dumps(payload).encode("utf-8"),
    headers={"content-type": "application/json"},
)
with urllib.request.urlopen(req, timeout=120) as res:
    data = json.load(res)
print(data["choices"][0]["message"]["content"])`,
          vars,
        ),
        example(
          "php",
          "PHP 8 (curl)",
          `<?php
$payload = json_encode([
    "model" => "__ALIAS__",
    "messages" => [["role" => "user", "content" => "Say hello in five words."]],
    "max_tokens" => 64,
]);
$ch = curl_init("__HTTP__/v1/chat/completions");
curl_setopt_array($ch, [
    CURLOPT_POST => true,
    CURLOPT_HTTPHEADER => ["content-type: application/json"],
    CURLOPT_POSTFIELDS => $payload,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT => 120,
]);
$body = curl_exec($ch);
if ($body === false) {
    fwrite(STDERR, curl_error($ch) . PHP_EOL);
    exit(1);
}
$data = json_decode($body, true);
echo $data["choices"][0]["message"]["content"] . PHP_EOL;`,
          vars,
        ),
      ],
    },
    {
      id: "stream",
      title: "Streaming chat",
      summary: "Read server-sent frames as the model writes; the stream ends with data: [DONE].",
      notes: [
        "Send \"stream\": true and keep the connection open (curl -N disables buffering).",
        "Each line is data: {json}; the answer is choices[0].delta.content.",
        "If a proxy buffers responses, streaming degrades to one big chunk — use the UDS or localhost URL.",
      ],
      examples: [
        example(
          "bash",
          "curl",
          `curl -sS -N __HTTP__/v1/chat/completions \\
  -H 'content-type: application/json' \\
  -d '${STREAM_BODY}'`,
          vars,
        ),
        example(
          "node",
          "Node.js 18+ (fetch + reader)",
          `const res = await fetch("__HTTP__/v1/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    model: "__ALIAS__",
    messages: [{ role: "user", content: "Count from one to five." }],
    max_tokens: 64,
    stream: true,
  }),
});
if (!res.ok) throw new Error("HTTP " + res.status + ": " + (await res.text()));

const reader = res.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  const lines = buffer.split("\\n");
  buffer = lines.pop();
  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6).trim();
    if (payload === "[DONE]") continue;
    const chunk = JSON.parse(payload);
    process.stdout.write(chunk.choices?.[0]?.delta?.content ?? "");
  }
}
console.log();`,
          vars,
        ),
        example(
          "python",
          "Python 3 (stdlib only)",
          `import json
import urllib.request

payload = {
    "model": "__ALIAS__",
    "messages": [{"role": "user", "content": "Count from one to five."}],
    "max_tokens": 64,
    "stream": True,
}
req = urllib.request.Request(
    "__HTTP__/v1/chat/completions",
    data=json.dumps(payload).encode("utf-8"),
    headers={"content-type": "application/json"},
)
with urllib.request.urlopen(req, timeout=120) as res:
    for raw in res:
        line = raw.decode("utf-8").strip()
        if not line.startswith("data: "):
            continue
        payload = line[6:]
        if payload == "[DONE]":
            break
        chunk = json.loads(payload)
        delta = chunk["choices"][0].get("delta") or {}
        print(delta.get("content") or "", end="", flush=True)
print()`,
          vars,
        ),
        example(
          "php",
          "PHP 8 (curl write callback)",
          `<?php
$payload = json_encode([
    "model" => "__ALIAS__",
    "messages" => [["role" => "user", "content" => "Count from one to five."]],
    "max_tokens" => 64,
    "stream" => true,
]);
$buffer = "";
$ch = curl_init("__HTTP__/v1/chat/completions");
curl_setopt_array($ch, [
    CURLOPT_POST => true,
    CURLOPT_HTTPHEADER => ["content-type: application/json"],
    CURLOPT_POSTFIELDS => $payload,
    CURLOPT_TIMEOUT => 120,
    CURLOPT_WRITEFUNCTION => function ($ch, $chunk) use (&$buffer) {
        $buffer .= $chunk;
        while (($pos = strpos($buffer, "\\n")) !== false) {
            $line = substr($buffer, 0, $pos);
            $buffer = substr($buffer, $pos + 1);
            if (strpos($line, "data: ") !== 0) {
                continue;
            }
            $raw = trim(substr($line, 6));
            if ($raw === "[DONE]") {
                continue;
            }
            $data = json_decode($raw, true);
            echo $data["choices"][0]["delta"]["content"] ?? "";
        }
        return strlen($chunk);
    },
]);
curl_exec($ch);
echo PHP_EOL;`,
          vars,
        ),
      ],
    },
    {
      id: "anthropic",
      title: "Anthropic Messages",
      summary: "POST /v1/messages returns content blocks; text lives in content[0].text.",
      notes: [
        "System prompts go in the top-level \"system\" field, not in messages.",
        "Add \"stream\": true for named SSE events: message_start, content_block_delta, message_delta, message_stop.",
        "Usage is usage.input_tokens / usage.output_tokens.",
      ],
      examples: [
        example(
          "bash",
          "curl (non-streaming)",
          `curl -sS __HTTP__/v1/messages \\
  -H 'content-type: application/json' \\
  -H 'anthropic-version: 2023-06-01' \\
  -d '${ANTHROPIC_BODY}'`,
          vars,
        ),
        example(
          "node",
          "Node.js 18+ (fetch)",
          `const res = await fetch("__HTTP__/v1/messages", {
  method: "POST",
  headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
  body: JSON.stringify({
    model: "__ALIAS__",
    max_tokens: 64,
    messages: [{ role: "user", content: "Say hello in five words." }],
  }),
});
if (!res.ok) throw new Error("HTTP " + res.status + ": " + (await res.text()));
const data = await res.json();
console.log(data.content.map((block) => block.text ?? "").join(""));`,
          vars,
        ),
        example(
          "python",
          "Python 3 (stdlib only)",
          `import json
import urllib.request

payload = {
    "model": "__ALIAS__",
    "max_tokens": 64,
    "messages": [{"role": "user", "content": "Say hello in five words."}],
}
req = urllib.request.Request(
    "__HTTP__/v1/messages",
    data=json.dumps(payload).encode("utf-8"),
    headers={"content-type": "application/json", "anthropic-version": "2023-06-01"},
)
with urllib.request.urlopen(req, timeout=120) as res:
    data = json.load(res)
print("".join(block.get("text", "") for block in data["content"]))`,
          vars,
        ),
        example(
          "php",
          "PHP 8 (curl)",
          `<?php
$payload = json_encode([
    "model" => "__ALIAS__",
    "max_tokens" => 64,
    "messages" => [["role" => "user", "content" => "Say hello in five words."]],
]);
$ch = curl_init("__HTTP__/v1/messages");
curl_setopt_array($ch, [
    CURLOPT_POST => true,
    CURLOPT_HTTPHEADER => ["content-type: application/json", "anthropic-version: 2023-06-01"],
    CURLOPT_POSTFIELDS => $payload,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT => 120,
]);
$data = json_decode(curl_exec($ch), true);
echo implode("", array_column($data["content"], "text")) . PHP_EOL;`,
          vars,
        ),
      ],
    },
    {
      id: "tools",
      title: "Tool calls",
      summary: "Describe a tool, let the model answer with tool_calls, then execute it yourself.",
      notes: [
        "The model never executes anything. It returns a name + arguments; your code decides.",
        `Execute through the admin so the call is audited and counted: POST ${admin}/api/tools/call with the admin token.`,
        "Some small models write the call as text instead of tool_calls. The lama parser (/api/tools/parse) recovers native, TOOL:/ARGS: and bare-JSON forms.",
      ],
      examples: [
        example(
          "bash",
          "curl: ask the model",
          `curl -sS __HTTP__/v1/chat/completions \\
  -H 'content-type: application/json' \\
  -d '${TOOL_BODY}'`,
          vars,
        ),
        example(
          "node",
          "Node.js: ask + execute",
          `const call = (url, body, token) =>
  fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: "Bearer " + token } : {}),
    },
    body: JSON.stringify(body),
  }).then(async (res) => {
    const data = await res.json();
    if (!res.ok) throw new Error("HTTP " + res.status + ": " + JSON.stringify(data));
    return data;
  });

const completion = await call("__HTTP__/v1/chat/completions", {
  model: "__ALIAS__",
  max_tokens: 256,
  messages: [{ role: "user", content: "List the files in the workspace using the list_dir tool." }],
  tools: [{
    type: "function",
    function: {
      name: "list_dir",
      description: "List entries in a workspace directory.",
      parameters: { type: "object", properties: { path: { type: "string" } } },
    },
  }],
});

const message = completion.choices[0].message;
const toolCall = (message.tool_calls || [])[0];
if (!toolCall) {
  console.log("model answered with text:", message.content);
  process.exit(0);
}
const args = JSON.parse(toolCall.function.arguments || "{}");
// The model may invent a path; this demo always starts at the workspace root.
// Validate args against your own policy before executing anything destructive.
if (toolCall.function.name === "list_dir") args.path = ".";
const executed = await call("__ADMIN__/api/tools/call", {
  name: toolCall.function.name,
  arguments: args,
}, process.env.LAMA_ADMIN_TOKEN);
console.log(JSON.stringify(executed.result, null, 2));`,
          vars,
        ),
        example(
          "python",
          "Python: ask + execute",
          `import json
import os
import urllib.error
import urllib.request

def call(url, body, token=None):
    headers = {"content-type": "application/json"}
    if token:
        headers["authorization"] = "Bearer " + token
    req = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"), headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=120) as res:
            return json.load(res)
    except urllib.error.HTTPError as err:
        raise SystemExit("HTTP %s: %s" % (err.code, err.read().decode("utf-8")))

completion = call("__HTTP__/v1/chat/completions", {
    "model": "__ALIAS__",
    "max_tokens": 256,
    "messages": [{"role": "user", "content": "List the files in the workspace using the list_dir tool."}],
    "tools": [{
        "type": "function",
        "function": {
            "name": "list_dir",
            "description": "List entries in a workspace directory.",
            "parameters": {"type": "object", "properties": {"path": {"type": "string"}}},
        },
    }],
})

message = completion["choices"][0]["message"]
tool_calls = message.get("tool_calls") or []
if not tool_calls:
    print("model answered with text:", message.get("content"))
else:
    call_spec = tool_calls[0]["function"]
    args = json.loads(call_spec.get("arguments") or "{}")
    # The model may invent a path; this demo always starts at the workspace root.
    # Validate args against your own policy before executing anything destructive.
    if call_spec["name"] == "list_dir":
        args["path"] = "."
    executed = call(
        "__ADMIN__/api/tools/call",
        {"name": call_spec["name"], "arguments": args},
        os.environ["LAMA_ADMIN_TOKEN"],
    )
    print(json.dumps(executed["result"], indent=2))`,
          vars,
        ),
        example(
          "php",
          "PHP: ask + execute",
          `<?php
function lama_call(string $url, array $body, ?string $token = null) {
    $ch = curl_init($url);
    $headers = ["content-type: application/json"];
    if ($token !== null) {
        $headers[] = "authorization: Bearer " . $token;
    }
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_POSTFIELDS => json_encode($body),
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 120,
    ]);
    $raw = curl_exec($ch);
    if ($raw === false) {
        throw new RuntimeException(curl_error($ch));
    }
    $status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    if ($status >= 400) {
        throw new RuntimeException("HTTP " . $status . ": " . $raw);
    }
    return json_decode($raw, true);
}

$completion = lama_call("__HTTP__/v1/chat/completions", [
    "model" => "__ALIAS__",
    "max_tokens" => 256,
    "messages" => [["role" => "user", "content" => "List the files in the workspace using the list_dir tool."]],
    "tools" => [[
        "type" => "function",
        "function" => [
            "name" => "list_dir",
            "description" => "List entries in a workspace directory.",
            "parameters" => ["type" => "object", "properties" => ["path" => ["type" => "string"]]],
        ],
    ]],
]);

$message = $completion["choices"][0]["message"];
if (empty($message["tool_calls"])) {
    echo "model answered with text: " . ($message["content"] ?? "") . PHP_EOL;
    exit(0);
}
$call = $message["tool_calls"][0]["function"];
$args = json_decode($call["arguments"] ?: "{}", true);
// The model may invent a path; this demo always starts at the workspace root.
// Validate args against your own policy before executing anything destructive.
if ($call["name"] === "list_dir") {
    $args["path"] = ".";
}
$executed = lama_call("__ADMIN__/api/tools/call", [
    "name" => $call["name"],
    "arguments" => $args,
], getenv("LAMA_ADMIN_TOKEN"));
echo json_encode($executed["result"], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . PHP_EOL;`,
          vars,
        ),
      ],
    },
    {
      id: "shell",
      title: "Shell tool (run_shell)",
      summary: "Run one allow-listed read-only command inside the workspace and read stdout/stderr.",
      notes: [
        "There is no shell: metacharacters, interpreters (sh/bash/python) and write flags are refused.",
        "Allow-list: ls, cat, head, tail, wc, stat, file, du, df, grep, sed (no -i), find (no -exec/-delete), git status/diff/log, and similar read-only commands.",
        "The working directory is the configured workspace. Every call is audited and counted in the MCP matrix.",
      ],
      examples: [
        example(
          "bash",
          "curl",
          `TOKEN=$(grep '^LAMA_ADMIN_TOKEN=' .env | cut -d= -f2)
curl -sS __ADMIN__/api/tools/call \\
  -H "authorization: Bearer $TOKEN" \\
  -H 'content-type: application/json' \\
  -d '{"name":"run_shell","arguments":{"cmd":"ls -la ."}}'`,
          vars,
        ),
        example(
          "node",
          "Node.js 18+",
          `const token = process.env.LAMA_ADMIN_TOKEN;
if (!token) throw new Error("set LAMA_ADMIN_TOKEN in the environment");

const res = await fetch("__ADMIN__/api/tools/call", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: "Bearer " + token },
  body: JSON.stringify({ name: "run_shell", arguments: { cmd: "ls -la ." } }),
});
const data = await res.json();
if (!res.ok) throw new Error("HTTP " + res.status + ": " + JSON.stringify(data));
console.log(data.result.stdout);
if (data.result.stderr) console.error(data.result.stderr);`,
          vars,
        ),
        example(
          "python",
          "Python 3 (stdlib only)",
          `import json
import os
import urllib.request

token = os.environ["LAMA_ADMIN_TOKEN"]
payload = {"name": "run_shell", "arguments": {"cmd": "ls -la ."}}
req = urllib.request.Request(
    "__ADMIN__/api/tools/call",
    data=json.dumps(payload).encode("utf-8"),
    headers={"content-type": "application/json", "authorization": "Bearer " + token},
)
with urllib.request.urlopen(req, timeout=30) as res:
    data = json.load(res)
print(data["result"]["stdout"], end="")
if data["result"]["stderr"]:
    print(data["result"]["stderr"])`,
          vars,
        ),
        example(
          "php",
          "PHP 8 (curl)",
          `<?php
$token = getenv("LAMA_ADMIN_TOKEN");
if ($token === false || $token === "") {
    fwrite(STDERR, "set LAMA_ADMIN_TOKEN in the environment" . PHP_EOL);
    exit(1);
}
$ch = curl_init("__ADMIN__/api/tools/call");
curl_setopt_array($ch, [
    CURLOPT_POST => true,
    CURLOPT_HTTPHEADER => ["content-type: application/json", "authorization: Bearer " . $token],
    CURLOPT_POSTFIELDS => json_encode([
        "name" => "run_shell",
        "arguments" => ["cmd" => "ls -la ."],
    ]),
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT => 30,
]);
$data = json_decode(curl_exec($ch), true);
echo $data["result"]["stdout"];
if (!empty($data["result"]["stderr"])) {
    fwrite(STDERR, $data["result"]["stderr"]);
}`,
          vars,
        ),
      ],
    },
  ];
}

function udsExamples(vars: Record<string, string>): DocExample[] {
  return [
    example(
      "bash",
      "curl",
      `curl -sS -N --unix-socket __UDS__ http://localhost/v1/chat/completions \\
  -H 'content-type: application/json' \\
  -d '${CHAT_BODY}'`,
      vars,
    ),
    example(
      "node",
      "Node.js (http.request)",
      `import http from "node:http";

const body = JSON.stringify({
  model: "__ALIAS__",
  messages: [{ role: "user", content: "Say hello in five words." }],
  max_tokens: 64,
});
const req = http.request({
  socketPath: "__UDS__",
  path: "/v1/chat/completions",
  method: "POST",
  headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
}, (res) => {
  res.setEncoding("utf8");
  res.on("data", (chunk) => process.stdout.write(chunk));
});
req.end(body);`,
      vars,
    ),
    example(
      "python",
      "Python 3 (http.client over AF_UNIX)",
      `import http.client
import json
import socket

class UnixHTTPConnection(http.client.HTTPConnection):
    def __init__(self, socket_path: str):
        super().__init__("localhost")
        self.socket_path = socket_path

    def connect(self):
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.connect(self.socket_path)
        self.sock = sock

conn = UnixHTTPConnection("__UDS__")
payload = {"model": "__ALIAS__", "messages": [{"role": "user", "content": "Say hello in five words."}], "max_tokens": 64}
conn.request("POST", "/v1/chat/completions", body=json.dumps(payload), headers={"content-type": "application/json"})
res = conn.getresponse()
print(res.status)
print(json.load(res)["choices"][0]["message"]["content"])`,
      vars,
    ),
    example(
      "php",
      "PHP 8 (CURLOPT_UNIX_SOCKET_PATH)",
      `<?php
$payload = json_encode([
    "model" => "__ALIAS__",
    "messages" => [["role" => "user", "content" => "Say hello in five words."]],
    "max_tokens" => 64,
]);
$ch = curl_init("http://localhost/v1/chat/completions");
curl_setopt_array($ch, [
    CURLOPT_POST => true,
    CURLOPT_UNIX_SOCKET_PATH => "__UDS__",
    CURLOPT_HTTPHEADER => ["content-type: application/json"],
    CURLOPT_POSTFIELDS => $payload,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT => 120,
]);
$body = curl_exec($ch);
if ($body === false) {
    fwrite(STDERR, curl_error($ch) . PHP_EOL);
    exit(1);
}
echo json_decode($body, true)["choices"][0]["message"]["content"] . PHP_EOL;`,
      vars,
    ),
  ];
}

function installSection(adminUrl: string, engineUrl: string): IntegrationDocs["install"] {
  return {
    title: "Install on Linux by copy-paste",
    intro:
      "Seven blocks, in order. You do not need to know Linux: copy each block into a terminal, press Enter, and wait for it to finish. One sudo password is asked in the first block.",
    steps: [
      {
        title: "1. Install the system tools",
        body: "Ubuntu/Debian command. Fedora users: sudo dnf install -y curl git xz",
        code: "sudo apt update && sudo apt install -y curl git xz-utils",
      },
      {
        title: "2. Install Node.js 24 in your home folder (no sudo)",
        body: "This downloads the official Node.js build into ~/.local; nothing system-wide is touched.",
        code: `case "$(uname -m)" in x86_64) NODE_ARCH=x64;; aarch64|arm64) NODE_ARCH=arm64;; *) echo "Unsupported CPU"; exit 1;; esac
NODE_FILE=$(curl -fsSL https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt | grep -o "node-v24[0-9.]*-linux-$NODE_ARCH.tar.xz" | head -1)
mkdir -p "$HOME/.local"
curl -fsSL "https://nodejs.org/dist/latest-v24.x/$NODE_FILE" -o /tmp/node.tar.xz
tar -xJf /tmp/node.tar.xz -C "$HOME/.local"
ln -sfn "$HOME/.local/\${NODE_FILE%.tar.xz}" "$HOME/.local/node"
touch "$HOME/.bashrc"
grep -q '.local/node/bin' "$HOME/.bashrc" || echo 'export PATH="$HOME/.local/node/bin:$HOME/.local/bin:$PATH"' >> "$HOME/.bashrc"
export PATH="$HOME/.local/node/bin:$HOME/.local/bin:$PATH"
node -v`,
      },
      {
        title: "3. Download lama",
        body: "Clones the project into ~/lama and installs its two development tools (TypeScript, Node types).",
        code: `git clone ${REPO} "$HOME/lama"
cd "$HOME/lama"
npm install`,
      },
      {
        title: "4. Download the stock llama.cpp engine",
        body: "Fetches the official release, verifies its checksum and links it inside the project.",
        code: `npm run install:llama`,
      },
      {
        title: "5. Create the token, database and services",
        body: "The last line prints your admin token. Copy it somewhere safe; it is the only password.",
        code: `npm run setup
node src/main.ts service install user
node src/main.ts service install user --gateway
grep '^LAMA_ADMIN_TOKEN=' .env`,
      },
      {
        title: "6. Download a small test model",
        body: "About 470 MB. It lands in ~/lama/models so the admin can find it automatically.",
        code: `cd "$HOME/lama"
mkdir -p models
curl -L --fail -o "models/Qwen2.5-0.5B-Instruct-Q4_K_M.gguf" \\
  "https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf"`,
      },
      {
        title: "7. Register it, load it, check it",
        body: `Open ${adminUrl}/admin in a browser and paste the token from .env. Model List → Register model → pick the file under DISCOVERED GGUF → fill MODEL ID (API ALIAS) with a short name such as qwen2.5-0.5b → Register, then press Load on the card. Wait until the card says running, then these two commands must answer 200 and list your alias:`,
        code: `cd "$HOME/lama"
curl -s ${adminUrl}/healthz
curl -s ${engineUrl}/v1/models`,
      },
    ],
    finish:
      "That is the whole install. The gateway (API + admin) keeps running after logout only if you run: loginctl enable-linger \"$USER\". To update later: cd ~/lama && git pull && npm install && npm run check && systemctl --user restart lama-gateway lama-engine.",
  };
}

export function buildIntegrationDocs(store: Store, cfg: Config, modelAlias: string): IntegrationDocs {
  void store;
  const http = cfg.engineUrl;
  const gateway = `http://${cfg.gatewayHost}:${cfg.gatewayPort}`;
  const uds = cfg.udsPath || null;
  const vars: Record<string, string> = { HTTP: http, ADMIN: gateway, UDS: uds ?? "", ALIAS: modelAlias };
  return {
    generated_at: new Date().toISOString(),
    model_alias: modelAlias,
    gateway_url: gateway,
    engine_url: http,
    uds_path: uds,
    languages: [
      { id: "bash", label: "curl / bash" },
      { id: "node", label: "Node.js" },
      { id: "python", label: "Python" },
      { id: "php", label: "PHP" },
    ],
    scenarios: scenarios(vars),
    uds: {
      summary:
        "The same requests work over the unix socket. Replace the URL with the socket; no port and no TLS are involved.",
      examples: udsExamples(vars),
    },
    install: installSection(gateway, http),
  };
}

export function integrationToMarkdown(docs: IntegrationDocs): string {
  const lines: string[] = [
    "# lama integration guide",
    "",
    `Generated: ${docs.generated_at}  `,
    `Engine: \`${docs.engine_url}\`  `,
    `Gateway: \`${docs.gateway_url}\`  `,
    `UDS: \`${docs.uds_path ?? "disabled"}\`  `,
    `Model alias: \`${docs.model_alias}\``,
    "",
    "## Linux install (copy-paste)",
    "",
    docs.install.intro,
    "",
  ];
  for (const step of docs.install.steps) {
    lines.push(`### ${step.title}`, "", step.body, "");
    if (step.code) lines.push("```bash", step.code, "```", "");
  }
  lines.push(docs.install.finish, "");
  for (const scenario of docs.scenarios) {
    lines.push(`## ${scenario.title}`, "", scenario.summary, "");
    for (const note of scenario.notes) lines.push(`- ${note}`);
    lines.push("");
    for (const exampleItem of scenario.examples) {
      lines.push(`### ${exampleItem.label}`, "", `\`\`\`${languageFence(exampleItem.language)}`, exampleItem.code, "```", "");
    }
  }
  lines.push("## Unix socket", "", docs.uds.summary, "");
  for (const exampleItem of docs.uds.examples) {
    lines.push(`### ${exampleItem.label}`, "", `\`\`\`${languageFence(exampleItem.language)}`, exampleItem.code, "```", "");
  }
  return `${lines.join("\n")}\n`;
}

function languageFence(language: DocLanguage): string {
  if (language === "bash") return "bash";
  if (language === "node") return "javascript";
  if (language === "python") return "python";
  return "php";
}
