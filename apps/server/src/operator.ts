import type {
  Message,
  OperatorHistoryPage,
  OperatorSnapshot,
  OperatorTask,
  Viewer,
} from "@computah/contracts";
import type { Cursor, EntryRecord, Page } from "@earendil-works/pi-durable";
import { Schema } from "effect";
import { CoreError, type CoreSession } from "./core.js";
import { projectMessages } from "./http.js";

const continuation = Schema.Union([
  Schema.Struct({
    role: Schema.Literal("interaction"),
    label: Schema.Null,
    cursor: Schema.Record(Schema.String, Schema.Json),
  }),
  Schema.Struct({
    role: Schema.Literal("worker"),
    label: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
    cursor: Schema.Record(Schema.String, Schema.Json),
  }),
]);

/** The HTTP host binds all callbacks to the authenticated principal, never request scope. */
export function createOperatorProjection(options: {
  mode: "real" | "faux";
  viewer: Viewer;
  session: Pick<CoreSession, "interactionId" | "workerId">;
  /** Must use an existing-only actor lookup and enforce both current standing grants. */
  readExisting(
    id: string,
    cursor?: Cursor,
    signal?: AbortSignal,
  ): Promise<Page<EntryRecord, Cursor> | null>;
  /** Recheck current bearer and standing history.read/operator.read grants. */
  authorize(): Promise<void>;
  /** Host-supplied current configured credentials; never include these in responses. */
  redactValues: readonly string[];
  /** Known provider/admin/browser-session URL bases, not a guessed domain blocklist. */
  privilegedUrlPrefixes: readonly string[];
  /** Purpose-separated, scope-bound authenticated sealing; not a browser-controlled codec. */
  seal(value: typeof continuation.Type): string;
  open(cursor: string): unknown;
}) {
  const redact = (text: string) => {
    let safe = text.replace(/(?:https?|wss?):\/\/[^\s<>"']+/g, (url) =>
      options.privilegedUrlPrefixes.some(
        (prefix) => prefix && url.includes(prefix),
      )
        ? "[redacted URL]"
        : url,
    );
    for (const value of [...options.redactValues]
      .filter(Boolean)
      .sort((a, b) => b.length - a.length))
      safe = safe.replaceAll(value, "[redacted]");
    return safe;
  };
  const permit = async () => {
    if (
      !["history.read", "operator.read"].every((grant) =>
        options.viewer.capabilities.includes(grant),
      )
    )
      throw new CoreError("denied");
    await options.authorize();
  };
  const decode = (cursor: string) => {
    if (cursor.length > 4096) throw new CoreError("invalid");
    try {
      const value = Schema.decodeUnknownSync(continuation, {
        onExcessProperty: "error",
      })(options.open(cursor));
      // Both are JSON; Pi's nested arrays are mutable, unlike Effect's Json type.
      return { ...value, cursor: value.cursor as Cursor };
    } catch {
      throw new CoreError("denied");
    }
  };
  const limitations = () => [
    "Transcript evidence only, not live actor or Task execution status.",
    "Existing actors may wake or resume during inspection; reads are not atomic.",
    "Only original user and final assistant text is shown; known configured secrets/privileged URLs are redacted, not arbitrary unknown secrets.",
    "Projection is bounded; truncation or omission is not losslessly continued by a cursor.",
  ];
  const readActor = async (
    role: "interaction" | "worker",
    label: string | null,
    cursor: Cursor | undefined,
    budget: { remaining: number },
    signal?: AbortSignal,
  ) => {
    await permit();
    const id =
      role === "interaction"
        ? options.session.interactionId
        : options.session.workerId(label as string);
    const page = await options.readExisting(id, cursor, signal);
    await permit();
    const entries = page?.items.slice(0, 100) ?? [];
    const truncatedMessageIds: string[] = [];
    const messages = projectMessages(entries).map((message) => {
      const blocks = message.blocks.map((block) => {
        if (block.kind !== "text") return block;
        const safe = redact(block.text);
        const input = Buffer.from(safe);
        const bytes = Math.min(input.length, 8192, budget.remaining);
        budget.remaining -= bytes;
        if (bytes === input.length) return { ...block, text: safe };
        if (!truncatedMessageIds.includes(message.id))
          truncatedMessageIds.push(message.id);
        return {
          ...block,
          text: new TextDecoder().decode(input.subarray(0, bytes), {
            stream: true,
          }),
        };
      });
      return { ...message, blocks };
    });
    const nextCursor = page?.next
      ? options.seal(
          role === "interaction"
            ? { role, label: null, cursor: page.next }
            : { role, label: label as string, cursor: page.next },
        )
      : null;
    return {
      entries,
      actor: {
        id,
        availability: page ? ("present" as const) : ("missing" as const),
        messages,
        nextCursor,
        truncatedMessageIds,
      },
    };
  };
  // Bound serialized JSON too: UTF-8 text limits alone miss escaping and metadata.
  const bound = (
    value: { limitations: string[] },
    actors: { messages: Message[]; truncatedMessageIds: string[] }[],
    tasks: OperatorTask[] = [],
  ) => {
    if (Buffer.byteLength(JSON.stringify(value)) > 65_536)
      value.limitations.push(
        "Response-size limit omitted messages or Task metadata; pagination is not lossless.",
      );
    while (Buffer.byteLength(JSON.stringify(value)) > 65_536) {
      const actor = actors.findLast((candidate) => candidate.messages.length);
      const removed = actor?.messages.pop();
      if (actor && removed) {
        if (!actor.truncatedMessageIds.includes(removed.id))
          actor.truncatedMessageIds.push(removed.id);
      } else if (!tasks.pop()) {
        throw new CoreError("runtime");
      }
    }
  };
  return {
    async snapshot(
      cursor?: string,
      signal?: AbortSignal,
    ): Promise<OperatorSnapshot> {
      await permit();
      const state = cursor === undefined ? undefined : decode(cursor);
      if (state && state.role !== "interaction") throw new CoreError("invalid");
      const budget = { remaining: 32_768 };
      const interaction = await readActor(
        "interaction",
        null,
        state?.cursor,
        budget,
        signal,
      );
      const tasks: OperatorTask[] = [];
      const labels = new Set<string>();
      const results = new Set(
        interaction.entries.flatMap((entry) =>
          (entry.model ?? []).flatMap((message) =>
            message.role === "toolResult" && message.toolName === "Task"
              ? [message.toolCallId]
              : [],
          ),
        ),
      );
      let omitted = false;
      for (const entry of interaction.entries) {
        if (entry.kind !== "pi.assistant") continue;
        for (const message of entry.model ?? []) {
          if (message.role !== "assistant") continue;
          for (const part of message.content) {
            if (part.type !== "toolCall" || part.name !== "Task") continue;
            const label = part.arguments.worker;
            if (
              typeof label !== "string" ||
              !label ||
              label.length > 200 ||
              !part.id ||
              part.id.length > 240 ||
              redact(label) !== label ||
              redact(part.id) !== part.id
            )
              continue;
            if (
              (!labels.has(label) && labels.size === 8) ||
              tasks.length === 64
            ) {
              omitted = true;
              continue;
            }
            labels.add(label);
            tasks.push({
              id: `${entry.id}:${part.id}`,
              workerId: options.session.workerId(label),
              workerLabel: label,
              entryId: String(entry.id),
              status: results.has(part.id) ? "result-recorded" : "recorded",
              createdAt: new Date(message.timestamp).toISOString(),
            });
          }
        }
      }
      const workers = [];
      for (const label of labels) {
        const { actor } = await readActor(
          "worker",
          label,
          undefined,
          budget,
          signal,
        );
        workers.push({ ...actor, label });
      }
      const value = {
        version: 1 as const,
        observedAt: new Date().toISOString(),
        mode: options.mode,
        viewer: {
          tenantId: options.viewer.tenantId,
          userId: options.viewer.userId,
          agentId: options.viewer.agentId,
          displayName: redact(options.viewer.displayName).slice(0, 200),
          capabilities: [...options.viewer.capabilities],
        },
        interaction: interaction.actor,
        tasks,
        workers,
        limitations: [
          ...limitations(),
          "Workers are discovered only from valid Task labels on this Interaction page.",
          ...(omitted
            ? ["Additional Tasks or Workers omitted by the projection limit."]
            : []),
        ],
      };
      bound(value, [interaction.actor, ...workers], tasks);
      await permit();
      return value;
    },
    async history(
      cursor: string,
      signal?: AbortSignal,
    ): Promise<OperatorHistoryPage> {
      await permit();
      const state = decode(cursor);
      if (state.label && redact(state.label) !== state.label)
        throw new CoreError("denied");
      const { actor } = await readActor(
        state.role,
        state.label,
        state.cursor,
        { remaining: 32_768 },
        signal,
      );
      const value = {
        version: 1 as const,
        actorId: actor.id,
        availability: actor.availability,
        messages: actor.messages,
        nextCursor: actor.nextCursor,
        truncatedMessageIds: actor.truncatedMessageIds,
        limitations: limitations(),
      };
      bound(value, [actor]);
      await permit();
      return value;
    },
  };
}
