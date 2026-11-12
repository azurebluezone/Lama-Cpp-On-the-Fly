import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Config } from "./config.ts";
import type { Store } from "./db.ts";
import type { PromptRow } from "./types.ts";
import { loadIdentity, type SystemIdentity } from "./identity.ts";

/**
 * The system prompt is authored in the repository, seeded into SQLite, and editable from the
 * admin. The engine itself never stores a prompt — llama.cpp has no "default system prompt"
 * setting — so every client must send it as the first `system` message. This module keeps
 * the file, the DB row and the metadata (`edited`, `source_sha`) consistent.
 */
export const PROMPT_ID = "system";
export const PROMPT_FILE = "prompts/lama-system.md";

export function promptFile(cfg: Config): string {
  return path.join(cfg.root, PROMPT_FILE);
}

export function readPromptFile(cfg: Config): { file: string; content: string; sha: string } | null {
  const file = promptFile(cfg);
  try {
    const content = fs.readFileSync(file, "utf8");
    return { file, content, sha: createHash("sha256").update(content).digest("hex") };
  } catch {
    return null;
  }
}

function metadata(prompt: PromptRow | undefined): Record<string, unknown> {
  if (!prompt) return {};
  try {
    const parsed: unknown = JSON.parse(prompt.metadata_json || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The sha of the text that is stored, which the file sha cannot be. */
function contentSha(prompt: PromptRow | undefined): string | null {
  if (!prompt) return null;
  const meta = metadata(prompt);
  if (typeof meta.content_sha === "string" && meta.content_sha) return meta.content_sha;
  return createHash("sha256").update(prompt.content).digest("hex");
}

export interface PromptState {
  prompt: PromptRow | undefined;
  action: "missing-file" | "created" | "updated" | "unchanged" | "kept-edits";
  file: string | null;
  /** sha256 of the repo file, for provenance. */
  source_sha: string | null;
  /** sha256 of the text actually stored (file plus the enforced identity). */
  content_sha: string | null;
  edited: boolean;
}

/**
 * The identity block the system prompt must contain. A model that reads the
 * prompt cannot be talked into a different owner, so the name, the protocol
 * and the owner are enforced here rather than trusted to the file author.
 */
export function identityBlock(identity: SystemIdentity): string {
  return [
    "## Identity",
    "",
    `- System: \`${identity.name}\` (Lama-Cpp-On-the-Fly)`,
    `- Protocol: \`${identity.protocol}\``,
    `- Owner: ${identity.branding.owner}, ${identity.branding.organization}`,
  ].join("\n");
}

/**
 * Rewrite the identity block of a prompt so it always matches the manifest.
 * The rest of the prompt is left untouched: the admin may edit the rules.
 */
export function enforceIdentity(content: string, identity: SystemIdentity): string {
  const block = identityBlock(identity);
  const pattern = /^## Identity\n\n(?:- .*\n?)+/m;
  if (pattern.test(content)) return content.replace(pattern, `${block}\n`);
  return `${content.replace(/\s+$/, "")}\n\n${block}\n`;
}

export function syncSystemPrompt(store: Store, cfg: Config): PromptState {
  const file = readPromptFile(cfg);
  const identity = loadIdentity(cfg.root);
  // One prompt, every model. Older installs seeded a second default row (id "default");
  // drop it whenever the authoritative file is present so `defaultPrompt()` cannot pick
  // a different text than the one the admin shows.
  if (file) {
    const stale = store.listPrompts().filter((row) => row.is_default === 1 && row.id !== PROMPT_ID);
    for (const row of stale) store.deletePrompt(row.id);
    if (stale.length) {
      store.audit("prompt.prune", stale.map((row) => row.id).join(","), `kept only ${PROMPT_ID}`, "boot");
    }
  }
  if (!file) {
    const existing = store.getPrompt(PROMPT_ID);
    return {
      prompt: existing,
      action: "missing-file",
      file: null,
      source_sha: existing ? String(metadata(existing).source_sha ?? "") || null : null,
      content_sha: contentSha(existing),
      edited: Boolean(metadata(existing).edited),
    };
  }
  const existing = store.getPrompt(PROMPT_ID);
  const meta = metadata(existing);
  const edited = meta.edited === true;
  if (existing && edited) {
    return {
      prompt: existing,
      action: "kept-edits",
      file: file.file,
      source_sha: (meta.source_sha as string) ?? null,
      content_sha: contentSha(existing),
      edited,
    };
  }
  const content = enforceIdentity(file.content.trim(), identity);
  const sha = createHash("sha256").update(content).digest("hex");
  // The row is up to date when the stored text already is the enforced file
  // text. The identity block is part of that text, so a version bump in the
  // manifest refreshes the prompt as well.
  if (existing && contentSha(existing) === sha) {
    return {
      prompt: existing,
      action: "unchanged",
      file: file.file,
      source_sha: file.sha,
      content_sha: sha,
      edited,
    };
  }
  store.upsertPrompt({
    id: PROMPT_ID,
    name: PROMPT_ID,
    content,
    version: existing?.version ?? 1,
    is_default: 1,
    metadata_json: JSON.stringify({
      source: PROMPT_FILE,
      source_sha: file.sha,
      content_sha: sha,
      edited: false,
    }),
  });
  return {
    prompt: store.getPrompt(PROMPT_ID),
    action: existing ? "updated" : "created",
    file: file.file,
    source_sha: file.sha,
    content_sha: sha,
    edited: false,
  };
}

export function resetSystemPrompt(store: Store, cfg: Config): PromptState {
  const file = readPromptFile(cfg);
  const existing = store.getPrompt(PROMPT_ID);
  if (!file) {
    return {
      prompt: existing,
      action: "missing-file",
      file: null,
      source_sha: existing ? String(metadata(existing).source_sha ?? "") || null : null,
      content_sha: contentSha(existing),
      edited: Boolean(metadata(existing).edited),
    };
  }
  const identity = loadIdentity(cfg.root);
  const content = enforceIdentity(file.content.trim(), identity);
  const sha = createHash("sha256").update(content).digest("hex");
  store.upsertPrompt({
    id: PROMPT_ID,
    name: PROMPT_ID,
    content,
    version: existing?.version ?? 1,
    is_default: 1,
    metadata_json: JSON.stringify({
      source: PROMPT_FILE,
      source_sha: file.sha,
      content_sha: sha,
      edited: false,
    }),
  });
  return {
    prompt: store.getPrompt(PROMPT_ID),
    action: "updated",
    file: file.file,
    source_sha: file.sha,
    content_sha: sha,
    edited: false,
  };
}

/**
 * Save an admin edit. The identity block is re-applied on top of the edited
 * text, so an edit can change the rules but never the owner.
 */
export function saveSystemPrompt(store: Store, content: string, identity?: SystemIdentity): PromptRow {
  const enforced = identity ? enforceIdentity(content, identity) : content;
  const sha = createHash("sha256").update(enforced).digest("hex");
  const previous = metadata(store.getPrompt(PROMPT_ID));
  store.upsertPrompt({
    id: PROMPT_ID,
    name: PROMPT_ID,
    content: enforced,
    version: store.getPrompt(PROMPT_ID)?.version ?? 1,
    is_default: 1,
    metadata_json: JSON.stringify({
      source: (previous.source as string) ?? PROMPT_FILE,
      source_sha: (previous.source_sha as string) ?? "",
      content_sha: sha,
      edited: true,
    }),
  });
  return store.getPrompt(PROMPT_ID)!;
}

export function promptMeta(prompt: PromptRow | undefined, cfg: Config): Record<string, unknown> {
  if (!prompt) return { id: PROMPT_ID, exists: false, file: promptFile(cfg) };
  const meta = metadata(prompt);
  return {
    id: prompt.id,
    name: prompt.name,
    version: prompt.version,
    is_default: Boolean(prompt.is_default),
    edited: meta.edited === true,
    source: meta.source ?? null,
    source_sha: meta.source_sha ?? null,
    file: promptFile(cfg),
    content_chars: prompt.content.length,
    updated_at: prompt.updated_at,
  };
}

/**
 * How a caller is expected to use the prompt. This is documentation returned by the API so
 * a third-party integration does not have to guess; it deliberately contains no secret.
 */
export const PROMPT_USAGE = {
  summary:
    "llama.cpp stores no system prompt. The manager authors and versions this text, and the caller must send it as the first `system` message of every conversation.",
  fetch: "GET /api/system-prompt.txt (Bearer LAMA_ADMIN_TOKEN) returns the current text as text/markdown.",
  openai: "Send {\"role\":\"system\",\"content\":\"<prompt>\"} as messages[0] to POST /v1/chat/completions.",
  anthropic: "Send the prompt in the top-level \"system\" field of POST /v1/messages.",
  playground: "The Playground injects the managed prompt by default and records the run in Prompts.",
  editable: "PUT /api/system-prompt with {content} creates a new version and marks the row as edited, so a restart will not overwrite it.",
};
