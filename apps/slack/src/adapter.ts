import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export interface Binding {
  teamId: string;
  enterpriseId?: string;
  slackUserId: string;
  tenantId: string;
  userId: string;
  agentId: string;
  coreToken: string;
  channelIds: string[];
}

export interface Ingress {
  team_id?: string;
  event_id?: string;
  event?: {
    type?: string;
    subtype?: string;
    bot_id?: string;
    user?: string;
    channel?: string;
    channel_type?: string;
    text?: string;
    ts?: string;
    thread_ts?: string;
  };
}

interface Job {
  id: string;
  binding: string;
  text: string;
  channel: string;
  thread: string | null;
  submission: string | null;
  created: number;
  state: string;
}

export const bindingKey = (binding: Binding) =>
  JSON.stringify([
    binding.teamId,
    binding.slackUserId,
    binding.tenantId,
    binding.userId,
    binding.agentId,
  ]);

export interface Transport {
  request(binding: Binding, path: string, body?: unknown): Promise<unknown>;
  openDm(user: string): Promise<string>;
  post(channel: string, text: string, thread: string | null): Promise<void>;
}

/** Private, single-owner delivery journal, not a second cognition/history store. */
export class SlackAdapter {
  private readonly db: DatabaseSync;
  private readonly bindings: Map<string, Binding>;
  constructor(
    path: string,
    bindings: Binding[],
    private readonly botUserId: string,
    private readonly transport: Transport,
    private readonly now = Date.now,
  ) {
    this.bindings = new Map(
      bindings.map((binding) => [bindingKey(binding), binding]),
    );
    if (
      new Set(bindings.map((b) => `${b.teamId}:${b.slackUserId}`)).size !==
      bindings.length
    )
      throw new Error("Duplicate Slack binding");
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, binding TEXT NOT NULL, text TEXT NOT NULL,
        channel TEXT NOT NULL, thread TEXT, submission TEXT,
        created INTEGER NOT NULL, state TEXT NOT NULL
      );
      UPDATE jobs SET state='uncertain' WHERE state='posting';`);
  }

  /** Called before Socket Mode ACK. Repeated event IDs cannot reroute a job. */
  admit(body: Ingress): "ignored" | "accepted" | "duplicate" {
    const event = body.event;
    if (
      !body.team_id ||
      !body.event_id ||
      !event?.user ||
      !event.channel ||
      !event.ts ||
      !event.text ||
      event.subtype ||
      event.bot_id ||
      event.user === this.botUserId
    )
      return "ignored";
    const binding = [...this.bindings.values()].find(
      (b) => b.teamId === body.team_id && b.slackUserId === event.user,
    );
    if (!binding) return "ignored";
    const dm =
      event.type === "message" &&
      event.channel_type === "im" &&
      event.channel.startsWith("D");
    const mention =
      event.type === "app_mention" &&
      binding.channelIds.includes(event.channel) &&
      event.text.includes(`<@${this.botUserId}>`);
    if (!dm && !mention) return "ignored";
    const text = event.text.replaceAll(`<@${this.botUserId}>`, "").trim();
    if (!text || text.length > 20_000) return "ignored";
    const id = `slack:${createHash("sha256")
      .update(JSON.stringify([body.team_id, body.event_id]))
      .digest("hex")}`;
    if (this.db.prepare("SELECT id FROM jobs WHERE id=?").get(id))
      return "duplicate";
    // Retain receipts seven days; bound both inbox and operator-only disk use.
    this.db
      .prepare(
        "DELETE FROM jobs WHERE created < ? AND state IN ('done','uncertain')",
      )
      .run(this.now() - 7 * 86400_000);
    const count = this.db.prepare("SELECT count(*) AS n FROM jobs").get() as {
      n: number;
    };
    if (count.n >= 5000) throw new Error("Slack inbox full");
    const active = this.db
      .prepare(
        "SELECT count(*) AS n FROM jobs WHERE state IN ('queued','submitted')",
      )
      .get() as { n: number };
    if (active.n >= 100) throw new Error("Slack inbox busy");
    this.db
      .prepare("INSERT INTO jobs VALUES (?, ?, ?, ?, ?, NULL, ?, 'queued')")
      .run(
        id,
        bindingKey(binding),
        text,
        dm ? event.channel : "",
        dm ? (event.thread_ts ?? event.ts) : null,
        this.now(),
      );
    return "accepted";
  }

  /** One bounded network step; startup resumes queued/submitted receipts. */
  async step(): Promise<boolean> {
    const job = this.db
      .prepare(
        "SELECT * FROM jobs WHERE state IN ('queued','submitted') ORDER BY created, rowid LIMIT 1",
      )
      .get() as unknown as Job | undefined;
    if (!job) return false;
    const binding = this.bindings.get(job.binding);
    if (!binding) {
      this.finish(job.id, "done");
      return true;
    }
    try {
      if (this.now() - job.created > 5 * 60_000) {
        await this.deliver(
          job,
          binding,
          "Computah could not deliver a result within five minutes. Work may still be running; this is not a cancellation. Please contact the operator before resending.",
        );
        return true;
      }
      if (!job.submission) {
        const result = (await this.transport.request(
          binding,
          "/v1/submissions",
          { text: job.text, clientMutationId: job.id },
        )) as { id?: unknown };
        if (
          typeof result.id !== "string" ||
          !result.id ||
          result.id.length > 4096
        )
          throw new Error("Invalid submission");
        this.db
          .prepare("UPDATE jobs SET submission=?, state='submitted' WHERE id=?")
          .run(result.id, job.id);
        return true;
      }
      const result = (await this.transport.request(
        binding,
        `/v1/submissions/${encodeURIComponent(job.submission)}?wait=true`,
      )) as {
        submission?: { outcome?: string };
        messages?: {
          role: string;
          blocks: { kind: string; text?: string }[];
        }[];
      };
      const outcome = result.submission?.outcome;
      if (outcome === "accepted" || outcome === "streaming") return true;
      if (!["completed", "cancelled", "failed"].includes(outcome ?? ""))
        throw new Error("Invalid result");
      const text =
        outcome === "completed"
          ? result.messages
              ?.filter((m) => m.role === "assistant")
              .flatMap((m) =>
                m.blocks
                  .filter((b) => b.kind === "text")
                  .map((b) => b.text ?? ""),
              )
              .join("\n")
          : undefined;
      await this.deliver(
        job,
        binding,
        text ||
          `Computah finished with status: ${outcome}. No answer was returned.`,
      );
    } catch {
      // No provider/Slack errors, tokens, prompts or histories enter logs.
      // Queued/submitted requests retry with the same durable admission ID.
      // A failed/ambiguous Slack send remains uncertain, never blindly reposted.
    }
    return true;
  }

  private async deliver(job: Job, binding: Binding, text: string) {
    const limited =
      text.length > 2800
        ? `${text.slice(0, 2700)}\n[Answer shortened for Slack; ask for a shorter summary in DM.]`
        : text;
    this.finish(job.id, "posting");
    try {
      // A failed DM open also needs reconciliation, not indefinite inbox priority.
      const channel =
        job.channel || (await this.transport.openDm(binding.slackUserId));
      await this.transport.post(channel, limited, job.thread);
      this.finish(job.id, "done");
    } catch {
      this.finish(job.id, "uncertain");
    }
  }

  private finish(id: string, state: string) {
    this.db.prepare("UPDATE jobs SET state=? WHERE id=?").run(state, id);
  }

  counts(): Record<string, number> {
    return Object.fromEntries(
      (
        this.db
          .prepare("SELECT state, count(*) AS n FROM jobs GROUP BY state")
          .all() as { state: string; n: number }[]
      ).map((row) => [row.state, row.n]),
    );
  }

  close() {
    this.db.close();
  }
}
