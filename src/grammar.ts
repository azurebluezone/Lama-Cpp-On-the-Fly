import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.ts";
import type { ModelRow } from "./types.ts";

/**
 * Native GBNF grammar support.
 *
 * llama.cpp can enforce a grammar at the weight level (`--grammar-file`), so the
 * constraint applies to every generation of that model without touching a single
 * request body. A model opts in through its own metadata:
 *
 *   metadata_json.grammar      inline GBNF text
 *   metadata_json.grammar_file  path of a GBNF file, relative to the project root
 *
 * The materialized copy under <dataDir>/grammars is what the engine is pointed at:
 * the engine only reads a file, and the operator-facing source stays untouched.
 */

export interface GrammarSource {
  /** Inline GBNF text declared in the model metadata. */
  inline: string | null;
  /** GBNF file path declared in the model metadata, relative to the project root. */
  file: string | null;
}

function metaOf(model: ModelRow): Record<string, unknown> {
  try {
    const parsed = JSON.parse(model.metadata_json) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Read the grammar declaration of a model row. */
export function grammarSourceFor(model: ModelRow): GrammarSource {
  const meta = metaOf(model);
  const inline = typeof meta.grammar === "string" && meta.grammar.trim() ? meta.grammar : null;
  const file = typeof meta.grammar_file === "string" && meta.grammar_file.trim() ? meta.grammar_file.trim() : null;
  return { inline, file };
}

/** A GBNF grammar without a `root` rule is rejected by llama.cpp at load time. */
export function hasRootRule(source: string): boolean {
  return source.split(/\r?\n/).some((line) => /^\s*root\b/.test(line));
}

/**
 * Resolve the grammar text of a model row.
 * Inline text wins over a file reference: it is the more specific declaration.
 */
function resolveSource(cfg: Config, model: ModelRow): { text: string; origin: string } | null {
  const { inline, file } = grammarSourceFor(model);
  if (inline) return { text: inline, origin: "metadata.grammar" };
  if (!file) return null;
  const resolved = path.isAbsolute(file) ? file : path.join(cfg.root, file);
  if (!fs.existsSync(resolved)) {
    throw new Error(`model ${model.id}: grammar file not found: ${resolved}`);
  }
  return { text: fs.readFileSync(resolved, "utf8"), origin: resolved };
}

/**
 * Write the model's grammar to <dataDir>/grammars/<model id>.gbnf (mode 0600) and
 * return the path, or null when the model declares no grammar.
 * The GBNF is validated before anything is written, so a broken grammar never
 * leaves a half-written file behind for the engine to load.
 */
export function materializeGrammar(cfg: Config, model: ModelRow): string | null {
  const source = resolveSource(cfg, model);
  if (!source) return null;
  if (!hasRootRule(source.text)) {
    throw new Error(
      `model ${model.id}: grammar from ${source.origin} has no "root" rule (GBNF requires a root rule)`,
    );
  }
  const dir = path.join(cfg.dataDir, "grammars");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = path.join(dir, `${model.id}.gbnf`);
  // Write to a temporary file and rename: the engine must never see a partial grammar.
  const tmp = path.join(dir, `.${model.id}.gbnf.tmp`);
  fs.writeFileSync(tmp, source.text, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, target);
  return target;
}

/** Convenience wrapper: the grammar file the engine must be started with. */
export function grammarFileFor(cfg: Config, model: ModelRow): string | null {
  return materializeGrammar(cfg, model);
}
