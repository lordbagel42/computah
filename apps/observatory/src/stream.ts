import type { Snapshot } from "./collector.ts";
import { LIMIT, type PublicSpan, project, WINDOW_MS } from "./projection.ts";

const key = (span: PublicSpan) => JSON.stringify([span.traceId, span.id]);
type Frame = { id: string; text: string; bytes: number };

/** Ephemeral public replay: restart or an expired cursor always causes a full reset. */
export class FeedStream {
  private epoch = crypto.randomUUID();
  private sequence = 0;
  private frames: Frame[] = [];
  private bytes = 0;
  private clients = new Map<
    ReadableStreamDefaultController<Uint8Array>,
    () => void
  >();
  private previous = new Map<string, string>();
  private snapshot?: Snapshot;
  private encoder = new TextEncoder();
  get readers() {
    return this.clients.size;
  }

  publish(snapshot: Snapshot) {
    const next = new Map(
      snapshot.spans.map((span) => [key(span), JSON.stringify(span)]),
    );
    const upserts = snapshot.spans.filter(
      (span) => next.get(key(span)) !== this.previous.get(key(span)),
    );
    const removed = [...this.previous.keys()].filter((id) => !next.has(id));
    this.snapshot = snapshot;
    this.previous = next;
    if (!upserts.length && !removed.length) return;
    const { spans: _, ...metadata } = snapshot;
    this.emit("delta", { ...metadata, upserts, removed });
  }
  status(value: Record<string, unknown>) {
    this.emit("status", value);
  }
  private emit(event: string, data: unknown) {
    const id = `${this.epoch}:${++this.sequence}`;
    const text = `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    const bytes = this.encoder.encode(text).byteLength;
    this.frames.push({ id, text, bytes });
    this.bytes += bytes;
    while (this.frames.length > 256 || this.bytes > 4 * 1024 * 1024) {
      this.bytes -= this.frames.shift()?.bytes ?? 0;
    }
    for (const client of this.clients.keys()) this.send(client, text);
  }
  private send(
    client: ReadableStreamDefaultController<Uint8Array>,
    text: string,
  ) {
    try {
      const bytes = this.encoder.encode(text);
      if ((client.desiredSize ?? 0) < bytes.byteLength) {
        client.close();
        this.clients.get(client)?.();
        return;
      }
      client.enqueue(bytes);
    } catch {
      this.clients.get(client)?.();
    }
  }
  connect(
    cursor: string | null,
    signal: AbortSignal,
    onClose: () => void,
  ): Response {
    if (this.readers >= 16)
      return new Response("Feed at capacity", { status: 503 });
    let client: ReadableStreamDefaultController<Uint8Array>;
    let ended = false;
    const cleanup = () => {
      if (ended) return;
      ended = true;
      this.clients.delete(client);
      signal.removeEventListener("abort", abort);
      onClose();
    };
    const abort = () => {
      try {
        client.close();
      } catch {}
      cleanup();
    };
    const stream = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          client = controller;
          this.clients.set(client, cleanup);
          const suffix = cursor?.startsWith(`${this.epoch}:`)
            ? cursor.slice(this.epoch.length + 1)
            : "";
          const sequence = /^\d{1,12}$/.test(suffix) ? Number(suffix) : -1;
          const oldest = this.frames.length
            ? Number(this.frames[0].id.slice(this.epoch.length + 1))
            : this.sequence + 1;
          const replay = this.frames.filter(
            (frame) => Number(frame.id.slice(this.epoch.length + 1)) > sequence,
          );
          if (
            sequence >= oldest - 1 &&
            sequence <= this.sequence &&
            replay.reduce((sum, frame) => sum + frame.bytes, 0) < 768 * 1024
          ) {
            for (const frame of replay) this.send(client, frame.text);
          } else {
            this.send(
              client,
              `id: ${this.epoch}:${this.sequence}\nevent: snapshot\ndata: ${JSON.stringify(this.snapshot)}\n\n`,
            );
          }
          this.send(client, "retry: 2000\n\n");
          if (!ended) signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        },
        cancel: cleanup,
      },
      { highWaterMark: 1024 * 1024, size: (chunk) => chunk.byteLength },
    );
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  }
}

/** Reconstruct every incoming record; no private field or raw identifier is retained. */
export class LiveProjection {
  private spans = new Map<string, { span: PublicSpan; revision: number }>();
  lastReceivedAt: number | null = null;
  accept(body: unknown, secret: string, now = Date.now()): number {
    if (!body || typeof body !== "object") throw new Error("Invalid batch");
    const value = body as { version?: unknown; records?: unknown };
    if (
      value.version !== 1 ||
      !Array.isArray(value.records) ||
      value.records.length > 128
    )
      throw new Error("Invalid batch");
    let accepted = 0;
    for (const record of value.records) {
      if (!record || typeof record !== "object") continue;
      const row = record as Record<string, unknown>;
      if (
        !Number.isSafeInteger(row.revision) ||
        (row.revision as number) < 1 ||
        !["active", "ended"].includes(row.lifecycle as string) ||
        typeof row.observed_at !== "number" ||
        !Number.isFinite(row.observed_at) ||
        Math.abs(now - row.observed_at) > 30_000
      )
        continue;
      const span = project([row], secret)[0];
      if (
        !span ||
        span.start > now + 30_000 ||
        span.start < now - 7 * 86400_000 ||
        span.service === "runtime" ||
        span.service === "computah-observatory"
      )
        continue;
      const id = key(span);
      const prior = this.spans.get(id);
      if (
        prior &&
        (prior.revision >= (row.revision as number) ||
          prior.span.lifecycle === "ended")
      )
        continue;
      span.lifecycle = row.lifecycle as "active" | "ended";
      span.observedAt = row.observed_at;
      this.spans.set(id, { span, revision: row.revision as number });
      accepted++;
    }
    if (accepted) this.lastReceivedAt = now;
    this.prune(now);
    return accepted;
  }
  private prune(now: number) {
    for (const [id, item] of this.spans) {
      if ((item.span.observedAt ?? 0) < now - WINDOW_MS) this.spans.delete(id);
    }
    while (this.spans.size > LIMIT)
      this.spans.delete(this.spans.keys().next().value as string);
  }
  merge(history: Snapshot, diagnostics: boolean, now = Date.now()): Snapshot {
    this.prune(now);
    const spans = new Map<string, PublicSpan>(
      history.spans.map((span) => [
        key(span),
        { ...span, lifecycle: "ended" as const },
      ]),
    );
    for (const [id, item] of this.spans) {
      if (!diagnostics && item.span.name === "computah.logs.export") continue;
      // Settled history is authoritative if a late/lost active update remains.
      if (!spans.has(id)) spans.set(id, { ...item.span });
    }
    const freshActive = (span: PublicSpan) =>
      Number(
        span.lifecycle === "active" && now - (span.observedAt ?? 0) < 15_000,
      );
    const sorted = [...spans.values()].sort(
      (a, b) => freshActive(b) - freshActive(a) || b.start - a.start,
    );
    const result: PublicSpan[] = [];
    let remaining = 512 * 1024 - 1024;
    for (const span of sorted.slice(0, LIMIT)) {
      // Fixed public strings are ASCII. Reserve space for topology presence changes.
      remaining -= JSON.stringify(span).length + 64;
      if (remaining < 0) break;
      result.push(span);
    }
    const present = new Set(result.map((span) => span.id));
    for (const span of result) {
      if (span.parentId)
        span.parentState =
          span.parentId !== span.id && present.has(span.parentId)
            ? "present"
            : "missing";
      span.links = span.links.map((link) => ({
        ...link,
        present: present.has(link.id),
      }));
    }
    return {
      ...history,
      truncated: history.truncated || sorted.length > result.length,
      spans: result,
    };
  }
}
