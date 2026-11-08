import { Schema } from "effect";

export {
  type DebugshareId,
  debugshareIdPattern,
  isDebugshareId,
} from "./debugshare.js";

/** Wire version, not a permission or backend implementation version. */
export const WireVersion = Schema.Literal(1);
export const Id = Schema.String.check(Schema.isMinLength(1));
export const Revision = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
);
export const Outcome = Schema.Literals([
  "accepted",
  "streaming",
  "completed",
  "failed",
  "cancelled",
  "unknown",
]);
export type Outcome = typeof Outcome.Type;

export const Viewer = Schema.Struct({
  tenantId: Id,
  userId: Id,
  agentId: Id,
  displayName: Schema.String,
  capabilities: Schema.Array(Schema.String),
});
export type Viewer = typeof Viewer.Type;

/** Safe projections only; the host owns origin, credentials and grant bindings. */
export const AccountHandle = Schema.Struct({
  id: Id,
  alias: Schema.String,
  status: Schema.Literals([
    "pending",
    "ready",
    "needs-human",
    "unknown",
    "revoked",
    "error",
  ]),
  capabilities: Schema.Array(Schema.String),
});
export type AccountHandle = typeof AccountHandle.Type;
export const BrowserSessionHandle = Schema.Struct({
  id: Id,
  accountId: Schema.NullOr(Id),
  status: Schema.Literals([
    "created",
    "authenticated",
    "needs-human",
    "expired",
    "closed",
    "unknown",
  ]),
  capabilities: Schema.Array(Schema.String),
});
export type BrowserSessionHandle = typeof BrowserSessionHandle.Type;

export const TextBlock = Schema.Struct({
  id: Id,
  kind: Schema.Literal("text"),
  text: Schema.String,
});
export const ComponentBlock = Schema.Struct({
  id: Id,
  kind: Schema.Literal("component"),
  component: Id,
  componentVersion: Revision,
  props: Schema.Record(Schema.String, Schema.Json),
  fallback: Schema.String,
});
export const Block = Schema.Union([TextBlock, ComponentBlock]);
export const Message = Schema.Struct({
  id: Id,
  submissionId: Schema.NullOr(Id),
  role: Schema.Literals(["user", "assistant", "system"]),
  createdAt: Schema.String,
  revision: Revision,
  blocks: Schema.Array(Block),
});
export type Message = typeof Message.Type;

/** Read-only operator projections, not atomic snapshots or live actor status. */
const operatorActorFields = {
  id: Id,
  availability: Schema.Literals(["present", "missing"]),
  messages: Schema.Array(Message),
  nextCursor: Schema.NullOr(Id),
  truncatedMessageIds: Schema.Array(Id),
};
export const OperatorActor = Schema.Struct(operatorActorFields);
export type OperatorActor = typeof OperatorActor.Type;
export const OperatorWorker = Schema.Struct({
  ...operatorActorFields,
  label: Id,
});
export type OperatorWorker = typeof OperatorWorker.Type;
export const OperatorTask = Schema.Struct({
  id: Id,
  workerId: Id,
  workerLabel: Id,
  entryId: Id,
  status: Schema.Literals(["recorded", "result-recorded"]),
  createdAt: Schema.String,
});
export type OperatorTask = typeof OperatorTask.Type;
export const OperatorSnapshot = Schema.Struct({
  version: WireVersion,
  observedAt: Schema.String,
  mode: Schema.Literals(["real", "faux"]),
  viewer: Viewer,
  interaction: OperatorActor,
  tasks: Schema.Array(OperatorTask),
  workers: Schema.Array(OperatorWorker),
  limitations: Schema.Array(Schema.String),
});
export type OperatorSnapshot = typeof OperatorSnapshot.Type;
export const OperatorHistoryPage = Schema.Struct({
  version: WireVersion,
  actorId: Id,
  availability: Schema.Literals(["present", "missing"]),
  messages: Schema.Array(Message),
  nextCursor: Schema.NullOr(Id),
  truncatedMessageIds: Schema.Array(Id),
  limitations: Schema.Array(Schema.String),
});
export type OperatorHistoryPage = typeof OperatorHistoryPage.Type;

export const Submission = Schema.Struct({
  id: Id,
  clientMutationId: Id,
  outcome: Outcome,
});
export type Submission = typeof Submission.Type;
export const Connection = Schema.Struct({
  id: Id,
  provider: Id,
  displayName: Schema.String,
  state: Schema.Literals([
    "disconnected",
    "connecting",
    "connected",
    "expired",
    "error",
    "unknown",
  ]),
  capabilities: Schema.Array(Schema.String),
});
export const Snapshot = Schema.Struct({
  version: WireVersion,
  conversationId: Id,
  revision: Revision,
  cursor: Schema.String,
  messages: Schema.Array(Message),
  submissions: Schema.Array(Submission),
  connections: Schema.Array(Connection),
});
export type Snapshot = typeof Snapshot.Type;

export const SendRequest = Schema.Struct({
  conversationId: Id,
  clientMutationId: Id,
  text: Schema.String,
});
export type SendRequest = typeof SendRequest.Type;

/** Identity, source grants and destinations are bound by the authenticated host. */
export const BusSendRequest = Schema.Struct({
  clientMutationId: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(200),
  ),
  text: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(100_000),
    Schema.isPattern(/\S/u),
  ),
});
export type BusSendRequest = typeof BusSendRequest.Type;

const busReceiptFields = {
  version: WireVersion,
  id: Id,
  clientMutationId: Id,
  submissionId: Schema.NullOr(Id),
};
const completedBusReceipt = Schema.Struct({
  ...busReceiptFields,
  status: Schema.Literal("completed"),
});
const otherBusReceipt = Schema.Struct({
  ...busReceiptFields,
  status: Schema.Literals(["queued", "submitted", "failed", "cancelled"]),
});
export const BusReceipt = Schema.Union([completedBusReceipt, otherBusReceipt]);
export type BusReceipt = typeof BusReceipt.Type;

/** Public final text only; ordering and replay use native Durable Stream offsets. */
export const BusOutput = Schema.Union([
  Schema.Struct({
    version: WireVersion,
    receipt: completedBusReceipt,
    text: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    version: WireVersion,
    receipt: otherBusReceipt,
    text: Schema.Null,
  }),
]);
export type BusOutput = typeof BusOutput.Type;

export const CancelRequest = Schema.Struct({
  conversationId: Id,
  submissionId: Id,
  clientMutationId: Id,
});
export type CancelRequest = typeof CancelRequest.Type;
export const CancelResult = Schema.Struct({
  submissionId: Id,
  status: Schema.Literals(["requested", "cancelled", "too-late", "unknown"]),
});
export type CancelResult = typeof CancelResult.Type;

const observationFields = {
  version: WireVersion,
  submissionId: Id,
  phase: Schema.Literals([
    "idle",
    "generating",
    "delegating",
    "completed",
    "failed",
    "cancelled",
  ]),
  text: Schema.String,
};
/** Safe current text replacement; no reasoning, tool payload or durable cursor. */
export const SubmissionObservation = Schema.Union([
  Schema.Struct({
    ...observationFields,
    source: Schema.Literal("interaction"),
    workerLabel: Schema.Null,
    acknowledgement: Schema.optional(
      Schema.String.check(Schema.isMaxLength(3500)),
    ),
  }),
  Schema.Struct({
    ...observationFields,
    source: Schema.Literal("worker"),
    workerLabel: Id,
  }),
]);
export type SubmissionObservation = typeof SubmissionObservation.Type;
const observationEventFields = {
  version: WireVersion,
  submissionId: Id,
  /** Sequence is connection-local; reconnect starts with resync at zero. */
  sequence: Revision,
};
export const SubmissionObservationEvent = Schema.Union([
  Schema.Struct({
    ...observationEventFields,
    kind: Schema.Literal("resync"),
    observations: Schema.Array(SubmissionObservation),
  }),
  Schema.Struct({
    ...observationEventFields,
    kind: Schema.Literal("observation"),
    observation: SubmissionObservation,
  }),
  Schema.Struct({
    ...observationEventFields,
    kind: Schema.Literal("result"),
    submission: Schema.Struct({
      id: Id,
      clientMutationId: Id,
      outcome: Schema.Literals(["completed", "failed", "cancelled"]),
    }),
    messages: Schema.Array(Message),
  }),
]);
export type SubmissionObservationEvent = typeof SubmissionObservationEvent.Type;

const eventFields = {
  version: WireVersion,
  eventId: Id,
  cursor: Id,
  conversationId: Id,
  revision: Revision,
};
export const StreamEvent = Schema.Union([
  Schema.Struct({
    ...eventFields,
    kind: Schema.Literal("submission"),
    submission: Submission,
  }),
  Schema.Struct({
    ...eventFields,
    kind: Schema.Literal("message"),
    message: Message,
  }),
  Schema.Struct({
    ...eventFields,
    kind: Schema.Literal("resync-required"),
    reason: Schema.Literals(["expired-cursor", "gap"]),
  }),
]);
export type StreamEvent = typeof StreamEvent.Type;

export const WireError = Schema.Struct({
  code: Schema.Literals([
    "not-found",
    "unauthenticated",
    "forbidden",
    "conflict",
    "invalid-request",
    "unavailable",
  ]),
  message: Schema.String,
  correlationId: Id,
  retryable: Schema.Boolean,
});
export type WireError = typeof WireError.Type;

/** Context is bound by the host; no method accepts a client-supplied Viewer. */
export interface AgentAdapter {
  viewer(): Promise<Viewer>;
  snapshot(conversationId: string): Promise<Snapshot>;
  send(request: SendRequest): Promise<Submission>;
  cancel(request: CancelRequest): Promise<CancelResult>;
  subscribe(
    request: { readonly conversationId: string; readonly cursor: string },
    signal?: AbortSignal,
  ): AsyncIterable<StreamEvent>;
}

export function isTerminal(outcome: Outcome): boolean {
  return (
    outcome === "completed" || outcome === "failed" || outcome === "cancelled"
  );
}

/** Client reducer: full-block updates deliberately avoid ambiguous text deltas. */
export function applyEvent(snapshot: Snapshot, event: StreamEvent): Snapshot {
  if (event.conversationId !== snapshot.conversationId)
    throw new Error("Wrong conversation");
  if (event.kind === "resync-required") throw new Error("Snapshot required");
  if (event.revision <= snapshot.revision) return snapshot;
  if (event.revision !== snapshot.revision + 1)
    throw new Error("Snapshot required");
  if (event.kind === "submission") {
    const current = snapshot.submissions.find(
      (item) => item.id === event.submission.id,
    );
    if (
      current &&
      isTerminal(current.outcome) &&
      current.outcome !== event.submission.outcome
    ) {
      throw new Error("Terminal outcome cannot change");
    }
    return {
      ...snapshot,
      revision: event.revision,
      cursor: event.cursor,
      submissions: [
        ...snapshot.submissions.filter(
          (item) => item.id !== event.submission.id,
        ),
        event.submission,
      ],
    };
  }
  const current = snapshot.messages.find(
    (item) => item.id === event.message.id,
  );
  const submission = snapshot.submissions.find(
    (item) => item.id === event.message.submissionId,
  );
  if (
    event.message.role === "assistant" &&
    submission &&
    isTerminal(submission.outcome)
  ) {
    throw new Error("Message after terminal outcome");
  }
  if (current && event.message.revision <= current.revision)
    throw new Error("Stale message revision");
  return {
    ...snapshot,
    revision: event.revision,
    cursor: event.cursor,
    messages: current
      ? snapshot.messages.map((item) =>
          item.id === event.message.id ? event.message : item,
        )
      : [...snapshot.messages, event.message],
  };
}
