import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * A hidden watermark is invisible in the editor but travels with every copy of
 * the file. Zero-width spaces at the start of a line are the pattern: the text
 * reads normally, yet every line carries an extra code point.
 *
 * These tests read the repository as bytes, so a watermark that is invisible
 * to the reader still fails the build.
 */
const INVISIBLE = [
  0x200b, // zero width space
  0x200c, // zero width non-joiner
  0x200d, // zero width joiner
  0x2060, // word joiner
  0xfeff, // zero width no-break space
  0x2066, // left-to-right isolate
  0x2067, // right-to-left isolate
  0x2068, // first strong isolate
  0x2069, // pop directional isolate
];

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "data",
  "models",
  "logs",
  "workspace",
  "certs",
  "run",
  "gateway",
]);

const TEXT_SUFFIXES = [".ts", ".js", ".mjs", ".md", ".json", ".sh", ".html", ".css", ".yml", ".yaml", ".toml", ".txt"];

/** Third-party files are not ours to clean; they are listed so the check stays honest. */
const VENDORED = ["web/assets/js/vendor.min.js", "web/assets/css/vendor.min.css"];

/** The repository root, found from this test file's own location. */
function repoRoot(): string {
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
}

function repoFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".github") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
        continue;
      }
      if (!TEXT_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) continue;
      out.push(full);
    }
  };
  walk(root);
  return out;
}

function invisibleChars(text: string): Array<{ index: number; code: number }> {
  const hits: Array<{ index: number; code: number }> = [];
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (INVISIBLE.includes(code)) hits.push({ index, code });
  }
  return hits;
}

test("no repository file carries an invisible watermark character", () => {
  // The repository root, not a scratch directory: the scan must read the files
  // that are actually published.
  const root = repoRoot();
  const files = repoFiles(root);
  assert.ok(files.length > 0, "the repository scan found no files");

  const offenders: string[] = [];
  for (const file of files) {
    const relative = path.relative(root, file);
    if (VENDORED.includes(relative)) continue;
    const text = fs.readFileSync(file, "utf8");
    const hits = invisibleChars(text);
    if (hits.length > 0) {
      offenders.push(`${relative} (${hits.length} x U+${hits[0]!.code.toString(16).toUpperCase()})`);
    }
  }
  assert.deepEqual(offenders, [], `invisible watermark characters found: ${offenders.join(", ")}`);
});

test("the documentation carries no zero-width space at the start of a line", () => {
  const docs = path.join(repoRoot(), "docs");
  const offenders: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(docs, { withFileTypes: true });
  } catch {
    return; // no docs directory in this checkout
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const text = fs.readFileSync(path.join(docs, entry.name), "utf8");
    text.split("\n").forEach((line, index) => {
      if (line.startsWith("\u200b")) offenders.push(`${entry.name}:${index + 1}`);
    });
  }
  assert.deepEqual(offenders, [], `zero-width space at the start of a line: ${offenders.join(", ")}`);
});

test("the invisible characters are detected when they are present", () => {
  // The detector must fail on a planted watermark, otherwise the check is theatre.
  const planted = `visible text\n\u200bhidden marker\n`;
  const hits = invisibleChars(planted);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.code, 0x200b);
});
