import fs from "node:fs";
import path from "node:path";

/**
 * Node has no public mmap syscall. A zero-copy view here means a bounded
 * positional read (pread) into one Buffer plus a read-only inspection of the
 * engine's real memory map. The kernel page cache backs both; the model is
 * never copied into a second full-size JS buffer.
 */
export interface FileView {
  path: string;
  offset: number;
  length: number;
  buffer: Buffer;
  mode: "pread";
}

export function readFileView(file: string, offset = 0, length = 4096): FileView {
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    const bytes = fs.readSync(fd, buffer, 0, length, offset);
    return {
      path: file,
      offset,
      length: bytes,
      buffer: buffer.subarray(0, bytes),
      mode: "pread",
    };
  } finally {
    fs.closeSync(fd);
  }
}

export interface MmapRange {
  start: number;
  end: number;
  perms: string;
  offset: number;
  path: string;
}

export interface MmapSnapshot {
  pid: number;
  file: string;
  mapped_bytes: number;
  ranges: MmapRange[];
  source: "proc-maps";
}

export function inspectProcessMaps(pid: number, file: string): MmapSnapshot | null {
  const mapsFile = `/proc/${pid}/maps`;
  let text: string;
  try {
    text = fs.readFileSync(mapsFile, "utf8");
  } catch {
    return null;
  }
  const target = path.resolve(file);
  const ranges: MmapRange[] = [];
  for (const line of text.split("\n")) {
    const match = /^([0-9a-f]+)-([0-9a-f]+)\s+(\S+)\s+([0-9a-f]+)\s+\S+\s+\d+\s*(.*)$/i.exec(line);
    if (!match) continue;
    const mappedPath = (match[5] ?? "").trim();
    if (!mappedPath || path.resolve(mappedPath) !== target) continue;
    ranges.push({
      start: Number.parseInt(match[1] ?? "0", 16),
      end: Number.parseInt(match[2] ?? "0", 16),
      perms: match[3] ?? "",
      offset: Number.parseInt(match[4] ?? "0", 16),
      path: mappedPath,
    });
  }
  if (ranges.length === 0) return null;
  return {
    pid,
    file: target,
    mapped_bytes: ranges.reduce((sum, range) => sum + (range.end - range.start), 0),
    ranges,
    source: "proc-maps",
  };
}
