import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * A tiny server-sent-events hub. SSE is used instead of a raw WebSocket because the admin
 * token travels in an Authorization header (fetch + ReadableStream on the browser side), so
 * the token never has to appear in a URL or in the page itself.
 *
 * No business logic lives here: producers call broadcast(), the browser only renders.
 */
export type HubEvent =
  | "hello"
  | "audit"
  | "request"
  | "engine"
  | "metrics"
  | "mcp"
  | "tool"
  | "download"
  | "ping";

interface Client {
  id: number;
  res: ServerResponse;
}

export class EventHub {
  private readonly clients = new Map<number, Client>();
  private sequence = 0;
  private heartbeat: NodeJS.Timeout | null = null;

  get size(): number {
    return this.clients.size;
  }

  add(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write("retry: 3000\n\n");
    const id = ++this.sequence;
    this.clients.set(id, { id, res });
    this.write(res, "hello", { id, at: new Date().toISOString(), clients: this.clients.size });
    const drop = (): void => {
      this.clients.delete(id);
    };
    req.on("close", drop);
    res.on("close", drop);
    res.on("error", drop);
    this.ensureHeartbeat();
  }

  broadcast(event: HubEvent, data: unknown): void {
    for (const client of this.clients.values()) this.write(client.res, event, data);
  }

  private ensureHeartbeat(): void {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      if (this.clients.size === 0) {
        this.stop();
        return;
      }
      this.broadcast("ping", { at: new Date().toISOString() });
    }, 15_000);
    this.heartbeat.unref();
  }

  private write(res: ServerResponse, event: HubEvent, data: unknown): void {
    if (res.writableEnded || res.destroyed) return;
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      // A dead client is removed by its close handler; never let one socket break a broadcast.
    }
  }

  stop(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const client of this.clients.values()) {
      try {
        client.res.end();
      } catch {
        // already closed
      }
    }
    this.clients.clear();
  }
}
