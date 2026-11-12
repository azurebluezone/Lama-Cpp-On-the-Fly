import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildEngineArgs, chatTemplateResolved } from "../src/engine.ts";
import { grammarFileFor, grammarSourceFor, materializeGrammar } from "../src/grammar.ts";
import type { Config } from "../src/config.ts";
import type { ModelRow } from "../src/types.ts";
import { testConfig } from "./helpers.ts";

/** A model row plus a config that points at a fake binary and a fake gguf file. */
function fixture(metadata: Record<string, unknown>, id = "m1"): { cfg: Config; model: ModelRow } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lama-grammar-"));
  const cfg = testConfig(root);
  const file = path.join(root, "model.gguf");
  fs.writeFileSync(file, "not a real model");
  const binary = path.join(root, "llama");
  fs.writeFileSync(binary, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  cfg.llamaBin = binary;
  const model: ModelRow = {
    id,
    provider_id: "llamacpp",
    name: id,
    model_id: id,
    path: file,
    context: 2048,
    max_tokens: 128,
    temperature: 0.7,
    quant: null,
    load_mode: "auto",
    ttl_hours: 1,
    enabled: 1,
    metadata_json: JSON.stringify(metadata),
    created_at: "",
    updated_at: "",
  };
  return { cfg, model };
}

test("materializeGrammar writes the exact GBNF text to the data dir", () => {
  const { cfg, model } = fixture({ grammar: 'root ::= "yes"\n' });
  const target = materializeGrammar(cfg, model);
  assert.ok(target, "a model with a grammar must produce a grammar file");
  assert.equal(target, path.join(cfg.dataDir, "grammars", "m1.gbnf"));
  assert.equal(fs.readFileSync(target, "utf8"), 'root ::= "yes"\n');
  assert.equal(fs.statSync(target).mode & 0o777, 0o600, "the materialized grammar is owner-only");
});

test("materializeGrammar resolves a grammar_file relative to the project root", () => {
  const { cfg, model } = fixture({ grammar_file: "grammars/answer-only.gbnf" });
  fs.mkdirSync(path.join(cfg.root, "grammars"), { recursive: true });
  const source = "root ::= [a-z]+\n";
  fs.writeFileSync(path.join(cfg.root, "grammars", "answer-only.gbnf"), source);
  const target = materializeGrammar(cfg, model);
  assert.ok(target);
  assert.equal(fs.readFileSync(target, "utf8"), source);
});

test("grammarSourceFor reports the inline and the file declaration", () => {
  const { model } = fixture({ grammar: 'root ::= "yes"\n' });
  assert.deepEqual(grammarSourceFor(model), { inline: 'root ::= "yes"\n', file: null });
  const plain = fixture({});
  assert.deepEqual(grammarSourceFor(plain.model), { inline: null, file: null });
});

test("a GBNF without a root rule fails loudly and names the model", () => {
  const { cfg, model } = fixture({ grammar: 'value ::= "yes"\n' }, "broken-model");
  assert.throws(
    () => materializeGrammar(cfg, model),
    (error: Error) => {
      assert.match(error.message, /broken-model/);
      assert.match(error.message, /root/);
      return true;
    },
  );
  // A rejected grammar must not leave a file behind for the engine to load.
  assert.equal(fs.existsSync(path.join(cfg.dataDir, "grammars", "broken-model.gbnf")), false);
});

test("a missing grammar file fails loudly and names the model", () => {
  const { cfg, model } = fixture({ grammar_file: "grammars/missing.gbnf" }, "missing-grammar");
  assert.throws(
    () => materializeGrammar(cfg, model),
    (error: Error) => {
      assert.match(error.message, /missing-grammar/);
      assert.match(error.message, /not found/);
      return true;
    },
  );
});

test("grammarFileFor returns null for a model without a grammar", () => {
  const { cfg, model } = fixture({});
  assert.equal(grammarFileFor(cfg, model), null);
  assert.equal(materializeGrammar(cfg, model), null);
});

test("buildEngineArgs adds --grammar-file only for a model with a grammar", () => {
  const { cfg, model } = fixture({ grammar: 'root ::= "yes"\n' });
  const built = buildEngineArgs(cfg, model);
  const index = built.args.indexOf("--grammar-file");
  assert.ok(index >= 0, "a model with a grammar must be constrained by llama.cpp");
  assert.equal(built.args[index + 1], path.join(cfg.dataDir, "grammars", "m1.gbnf"));

  const plain = fixture({});
  const unconstrained = buildEngineArgs(plain.cfg, plain.model);
  assert.equal(unconstrained.args.includes("--grammar-file"), false);
});

test("buildEngineArgs never emits --chat-template-file", () => {
  const { cfg, model } = fixture({ chat_template: "templates/qwen3-chat.jinja" });
  const built = buildEngineArgs(cfg, model);
  assert.equal(built.args.includes("--chat-template-file"), false);
});

test("buildEngineArgs pins a built-in chat template alias only when the metadata asks for it", () => {
  const { cfg, model } = fixture({ chat_template_builtin: "chatml" });
  const built = buildEngineArgs(cfg, model);
  assert.equal(built.args[built.args.indexOf("--chat-template") + 1], "chatml");

  const plain = fixture({});
  const unpinned = buildEngineArgs(plain.cfg, plain.model);
  assert.equal(unpinned.args.includes("--chat-template"), false, "the model's own metadata template stays in charge");
});

test("chatTemplateResolved flags an alias llama.cpp did not resolve", () => {
  const literal = chatTemplateResolved({ chat_template: "deepseek2" }, "deepseek2");
  assert.equal(literal.ok, true);
  assert.equal(literal.literal, true);
  assert.equal(literal.resolved, "deepseek2");
});

test("chatTemplateResolved accepts a real template", () => {
  const template = "{% for m in messages %}{{ m.content }}{% endfor %}";
  const resolved = chatTemplateResolved({ chat_template: template }, "chatml");
  assert.equal(resolved.ok, true);
  assert.equal(resolved.literal, false);
  assert.equal(resolved.resolved, template);
});

test("chatTemplateResolved reports a missing or empty template", () => {
  assert.equal(chatTemplateResolved({}, "chatml").ok, false);
  assert.equal(chatTemplateResolved({}, "chatml").resolved, null);
  assert.equal(chatTemplateResolved({ chat_template: "" }, "chatml").ok, false);
  assert.equal(chatTemplateResolved({ chat_template: "   " }, "chatml").ok, false);
});

test("the shipped grammars define a root rule and stay readable", () => {
  for (const name of ["json-object.gbnf", "answer-only.gbnf"]) {
    const file = path.resolve("grammars", name);
    assert.equal(fs.existsSync(file), true, `${name} must ship`);
    const text = fs.readFileSync(file, "utf8");
    assert.match(text, /^root\b/m, `${name} must define a root rule`);
    assert.equal(fs.statSync(file).mode & 0o777, 0o644, `${name} must stay readable`);
  }
});
