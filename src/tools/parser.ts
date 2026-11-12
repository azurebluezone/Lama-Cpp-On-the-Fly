import type { ParseResult, ToolCall } from "../types.ts";

const KNOWN_ARGUMENTS: Record<string, string[]> = {
  read_file: ["path"],
  write_file: ["path", "content"],
  run_shell: ["cmd", "command"],
  http_fetch: ["url", "method", "headers", "body"],
  list_dir: ["path"],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function looksLikeSchemaEcho(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.type === "function" && isRecord(value.function)) {
    const fn = value.function;
    return typeof fn.name === "string" && isRecord(fn.parameters) && !("arguments" in value);
  }
  if (typeof value.name === "string" && isRecord(value.parameters) && !("arguments" in value)) return true;
  return false;
}

function normalizeArguments(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return isRecord(value) ? value : null;
}

function candidate(value: unknown, source: ToolCall["source"]): ToolCall | null {
  if (!isRecord(value) || looksLikeSchemaEcho(value)) return null;
  const name = typeof value.name === "string" ? value.name : null;
  if (!name) return null;
  const args = normalizeArguments(value.arguments ?? value.parameters ?? value.input);
  if (!args) return null;
  return { name, arguments: args, source };
}

export function parseNativeToolCalls(raw: unknown): ToolCall[] {
  if (!Array.isArray(raw)) return [];
  const calls: ToolCall[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    if (isRecord(item.function)) {
      const fn = item.function;
      const name = typeof fn.name === "string" ? fn.name : null;
      const args = normalizeArguments(fn.arguments);
      if (name && args && !looksLikeSchemaEcho(item)) calls.push({ name, arguments: args, source: "native" });
      continue;
    }
    const direct = candidate(item, "native");
    if (direct) calls.push(direct);
  }
  return calls;
}

export function extractJsonCandidates(text: string): unknown[] {
  const out: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === "}") {
      if (depth > 0) depth -= 1;
      if (depth === 0 && start >= 0) {
        const slice = text.slice(start, i + 1);
        try {
          out.push(JSON.parse(slice));
        } catch {
          // Not JSON; keep scanning. A malformed block is not a tool call.
        }
        start = -1;
      }
    }
  }
  return out;
}

export function parseMarkerCalls(text: string): ToolCall[] {
  const calls: ToolCall[] = [];
  const marker = /TOOL\s*:\s*([A-Za-z_][A-Za-z0-9_]*)\s*\r?\n([\s\S]*?)(?=\r?\nTOOL\s*:|$)/gi;
  let match: RegExpExecArray | null;
  while ((match = marker.exec(text)) !== null) {
    const name = match[1];
    if (!name) continue;
    const block = match[2] ?? "";
    const argsLine = /ARGS\s*:\s*(\{[\s\S]*?\})\s*$/im.exec(block);
    if (argsLine?.[1]) {
      const args = normalizeArguments(argsLine[1]);
      if (args) calls.push({ name, arguments: args, source: "marker" });
      continue;
    }
    const pathLine = /^PATH\s*:\s*(.+)$/im.exec(block)?.[1]?.trim();
    const contentLine = /^CONTENT\s*:\s*([\s\S]*)$/im.exec(block)?.[1];
    if (pathLine && contentLine !== undefined) {
      calls.push({ name, arguments: { path: pathLine, content: contentLine.trim() }, source: "marker" });
    } else if (pathLine) {
      calls.push({ name, arguments: { path: pathLine }, source: "marker" });
    } else {
      const cmd = /^CMD\s*:\s*(.+)$/im.exec(block)?.[1]?.trim();
      if (cmd) calls.push({ name, arguments: { cmd }, source: "marker" });
    }
  }
  return calls;
}

export function inferToolFromArguments(arguments_: Record<string, unknown>, allowed: Set<string>): string | null {
  const keys = Object.keys(arguments_);
  let best: string | null = null;
  let bestScore = -1;
  for (const [tool, expected] of Object.entries(KNOWN_ARGUMENTS)) {
    if (!allowed.has(tool)) continue;
    if (!expected.every((key) => keys.includes(key))) continue;
    const extra = keys.length - expected.length;
    const score = expected.length * 10 - extra;
    if (score > bestScore) {
      best = tool;
      bestScore = score;
    }
  }
  return best;
}

export function mislabelHint(name: string, arguments_: Record<string, unknown>, allowed: Set<string>): string | null {
  if (!allowed.has(name)) {
    const inferred = inferToolFromArguments(arguments_, allowed);
    return inferred ? `tool ${name} is not registered; the arguments look like ${inferred}` : `tool ${name} is not registered`;
  }
  const expected = KNOWN_ARGUMENTS[name];
  if (!expected) return null;
  if (expected.every((key) => Object.prototype.hasOwnProperty.call(arguments_, key))) return null;
  const inferred = inferToolFromArguments(arguments_, allowed);
  if (inferred && inferred !== name) return `arguments do not match ${name}; they look like ${inferred}`;
  return null;
}

export function parseToolCalls(
  text: string,
  allowed: Iterable<string>,
  native?: unknown,
): ParseResult {
  const allowedSet = new Set(allowed);
  const rejected: Array<{ reason: string; raw: unknown }> = [];
  const nativeCalls = parseNativeToolCalls(native);
  if (nativeCalls.length > 0) {
    const accepted = nativeCalls.filter((call) => {
      const hint = mislabelHint(call.name, call.arguments, allowedSet);
      if (hint) rejected.push({ reason: hint, raw: call });
      return !hint;
    });
    if (accepted.length > 0) return { calls: accepted.slice(0, 8), rejected };
  }

  const markerCalls = parseMarkerCalls(text);
  if (markerCalls.length > 0) {
    const accepted = markerCalls.filter((call) => {
      const hint = mislabelHint(call.name, call.arguments, allowedSet);
      if (hint) rejected.push({ reason: hint, raw: call });
      return !hint;
    });
    if (accepted.length > 0) return { calls: accepted.slice(0, 8), rejected };
  }

  const jsonCalls: ToolCall[] = [];
  for (const value of extractJsonCandidates(text)) {
    if (looksLikeSchemaEcho(value)) {
      rejected.push({ reason: "schema echo, not a call", raw: value });
      continue;
    }
    const direct = candidate(value, "json");
    if (direct) {
      jsonCalls.push(direct);
      continue;
    }
    if (isRecord(value) && isRecord(value.function)) {
      const fn = value.function;
      const name = typeof fn.name === "string" ? fn.name : null;
      const args = normalizeArguments(fn.arguments);
      if (name && args) jsonCalls.push({ name, arguments: args, source: "json" });
    }
  }
  const accepted = jsonCalls.filter((call) => {
    const hint = mislabelHint(call.name, call.arguments, allowedSet);
    if (hint) rejected.push({ reason: hint, raw: call });
    return !hint;
  });
  return { calls: accepted.slice(0, 8), rejected };
}
