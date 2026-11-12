export interface SseEvent {
  event: string;
  data: string;
  id?: string;
  retry?: number;
}

function parseBlock(raw: string): SseEvent | null {
  let event = "message";
  let id: string | undefined;
  let retry: number | undefined;
  const data: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon >= 0 ? line.slice(0, colon) : line;
    let value = colon >= 0 ? line.slice(colon + 1) : "";
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    else if (field === "id") id = value;
    else if (field === "retry") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) retry = parsed;
    }
  }
  if (data.length === 0 && event === "message" && id === undefined) return null;
  return {
    event,
    data: data.join("\n"),
    ...(id === undefined ? {} : { id }),
    ...(retry === undefined ? {} : { retry }),
  };
}

/**
 * Incremental SSE parser. A network chunk can end in the middle of a line or an
 * event, so the caller must keep one parser per stream and feed every chunk.
 */
export class SseParser {
  private buffer = "";

  push(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const events: SseEvent[] = [];
    for (;;) {
      const match = /\r?\n\r?\n/.exec(this.buffer);
      if (!match || match.index === undefined) break;
      const raw = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const event = parseBlock(raw);
      if (event) events.push(event);
    }
    return events;
  }

  flush(): SseEvent[] {
    if (!this.buffer.trim()) {
      this.buffer = "";
      return [];
    }
    const raw = this.buffer;
    this.buffer = "";
    const event = parseBlock(raw);
    return event ? [event] : [];
  }
}

export function formatSse(event: string, data: string): string {
  return `event: ${event}\ndata: ${data}\n\n`;
}

export function parseSseData(event: SseEvent): unknown {
  if (!event.data || event.data === "[DONE]") return null;
  try {
    return JSON.parse(event.data) as unknown;
  } catch {
    return null;
  }
}

export async function* readSse(
  stream: AsyncIterable<string | Buffer>,
): AsyncGenerator<SseEvent> {
  const parser = new SseParser();
  for await (const chunk of stream) {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    for (const event of parser.push(text)) yield event;
  }
  for (const event of parser.flush()) yield event;
}
