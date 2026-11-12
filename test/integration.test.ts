import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Store, seedStore } from "../src/db.ts";
import { buildIntegrationDocs, integrationToMarkdown } from "../src/integration.ts";
import { testConfig, testOs } from "./helpers.ts";

/**
 * The Docs view renders these blocks verbatim, so the contract is: every language is present,
 * every block points at the live endpoint/alias, no placeholder survives, and the admin token
 * never appears in the payload or the Markdown export.
 */
function seeded(): { store: Store; cfg: ReturnType<typeof testConfig> } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lama-integration-"));
  const cfg = testConfig(root);
  const store = new Store(cfg.dbFile);
  seedStore(store, cfg, testOs());
  return { store, cfg };
}

test("integration docs cover every scenario in all four languages", () => {
  const { store, cfg } = seeded();
  const docs = buildIntegrationDocs(store, cfg, "tiny-model");

  assert.equal(docs.model_alias, "tiny-model");
  assert.equal(docs.engine_url, cfg.engineUrl);
  assert.equal(docs.uds_path, cfg.udsPath);
  assert.deepEqual(
    docs.scenarios.map((scenario) => scenario.id),
    ["nonstream", "stream", "anthropic", "tools", "shell"],
  );
  for (const scenario of docs.scenarios) {
    assert.ok(scenario.title && scenario.summary && scenario.notes.length > 0, `${scenario.id} metadata`);
    assert.deepEqual(
      scenario.examples.map((example) => example.language).sort(),
      ["bash", "node", "php", "python"],
      `${scenario.id} languages`,
    );
    for (const example of scenario.examples) {
      assert.ok(example.code.length > 80, `${scenario.id}/${example.language} code`);
      assert.ok(!example.code.includes("__"), `${scenario.id}/${example.language} placeholder left`);
      assert.match(example.code, /\b(tiny-model|127\.0\.0\.1|unix-socket|AF_UNIX)\b/, `${scenario.id}/${example.language} target`);
    }
  }
});

test("tool scenarios explain asking and executing, and the shell example is allow-listed", () => {
  const { store, cfg } = seeded();
  const docs = buildIntegrationDocs(store, cfg, "tiny-model");
  const tools = docs.scenarios.find((scenario) => scenario.id === "tools");
  const shell = docs.scenarios.find((scenario) => scenario.id === "shell");
  assert.ok(tools && shell);

  assert.ok(tools.notes.some((note) => note.includes("/api/tools/parse")));
  assert.ok(tools.notes.some((note) => note.includes("/api/tools/call")));
  for (const example of tools.examples.filter((row) => row.language !== "bash")) {
    assert.match(example.code, /tool_calls/);
    assert.match(example.code, /api\/tools\/call/);
    assert.match(example.code, /LAMA_ADMIN_TOKEN/);
  }

  assert.match(shell.summary, /read-only/);
  assert.ok(shell.notes.some((note) => note.includes("Allow-list")));
  for (const example of shell.examples) {
    assert.match(example.code, /run_shell/);
    assert.match(example.code, /ls -la/);
    assert.ok(!/sh -c|bash -c/.test(example.code), "no shell wrapper in the example");
  }
});

test("UDS examples use the configured socket and no TCP port", () => {
  const { store, cfg } = seeded();
  const docs = buildIntegrationDocs(store, cfg, "tiny-model");
  assert.equal(docs.uds.examples.length, 4);
  for (const example of docs.uds.examples) {
    if (example.language === "node") assert.match(example.code, /socketPath/);
    if (example.language === "python") assert.match(example.code, /AF_UNIX/);
    if (example.language === "php") assert.match(example.code, /CURLOPT_UNIX_SOCKET_PATH/);
    if (example.language === "bash") assert.match(example.code, /--unix-socket/);
    assert.ok(example.code.includes(cfg.udsPath), `${example.language} socket path`);
    assert.ok(!example.code.includes(`127.0.0.1:${cfg.enginePort}`), `${example.language} must not use TCP`);
  }
});

test("install walkthrough is ordered, copy-pasteable and never prints the token", () => {
  const { store, cfg } = seeded();
  const docs = buildIntegrationDocs(store, cfg, "tiny-model");
  assert.ok(docs.install.steps.length >= 5);
  for (const step of docs.install.steps) {
    assert.match(step.title, /^\d\./);
    assert.ok(step.body.length > 10);
  }
  const clone = docs.install.steps.find((step) => step.code?.includes("git clone"));
  assert.ok(clone?.code?.includes("Lama-Cpp-On-the-Fly"));
  const setup = docs.install.steps.find((step) => step.code?.includes("npm run setup"));
  assert.ok(setup?.code?.includes("grep '^LAMA_ADMIN_TOKEN=' .env"));
  // one unit per install run: the engine unit must be installed too, or
  // `systemctl --user restart lama-gateway lama-engine` fails with "Unit not found".
  assert.ok(setup?.code?.includes("service install user\n"), "engine unit install line");
  assert.ok(setup?.code?.includes("service install user --gateway"), "gateway unit install line");
  assert.ok(docs.install.intro.includes("copy"));
  assert.ok(docs.install.finish.includes("loginctl"));

  const markdown = integrationToMarkdown(docs);
  for (const heading of ["# lama integration guide", "## Linux install (copy-paste)", "## Streaming chat", "## Unix socket"]) {
    assert.ok(markdown.includes(heading), heading);
  }
  assert.match(markdown, /```php/);
  assert.match(markdown, /```python/);
  assert.ok(!markdown.includes(cfg.adminToken), "admin token must never be written into docs");
  assert.ok(!markdown.includes("__HTTP__"), "no placeholder in markdown");
});
