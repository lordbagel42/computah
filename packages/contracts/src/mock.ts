import { Schema } from "effect";
import {
  type AgentAdapter,
  applyEvent,
  CancelRequest,
  type CancelResult,
  isTerminal,
  type Message,
  type Outcome,
  SendRequest,
  type Snapshot,
  type StreamEvent,
  type Submission,
  type Viewer,
} from "./index.js";

export const FIXTURE_TIME = "2026-01-01T12:00:00.000Z";
export const FIXTURE_TIMEZONE = "UTC";

/** Synthetic host binding only. This factory is not an authentication service. */
export function createMockSession(viewer: Viewer) {
  const boundViewer = structuredClone(viewer);
  const scope = encodeURIComponent(
    JSON.stringify([viewer.tenantId, viewer.userId, viewer.agentId]),
  );
  const conversationId = `${scope}/conversation`;
  const cursorAt = (revision: number) => `${conversationId}@${revision}`;
  let state: Snapshot = {
    version: 1,
    conversationId,
    revision: 0,
    cursor: cursorAt(0),
    messages: [],
    submissions: [],
    connections: [],
  };
  const events: StreamEvent[] = [];
  const sends = new Map<string, { text: string; submissionId: string }>();
  const cancellations = new Map<
    string,
    { submissionId: string; result: CancelResult }
  >();
  const waiting = new Set<() => void>();
  const fail = (code: string): never => {
    throw new Error(code);
  };
  const authorize = (id: string) => {
    if (id !== conversationId) fail("not-found");
  };
  const append = (
    payload:
      | { kind: "message"; message: Message }
      | { kind: "submission"; submission: Submission },
  ) => {
    const revision = state.revision + 1;
    const event: StreamEvent = {
      version: 1,
      eventId: `${conversationId}/event/${revision}`,
      cursor: cursorAt(revision),
      conversationId,
      revision,
      ...payload,
    };
    state = applyEvent(state, event);
    events.push(event);
    for (const wake of [...waiting]) wake();
  };
  const lookup = (id: string) =>
    state.submissions.find((item) => item.id === id) ?? fail("not-found");
  const adapter: AgentAdapter = {
    async viewer() {
      return structuredClone(boundViewer);
    },
    async snapshot(id) {
      authorize(id);
      return structuredClone(state);
    },
    async send(input) {
      const request = Schema.decodeUnknownSync(SendRequest, {
        onExcessProperty: "error",
      })(input);
      authorize(request.conversationId);
      if (!boundViewer.capabilities.includes("message.send")) fail("forbidden");
      const prior = sends.get(request.clientMutationId);
      if (prior) {
        if (prior.text !== request.text) fail("conflict");
        return structuredClone(lookup(prior.submissionId));
      }
      const id = `${conversationId}/submission/${sends.size + 1}`;
      sends.set(request.clientMutationId, {
        text: request.text,
        submissionId: id,
      });
      const submission: Submission = {
        id,
        clientMutationId: request.clientMutationId,
        outcome: "accepted",
      };
      append({ kind: "submission", submission });
      append({
        kind: "message",
        message: {
          id: `${id}/user`,
          submissionId: id,
          role: "user",
          revision: 0,
          createdAt: FIXTURE_TIME,
          blocks: [{ id: `${id}/input`, kind: "text", text: request.text }],
        },
      });
      return structuredClone(submission);
    },
    async cancel(input) {
      const request = Schema.decodeUnknownSync(CancelRequest, {
        onExcessProperty: "error",
      })(input);
      authorize(request.conversationId);
      if (!boundViewer.capabilities.includes("message.cancel"))
        fail("forbidden");
      const prior = cancellations.get(request.clientMutationId);
      if (prior) {
        if (prior.submissionId !== request.submissionId) fail("conflict");
        return structuredClone(prior.result);
      }
      const submission = lookup(request.submissionId);
      const status =
        submission.outcome === "cancelled"
          ? "cancelled"
          : isTerminal(submission.outcome)
            ? "too-late"
            : submission.outcome === "unknown"
              ? "unknown"
              : "cancelled";
      if (status === "cancelled" && submission.outcome !== "cancelled")
        append({
          kind: "submission",
          submission: { ...submission, outcome: "cancelled" },
        });
      const result: CancelResult = { submissionId: submission.id, status };
      cancellations.set(request.clientMutationId, {
        submissionId: submission.id,
        result,
      });
      return structuredClone(result);
    },
    subscribe(request, signal) {
      let closed = false;
      let wakePending = () => {};
      const source = (async function* (): AsyncGenerator<StreamEvent, void> {
        authorize(request.conversationId);
        let position =
          request.cursor === cursorAt(0)
            ? 0
            : events.findIndex((event) => event.cursor === request.cursor) + 1;
        if (position === 0 && request.cursor !== cursorAt(0)) {
          yield {
            version: 1,
            kind: "resync-required",
            reason: "expired-cursor",
            eventId: `${conversationId}/resync`,
            conversationId,
            revision: state.revision,
            cursor: state.cursor,
          };
          return;
        }
        while (!closed && !signal?.aborted) {
          const event = events[position];
          if (event) {
            position++;
            yield structuredClone(event);
            continue;
          }
          await new Promise<void>((resolve) => {
            const wake = () => {
              waiting.delete(wake);
              signal?.removeEventListener("abort", wake);
              resolve();
            };
            wakePending = wake;
            waiting.add(wake);
            signal?.addEventListener("abort", wake, { once: true });
            if (closed || signal?.aborted) wake();
          });
        }
      })();
      return {
        [Symbol.asyncIterator]() {
          return {
            next: () => source.next(),
            return: () => {
              closed = true;
              wakePending();
              return source.return();
            },
          };
        },
      };
    },
  };

  /** Explicit deterministic scheduler: no timers or model/provider calls. */
  function advance(
    submissionId: string,
    outcome: Exclude<Outcome, "accepted">,
    text = "Synthetic worker result",
  ) {
    const submission = lookup(submissionId);
    if (isTerminal(submission.outcome)) fail("conflict");
    if (outcome === "streaming" || outcome === "completed") {
      const id = `${submissionId}/assistant`;
      const prior = state.messages.find((item) => item.id === id);
      append({
        kind: "message",
        message: {
          id,
          submissionId,
          role: "assistant",
          createdAt: FIXTURE_TIME,
          revision: prior ? prior.revision + 1 : 0,
          blocks: [{ id: `${id}/text`, kind: "text", text }],
        },
      });
    }
    append({ kind: "submission", submission: { ...submission, outcome } });
  }
  return { adapter, advance, conversationId };
}
