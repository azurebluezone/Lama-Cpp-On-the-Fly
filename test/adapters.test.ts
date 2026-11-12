import assert from "node:assert/strict";
import test from "node:test";
import { ADAPTERS, buildAdapterConfig, detectAdapter } from "../src/adapters/registry.ts";

/**
 * The adapter layer is a config generator, not a proxy. These tests pin the
 * two things a client actually depends on: the endpoint/protocol in the file
 * and the attribution header the gateway reads back.
 */
test("every adapter emits a real endpoint, model and attribution header", () => {
  for (const adapter of ADAPTERS) {
    const config = buildAdapterConfig(adapter.id, {
      baseUrl: "https://lama.example/",
      model: "qwen2.5-0.5b",
      token: "secret-token",
    });
    assert.equal(config.headers["x-lama-client"], adapter.client_header, `${adapter.id} attribution header`);
    assert.ok(config.files.length >= 1, `${adapter.id} must produce at least one file`);
    const content = config.files[0]!.content;
    if (adapter.id === "opencode") {
      assert.ok(!content.includes("secret-token"), "OpenCode config must not embed the admin token");
    } else {
      assert.ok(content.includes("secret-token"), `${adapter.id} must include the token`);
    }
    assert.ok(content.includes("qwen2.5-0.5b"), `${adapter.id} must include the model`);
    assert.ok(content.includes(config.base_url), `${adapter.id} must include its base URL`);
    assert.ok(content.includes("lama.example"), `${adapter.id} must not keep a placeholder host`);
  }
});

test("OpenCode adapter emits the V2 providers block and drops the legacy V1 keys", () => {
  const config = buildAdapterConfig("opencode", {
    baseUrl: "http://127.0.0.1:5252",
    model: "e2e-qwen",
    token: "secret-token",
  });
  const file = JSON.parse(config.files[0]!.content) as {
    provider?: unknown;
    providers?: Record<
      string,
      {
        package?: string;
        settings?: { baseURL?: string };
        headers?: Record<string, string>;
        models?: Record<string, { modelID?: string }>;
      }
    >;
  };
  assert.equal(file.provider, undefined, "V1 provider key must be absent");
  assert.equal(file.providers?.lama?.package, "@opencode/ai/providers/openai-compatible");
  assert.equal(file.providers?.lama?.settings?.baseURL, "http://127.0.0.1:5252/v1");
  assert.equal(file.providers?.lama?.headers?.["x-lama-client"], "opencode");
  assert.equal(file.providers?.lama?.models?.["e2e-qwen"]?.modelID, "e2e-qwen");
});

test("OpenAI adapters add /v1 once; Anthropic keeps the root", () => {
  const openai = buildAdapterConfig("opencode", { baseUrl: "http://127.0.0.1:5252", model: "m", token: "t" });
  assert.equal(openai.base_url, "http://127.0.0.1:5252/v1");
  const already = buildAdapterConfig("vscode", { baseUrl: "http://127.0.0.1:5252/v1/", model: "m", token: "t" });
  assert.equal(already.base_url, "http://127.0.0.1:5252/v1");
  const anthropic = buildAdapterConfig("claude-code", { baseUrl: "http://127.0.0.1:5252", model: "m", token: "t" });
  assert.equal(anthropic.base_url, "http://127.0.0.1:5252");
  assert.match(anthropic.files[0]!.content, /^ANTHROPIC_BASE_URL=http:\/\/127\.0\.0\.1:5252$/m);
});

test("detectAdapter prefers the explicit header and never invents a known id", () => {
  assert.equal(detectAdapter("OpenCode", "curl/8"), "opencode");
  assert.equal(detectAdapter("", "Mozilla/5.0 (compatible; Claude-Code/1.0)"), "claude-code");
  assert.equal(detectAdapter("", "curl/8.5.0"), "curl");
  assert.equal(detectAdapter("", ""), "unknown");
  assert.equal(detectAdapter("", "SomeBot/1.0"), "other");
});

test("an unknown adapter fails loudly instead of emitting a placeholder config", () => {
  assert.throws(
    () => buildAdapterConfig("nope", { baseUrl: "http://127.0.0.1:5252", model: "m", token: "" }),
    /unknown adapter/,
  );
});
