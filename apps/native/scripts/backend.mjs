// Host-owned REST adapter. No Pi runtime, SSE, body scope, source tools or UI actions.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await rename(temporary, path);
}

export class Backend {
  constructor({ url, token, outbox, emit }) {
    this.url = new URL(url);
    if (
      this.url.username ||
      this.url.password ||
      this.url.search ||
      this.url.hash ||
      this.url.pathname !== "/" ||
      !["http:", "https:"].includes(this.url.protocol) ||
      (this.url.protocol === "http:" &&
        !["localhost", "127.0.0.1", "[::1]"].includes(this.url.hostname))
    )
      throw new Error("Use HTTPS or an explicitly forwarded loopback origin");
    this.token = token;
    this.outbox = outbox;
    this.emit = emit;
    this.pending = null;
    this.running = false;
  }
  async request(path, body) {
    const response = await fetch(new URL(path, this.url), {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    if (![200, 202].includes(response.status)) {
      // Never echo remote bodies, bearer values or transport exception details.
      throw new Error(
        response.status === 401
          ? "Sign-in required"
          : response.status === 403
            ? "Access denied"
            : response.status === 409
              ? "Mutation conflict; pending request retained"
              : "Request failed; retry safely",
      );
    }
    const raw = await response.text();
    if (Buffer.byteLength(raw) > 8 * 1024 * 1024)
      throw new Error("Response exceeds budget");
    return JSON.parse(raw);
  }
  async connect() {
    const viewer = await this.request("/v1/viewer");
    if (
      viewer.version !== 1 ||
      viewer.conversationId !== "primary" ||
      !viewer.viewer
    )
      throw new Error("Unsupported viewer response");
    // Outboxes are bound to the authenticated scope AND endpoint, not a client claim.
    const binding = JSON.stringify([
      this.url.origin,
      viewer.viewer.tenantId,
      viewer.viewer.userId,
      viewer.viewer.agentId,
    ]);
    this.emit({
      type: "viewer",
      name: viewer.viewer.displayName ?? "Computah",
    });
    await this.history();
    try {
      const saved = JSON.parse(await readFile(this.outbox, "utf8"));
      if (saved.version !== 1 || saved.binding !== binding)
        throw new Error("Outbox belongs to another connection");
      this.pending = saved.pending;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    this.binding = binding;
    if (this.pending) this.emit({ type: "pending", text: this.pending.text });
    this.emit({ type: "ready" });
    this.emit({
      type: "status",
      text: this.pending
        ? "Unsettled request recovered · Retry reuses its mutation ID"
        : "Connected · final results, not streaming",
    });
  }
  async history() {
    const messages = [];
    let cursor = null;
    const seen = new Set();
    do {
      const page = await this.request(
        `/v1/history${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      if (
        page.version !== 1 ||
        page.conversationId !== "primary" ||
        !Array.isArray(page.messages)
      )
        throw new Error("Unsupported history response");
      messages.push(...page.messages);
      cursor = page.nextCursor;
      if (cursor !== null && typeof cursor !== "string")
        throw new Error("Invalid history cursor");
      if (cursor && seen.has(cursor))
        throw new Error("Repeated history cursor");
      seen.add(cursor);
    } while (cursor);
    this.emit({ type: "history", messages });
  }
  async save() {
    await atomicJson(this.outbox, {
      version: 1,
      binding: this.binding,
      pending: this.pending,
    });
  }
  async send(text) {
    if (!this.binding) throw new Error("Connect before sending");
    if (this.running) return;
    if (this.pending && text !== undefined && text !== this.pending.text)
      throw new Error("Resolve the pending request before sending another");
    this.running = true;
    try {
      if (!this.pending) {
        if (typeof text !== "string" || !text.trim() || text.length > 100000)
          throw new Error("Enter a message");
        const clientMutationId = randomUUID();
        // The live REST route caps JSON bytes too, including escaped text.
        if (
          Buffer.byteLength(JSON.stringify({ text, clientMutationId })) > 110000
        )
          throw new Error("Message exceeds request budget");
        this.pending = { text, clientMutationId, id: null };
      }
      await this.save(); // Persist BEFORE admission, including retry after a failed disk write.
      this.emit({ type: "pending", text: this.pending.text });
      this.emit({ type: "busy", value: true });
      if (!this.pending.id) {
        const admitted = await this.request("/v1/submissions", {
          text: this.pending.text,
          clientMutationId: this.pending.clientMutationId,
        }); // Deliberately not the shared SendRequest: REST forbids conversationId.
        if (
          admitted.version !== 1 ||
          typeof admitted.id !== "string" ||
          admitted.clientMutationId !== this.pending.clientMutationId
        )
          throw new Error("Unsupported admission response");
        this.pending.id = admitted.id;
        await this.save();
      }
      while (this.pending) {
        const result = await this.request(
          `/v1/submissions/${encodeURIComponent(this.pending.id)}?wait=true`,
        );
        if (
          result.version !== 1 ||
          !result.submission ||
          !Array.isArray(result.messages)
        )
          throw new Error("Unsupported result response");
        if (
          ["completed", "cancelled", "failed", "unknown"].includes(
            result.submission.outcome,
          )
        ) {
          // Result entries contain only the final assistant answer. Reconcile all
          // authoritative pages so the initiating user message is visible too.
          await this.history();
          const settled = this.pending;
          this.pending = null;
          try {
            await this.save();
          } catch (error) {
            this.pending = settled;
            throw error;
          }
          this.emit({
            type: "result",
            messages: result.messages,
            outcome: result.submission.outcome,
          });
          break;
        }
        if (!["accepted", "streaming"].includes(result.submission.outcome))
          throw new Error("Unsupported outcome");
        this.emit({
          type: "status",
          text: "Working · waiting for the final result",
        });
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    } finally {
      this.running = false;
      this.emit({ type: "busy", value: false });
    }
  }
  async cancel() {
    if (!this.pending?.id) {
      this.emit({
        type: "status",
        text: "Admission is unsettled · Retry to recover its handle; disconnect is not cancellation",
      });
      return;
    }
    const result = await this.request(
      `/v1/submissions/${encodeURIComponent(this.pending.id)}/cancel`,
      {},
    );
    if (!["cancelled", "too-late", "unknown"].includes(result.status))
      throw new Error("Unsupported cancellation response");
    this.emit({
      type: "status",
      text:
        result.status === "cancelled"
          ? "Cancellation confirmed · reconciling final result"
          : result.status === "too-late"
            ? "Too late to cancel · reconciling final result"
            : "Cancellation unknown · work may continue",
    });
  }
}
