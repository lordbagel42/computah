import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  createTraceCarrier,
  currentTraceHeaders,
  traceEvent,
  traceOperation,
} from "@computah/observability";
import { effectTracing } from "@computah/observability/effect";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { applyImmutable } from "@earendil-works/chord/delta";
import {
  type ConversationId,
  type ConversationView,
  type Cursor,
  createRegistry,
  defineDoc,
  defineDocFamily,
  defineExtension,
  defineTask,
  defineTool,
  type Harness,
  LiveDoc,
  type SubmissionId,
  type SubmissionRecord,
  type TaskId,
  type Tx,
} from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import {
  type PiOptions,
  type PiPromptResult,
  type PiViewFrame,
  pi,
} from "@rivet-dev/pi";
import { Effect } from "effect";
import { type Client, setup } from "rivetkit";
import { createClient } from "rivetkit/client";
import {
  axiomInstructions,
  createAxiomMcp,
  createAxiomMcpExtension,
} from "./axiom-mcp.js";
import { createFileTools, type FileCapability } from "./files.js";
import {
  createOperations,
  createOperationsExtension,
  type OperationalTarget,
  operationalInstructions,
} from "./operations.js";
import { interactionInstructions, workerInstructions } from "./personality.js";
import {
  type SentinelDecision,
  type SentinelInput,
  sentinelAudit,
} from "./sentinel.js";
import { createTavily, createTavilyExtension } from "./tavily.js";

export type Scope = { tenantId: string; userId: string; agentId: string };
export type CoreObservation = {
  source: "interaction" | "worker";
  workerLabel: string | null;
  view: ConversationView;
  submission: SubmissionRecord | undefined;
};
export type Capability =
  | "task.send"
  | "history.read"
  | "operator.read"
  | "task.control"
  | "core.maintain"
  | "web.search"
  | "web.extract"
  | "operations.read"
  | FileCapability
  | "axiom.read";

export class CoreError extends Error {
  constructor(readonly code: "denied" | "invalid" | "conflict" | "runtime") {
    super(`Core ${code}`);
  }
}

const Binding = defineDoc<{ scope: Scope | null }>({
  kind: "computah.binding",
  version: 1,
  scope: "session",
  initial: () => ({ scope: null }),
  checkpointWhen: () => false,
});

// Conflict receipts and Pi admission commit atomically; this is not a second transcript.
const Receipt = defineDocFamily<
  {
    hash: string;
    submissionId: SubmissionId | null;
    cancelled?: boolean;
    operation?: {
      sequence: number;
      admittedAt: number;
      previousRequestId: string | null;
    };
  },
  null
>({
  kind: "computah.receipt",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({ hash: "", submissionId: null }),
  checkpointWhen: () => false,
});

const Operations = defineDoc<{
  sequence: number;
  tailRequestId: string | null;
}>({
  kind: "computah.operations",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ sequence: 0, tailRequestId: null }),
  checkpointWhen: () => false,
});

function carrierTrace(carrier?: Record<string, string>): string | null {
  const match = /^00-([a-f0-9]{32})-([a-f0-9]{16})-[a-f0-9]{2}$/.exec(
    carrier?.traceparent ?? "",
  );
  return match && !/^0+$/.test(match[1]) && !/^0+$/.test(match[2])
    ? match[1]
    : null;
}

async function operationalTarget(
  tx: Tx,
  record: SubmissionRecord,
  actorId: string,
): Promise<OperationalTarget> {
  const receipt = record.requestId
    ? await tx.doc(Receipt, record.requestId, null)
    : null;
  const answer =
    record.type === "input" && record.status === "done"
      ? await tx.entry(record.answer)
      : undefined;
  const task = answer?.byTaskId ? await tx.task(answer.byTaskId) : undefined;
  return {
    requestId: record.requestId ?? "",
    submissionId: record.id,
    actorId,
    conversationId: record.conversationId,
    status: record.status,
    entryId: record.entry ?? null,
    answerId:
      record.type === "input" && record.status === "done"
        ? record.answer
        : null,
    admittedAt: receipt?.operation
      ? new Date(receipt.operation.admittedAt).toISOString()
      : null,
    traceId: carrierTrace(record.trace),
    executionTraceId: carrierTrace(task?.trace),
    workerLinksOmitted: 0,
  };
}

type Delegation = {
  worker: string;
  requestId: string;
  inputs: SubmissionId[];
  submissionId?: SubmissionId;
  reviewTaskId?: TaskId;
  reviewCarrier?: Record<string, string>;
};
type SentinelReceipt = ReturnType<typeof sentinelAudit> & {
  mode: "monitor" | "preflight";
  enforcement: "allowed" | "fenced" | "settled";
};
type SentinelWork = {
  scope: Scope;
  conversationId: ConversationId;
  requestId: string;
  input: SentinelInput;
  mode: "monitor" | "preflight";
  carrier: Record<string, string>;
};
const Delegations = defineDoc<{
  calls: Record<string, Delegation>;
  cancelled: Record<string, boolean>;
  cancellations: Record<string, TaskId>;
  reviews?: Record<string, SentinelReceipt>;
}>({
  kind: "computah.delegations",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ calls: {}, cancelled: {}, cancellations: {} }),
  checkpointWhen: () => false,
});

function scopeKey(scope: Scope): string[] {
  const key = [scope.tenantId, scope.userId, scope.agentId];
  if (
    key.some((part) => typeof part !== "string" || !part || part.length > 200)
  ) {
    throw new CoreError("invalid");
  }
  return key;
}

function scopeOf(key: string[]): Scope {
  const [tenantId, userId, agentId] = key;
  const scope = { tenantId, userId, agentId };
  scopeKey(scope);
  return scope;
}

export function interactionId(scope: Scope): string {
  return JSON.stringify(["interaction", ...scopeKey(scope)]);
}

export function workerId(scope: Scope, label = "primary"): string {
  if (!label || label.length > 200) throw new CoreError("invalid");
  return JSON.stringify(["worker", ...scopeKey(scope), label]);
}

export interface CoreOptions {
  /** Stable server-only key, never a browser credential. Keep it across restarts. */
  connectionSecret: string;
  /** Must consult trusted standing grants, not model arguments or browser claims. */
  authorize(
    scope: Readonly<Scope>,
    capability: Capability,
  ): boolean | Promise<boolean>;
  model: NonNullable<PiOptions["model"]>;
  /** Defaults to model for explicitly injected local/test configurations. */
  workerModel?: NonNullable<PiOptions["model"]>;
  thinkingLevel?: PiOptions["thinkingLevel"];
  providers?: PiOptions["providers"];
  apiKeys?: PiOptions["apiKeys"];
  /** Host-only credential/test transport. Never model or ingress input. */
  tavily?: { apiKey: string; fetch?: typeof fetch };
  /** Separate dataset-scoped read credential; never reuse an ingest/MCP token. */
  operations?: { queryToken?: string; fetch?: typeof fetch };
  sentinel?: {
    ownerScope: Scope;
    reviews: readonly { scope: Scope; mode: "monitor" | "preflight" }[];
    review(input: SentinelInput): Promise<SentinelDecision>;
  };
  /** Operator-wide read access via dedicated member PAT, not dataset API tokens. */
  axiomMcp?: { pat?: string; orgId?: string; fetch?: typeof fetch };
  models?: PiOptions["models"];
  settings?: PiOptions["settings"];
}

async function stopSubmission(pi: Harness, submissionId: SubmissionId) {
  const root = await pi.root(BACKGROUND_CONTEXT);
  const record = await (
    await pi.submission(submissionId, BACKGROUND_CONTEXT)
  )?.status(BACKGROUND_CONTEXT);
  if (!record || record.conversationId !== root.id)
    throw new CoreError("denied");
  for (;;) {
    const withdrawn = await pi.abortSubmission(
      submissionId,
      BACKGROUND_CONTEXT,
      root.id,
    );
    if (withdrawn === "aborted" || withdrawn === "settled") return;
    if (withdrawn === "not_found") throw new CoreError("denied");
    // Withdrawal raced placement. Abort and join the actual run, not a stale queued snapshot.
    const live = await pi.snapshot(LiveDoc, root.id, BACKGROUND_CONTEXT);
    if (live?.run?.inputs.includes(submissionId)) {
      await pi.abortTask(live.run.taskId, BACKGROUND_CONTEXT);
      await pi.waitForTask(live.run.taskId, BACKGROUND_CONTEXT);
    }
  }
}

/** Private actor registry plus server-side, scope-bound gateway. No public auth ingress. */
export function createCore(options: CoreOptions) {
  if (Buffer.byteLength(options.connectionSecret) < 32)
    throw new CoreError("invalid");
  const permit = async (scope: Scope, capability: Capability) => {
    if (!(await options.authorize(Object.freeze({ ...scope }), capability))) {
      throw new CoreError("denied");
    }
  };
  const token = (role: string, key: string[]) =>
    createHmac("sha256", options.connectionSecret)
      .update(JSON.stringify([role, ...key]))
      .digest("hex");
  const guard = (role: string) => (c: { key: string[] }, params: unknown) => {
    const provided = (params as { token?: unknown } | null)?.token;
    if (typeof provided !== "string") throw new CoreError("denied");
    const expected = Buffer.from(token(role, c.key));
    const actual = Buffer.from(provided);
    if (
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    ) {
      throw new CoreError("denied");
    }
  };

  // A background Pi task keeps a cancellation alive across gateway disconnects/reopens.
  const cancelDelegated = defineTask<
    {
      scope: Scope;
      runId: TaskId;
      links: Delegation[];
      inputs?: SubmissionId[];
      carrier?: Record<string, string>;
    },
    { phase: "cancel" },
    null
  >({
    name: "computah.cancel",
    version: 1,
    initial: () => ({ phase: "cancel" }),
    phases: {
      cancel: async (task, runtime, context) =>
        traceOperation(
          task.input.carrier ? "sentinel.cancel" : "cancel",
          async (span) => {
            const { scope, runId, links } = task.input;
            try {
              const actor = handle(
                controlClient(),
                "interaction",
                scopeKey(scope),
              );
              if (task.input.inputs)
                await actor.cancelInputs(task.input.inputs);
              else await actor.harness.abortTask(runId);
              for (const link of links) {
                await handle(controlClient(), "worker", [
                  ...scopeKey(scope),
                  link.worker,
                ]).cancelRequest(link.requestId);
              }
              if (!task.input.inputs) await actor.harness.waitForTask(runId);
            } catch {
              // RPC failure must not become a terminal faulted cancellation. All steps replay safely.
              await runtime.sleepUntil(
                Date.now() + 1000,
                { phase: "cancel" },
                context,
              );
              return;
            }
            await runtime.commit(
              () => ({
                status: "terminal",
                outcome: { status: "completed", result: null },
              }),
              context,
            );
            span.setAttribute("outcome", "cancelled");
          },
          task.input.carrier,
        ),
    },
    abort: async (_task, runtime, context) => {
      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "aborted" } }),
        context,
      );
    },
  });

  // Only categorical receipts live here, beside the existing cancellation fence.
  // A late monitor verdict must never cancel a successor run on the same Worker.
  async function recordReview(
    tx: Tx,
    work: SentinelWork,
    decision: SentinelDecision,
  ) {
    const state = await tx.doc(Delegations, work.conversationId);
    state.reviews ??= {};
    const existing = state.reviews[work.requestId];
    if (existing) return existing;
    const live = await tx.doc(LiveDoc, work.conversationId);
    const original = state.calls[work.requestId]?.inputs ?? [];
    const active = original.some((id) => live.run?.inputs.includes(id));
    const receipt: SentinelReceipt = {
      ...sentinelAudit(decision),
      mode: work.mode,
      enforcement:
        decision.action === "allow" ? "allowed" : active ? "fenced" : "settled",
    };
    state.reviews[work.requestId] = receipt;
    if (decision.action !== "allow" && active && live.run) {
      for (const id of live.run.inputs) state.cancelled[String(id)] = true;
      let taskId = live.run.inputs
        .map((id) => state.cancellations[String(id)])
        .find(Boolean);
      if (!taskId) {
        const links = Object.values(state.calls).filter((link) =>
          link.inputs.some((id) => live.run?.inputs.includes(id)),
        );
        taskId = await tx.createTask(
          cancelDelegated,
          {
            scope: work.scope,
            runId: live.run.taskId,
            inputs: [...live.run.inputs],
            links,
            carrier: work.carrier,
          },
          { ownership: { kind: "conversation" }, background: true },
        );
      }
      for (const id of live.run.inputs)
        state.cancellations[String(id)] = taskId;
    }
    return receipt;
  }
  async function reviewWork(work: SentinelWork) {
    return traceOperation(
      "sentinel.review",
      async (span) => {
        let decision: SentinelDecision;
        try {
          if (!work.input.evidence.length || !options.sentinel)
            throw new CoreError("invalid");
          decision = await options.sentinel.review(work.input);
        } catch {
          decision = {
            action: work.mode === "preflight" ? "pause" : "allow",
            reason: "review-unavailable",
            evidence: [],
            scope: { reviewId: work.input.reviewId, stage: work.input.stage },
          };
        }
        span.setAttributes({
          action: decision.action,
          reason: decision.reason,
          mode: work.mode,
        });
        return decision;
      },
      work.carrier,
    );
  }
  const sentinelTask = defineTask<SentinelWork, { phase: "review" }, null>({
    name: "computah.sentinel",
    version: 1,
    initial: () => ({ phase: "review" }),
    phases: {
      review: async (task, runtime, context) => {
        const decision = await reviewWork(task.input);
        await traceOperation(
          "sentinel.enforce",
          async (span) => {
            let enforcement: SentinelReceipt["enforcement"] = "settled";
            await runtime.commit(async (tx) => {
              enforcement = (await recordReview(tx, task.input, decision))
                .enforcement;
              return {
                status: "terminal",
                outcome: { status: "completed", result: null },
              } as const;
            }, context);
            // The durable transaction, not telemetry, owns the decision.
            span.setAttributes({
              mode: task.input.mode,
              action: decision.action,
              reason: decision.reason,
              outcome: enforcement,
            });
          },
          task.input.carrier,
        );
      },
    },
    abort: async (_task, runtime, context) => {
      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "aborted" } }),
        context,
      );
    },
  });
  const interactionTools = createRegistry();
  interactionTools.install(
    defineExtension({
      name: "computah.task",
      tasks: [cancelDelegated, sentinelTask],
      tools: [
        defineTool({
          name: "Task",
          description:
            "Delegate to a persistent Worker. Reuse the same worker label for follow-ups.",
          parameters: obj({ worker: str(), text: str() }),
          // Replaying this RPC is safe because the Worker durably deduplicates this tool task ID.
          replay: "safe",
          execute: async (args, api, context) => {
            const binding = await api.snapshot(Binding, context);
            if (!binding?.scope) throw new CoreError("denied");
            const scope = binding.scope;
            const sentinel = options.sentinel;
            await permit(binding.scope, "task.send");
            workerId(binding.scope, args.worker);
            const requestId = `task:${api.taskId}`;
            const selected = sentinel?.reviews.find(
              (policy) =>
                JSON.stringify(scopeKey(policy.scope)) ===
                JSON.stringify(scopeKey(scope)),
            );
            const carrier = currentTraceHeaders();
            const work = await api.commit(async (tx) => {
              const state = await tx.doc(Delegations, api.conversationId);
              const live = await tx.doc(LiveDoc, api.conversationId);
              const inputs = live.run?.inputs ?? [];
              if (
                !inputs.length ||
                inputs.some((id) => state.cancelled[String(id)])
              )
                throw new CoreError("denied");
              state.calls[requestId] ??= {
                worker: args.worker,
                requestId,
                inputs: [...inputs],
              };
              if (!selected || !sentinel || !live.run) return null;
              state.calls[requestId].reviewCarrier ??= carrier.traceparent
                ? carrier
                : createTraceCarrier("sentinel.review");
              const work: SentinelWork = {
                scope,
                conversationId: api.conversationId,
                requestId,
                carrier: { ...state.calls[requestId].reviewCarrier },
                mode: selected.mode,
                input: {
                  reviewId: requestId,
                  stage: "tool-intent",
                  policy:
                    selected.mode === "preflight"
                      ? "risky-effect"
                      : "benign-monitor",
                  principal:
                    JSON.stringify(scopeKey(sentinel.ownerScope)) ===
                    JSON.stringify(scopeKey(scope))
                      ? "owner"
                      : "other-user",
                  evidence:
                    args.text.length <= 12_000
                      ? [{ id: "task", source: "assistant", text: args.text }]
                      : [],
                },
              };
              if (
                selected.mode === "monitor" &&
                !state.calls[requestId].reviewTaskId
              )
                state.calls[requestId].reviewTaskId = await tx.createTask(
                  sentinelTask,
                  work,
                  { ownership: { kind: "conversation" }, background: true },
                );
              return work;
            }, context);
            if (work?.mode === "preflight") {
              const previous = (
                await api.snapshot(Delegations, api.conversationId, context)
              )?.reviews?.[requestId];
              if (!previous) {
                const decision = await reviewWork(work);
                await traceOperation(
                  "sentinel.enforce",
                  async (span) => {
                    const receipt = await api.commit(
                      (tx) => recordReview(tx, work, decision),
                      BACKGROUND_CONTEXT,
                    );
                    span.setAttributes({
                      action: receipt.action,
                      reason: receipt.reason,
                      outcome: receipt.enforcement,
                      mode: receipt.mode,
                    });
                  },
                  work.carrier,
                );
              }
            }
            await permit(binding.scope, "task.send");
            // Close review/revocation/cancellation races before the remote admit;
            // the existing cancelRequest tombstone closes the later RPC race.
            await api.commit(async (tx) => {
              const state = await tx.doc(Delegations, api.conversationId);
              const link = state.calls[requestId];
              const live = await tx.doc(LiveDoc, api.conversationId);
              if (
                !live.run ||
                !link.inputs.every((id) => live.run?.inputs.includes(id)) ||
                link.inputs.some((id) => state.cancelled[String(id)])
              )
                throw new CoreError("denied");
            }, context);
            const result = await dispatch(
              binding.scope,
              args.worker,
              args.text,
              requestId,
              context.abortSignal,
              (submissionId) =>
                api.commit(async (tx) => {
                  (await tx.doc(Delegations, api.conversationId)).calls[
                    requestId
                  ].submissionId = submissionId;
                }, context),
            );
            if (result.status !== "done") throw new CoreError("runtime");
            return { output: [{ type: "text", text: result.text ?? "" }] };
          },
        }),
      ],
    }),
  );

  const tavily = createTavily({
    ...options.tavily,
    authorize: options.authorize,
  });
  const tavilyExtension = createTavilyExtension({
    client: tavily,
    scope: async (api, context) =>
      (await api.snapshot(Binding, context))?.scope ?? null,
  });
  const workerTools = createRegistry();
  if (options.tavily) workerTools.install(tavilyExtension);
  const files = createFileTools({
    authorize: options.authorize,
    scope: async (api, context) =>
      (await api.snapshot(Binding, context))?.scope ?? null,
  });
  workerTools.install(files.extension);

  if (options.axiomMcp) {
    interactionTools.install(
      createAxiomMcpExtension({
        client: createAxiomMcp({
          ...options.axiomMcp,
          authorize: options.authorize,
        }),
        scope: async (api, context) =>
          (await api.snapshot(Binding, context))?.scope ?? null,
      }),
    );
  }

  if (options.operations) {
    const operations = createOperations({
      ...options.operations,
      authorize: options.authorize,
    });
    interactionTools.install(
      createOperationsExtension({
        client: operations,
        scope: async (api, context) =>
          (await api.snapshot(Binding, context))?.scope ?? null,
        target: async (requestId, api, context) => {
          const binding = await api.snapshot(Binding, context);
          if (!binding?.scope) throw new CoreError("denied");
          const targetScope = binding.scope;
          await permit(binding.scope, "operations.read");
          const memo = await api.memo("computah.operations.target.v1", context);
          if (memo) return memo as OperationalTarget[];
          const selected = await api.commit(async (tx) => {
            const live = await tx.doc(LiveDoc, api.conversationId);
            const index = await tx.doc(Operations, api.conversationId);
            const inputs = live.run?.inputs ?? [];
            if (!inputs.length) return null;
            const nodes: {
              requestId: string;
              sequence: number;
              submissionId: SubmissionId | null;
            }[] = [];
            let cursor = index.tailRequestId;
            for (let count = 0; cursor && count < 256; count++) {
              const receipt = await tx.doc(Receipt, cursor, null);
              if (!receipt.operation) break;
              nodes.push({
                requestId: cursor,
                sequence: receipt.operation.sequence,
                submissionId: receipt.submissionId,
              });
              cursor = receipt.operation.previousRequestId;
            }
            const active = nodes.filter(
              (node) =>
                node.submissionId !== null &&
                inputs.includes(node.submissionId),
            );
            if (active.length !== inputs.length) return null;
            const boundary = Math.min(...active.map((node) => node.sequence));
            const candidates =
              requestId === "previous"
                ? nodes
                : [
                    {
                      requestId,
                      sequence:
                        (await tx.doc(Receipt, requestId, null)).operation
                          ?.sequence ?? Infinity,
                    },
                  ];
            for (const node of candidates) {
              if (node.sequence >= boundary) continue;
              const record = await tx.submissionByRequest(
                api.conversationId,
                node.requestId,
              );
              if (record?.type === "input" && record.status === "done") {
                const links = Object.values(
                  (await tx.doc(Delegations, api.conversationId)).calls,
                ).filter((link) => link.inputs.includes(record.id));
                return {
                  target: await operationalTarget(
                    tx,
                    record,
                    interactionId(targetScope),
                  ),
                  links: links.map((link) => ({
                    worker: link.worker,
                    requestId: link.requestId,
                  })),
                };
              }
            }
            return null;
          }, context);
          if (!selected) return [];
          const targets = [selected.target];
          for (const link of selected.links.slice(0, 20)) {
            const target = await handle(
              controlClient(),
              "worker",
              [...scopeKey(binding.scope), link.worker],
              context.abortSignal,
            ).operationContext(link.requestId);
            if (target) targets.push(target);
          }
          targets[0].workerLinksOmitted =
            selected.links.length - (targets.length - 1);
          await permit(binding.scope, "operations.read");
          return (await api.memo(
            "computah.operations.target.v1",
            targets,
            context,
          )) as OperationalTarget[];
        },
      }),
    );
  }

  const common = {
    model: options.model,
    thinkingLevel: options.thinkingLevel,
    providers: options.providers,
    apiKeys: options.apiKeys,
    models: options.models,
    settings: options.settings,
    // No host environment or whole CodingTools extension: files remain in each actor DB.
    onWake: async (c: { key: string[]; pi: Harness }) => {
      const scope = scopeOf(c.key);
      await c.pi.commit(async (tx) => {
        const binding = await tx.doc(Binding);
        if (
          binding.scope &&
          JSON.stringify(binding.scope) !== JSON.stringify(scope)
        ) {
          throw new CoreError("denied");
        }
        binding.scope = scope;
      }, BACKGROUND_CONTEXT);
    },
    // Log categories only; SDK reports can contain model/tool content.
    onReport: () => {
      console.warn("computah.pi.report");
      traceEvent("report");
    },
    actions: {
      sleep: (c: { sleep(): void }) => {
        c.sleep();
      },
      admit: async (
        c: { key: string[]; pi: Harness },
        text: string,
        requestId: string,
      ) => {
        await permit(scopeOf(c.key), "task.send");
        if (
          !text.trim() ||
          !requestId ||
          text.length > 100_000 ||
          requestId.length > 240
        )
          throw new CoreError("invalid");
        const root = await c.pi.root(BACKGROUND_CONTEXT);
        const hash = createHash("sha256").update(text).digest("hex");
        return root.commit(async (tx) => {
          const receipt = await tx.doc(Receipt, requestId, null);
          if (receipt.submissionId !== null) {
            return receipt.hash === hash
              ? { submissionId: receipt.submissionId }
              : { conflict: true as const };
          }
          if (receipt.cancelled) return { cancelled: true as const };
          const operations = await tx.doc(Operations, root.id);
          const id = await root.submit(tx, {
            type: "input",
            content: text,
            requestId,
            whenBusy: "followUp",
          });
          receipt.hash = hash;
          receipt.submissionId = id;
          receipt.operation = {
            sequence: operations.sequence + 1,
            admittedAt: Date.now(),
            previousRequestId: operations.tailRequestId,
          };
          operations.sequence++;
          operations.tailRequestId = requestId;
          return { submissionId: id };
        }, BACKGROUND_CONTEXT);
      },
      operationContext: async (
        c: { key: string[]; pi: Harness },
        requestId: string,
      ) => {
        await permit(scopeOf(c.key), "operations.read");
        const root = await c.pi.root(BACKGROUND_CONTEXT);
        const target = await root.commit(async (tx) => {
          const record = await tx.submissionByRequest(root.id, requestId);
          return record
            ? operationalTarget(
                tx,
                record,
                JSON.stringify([
                  c.key.length === 4 ? "worker" : "interaction",
                  ...c.key,
                ]),
              )
            : null;
        }, BACKGROUND_CONTEXT);
        await permit(scopeOf(c.key), "operations.read");
        return target;
      },
      delegations: async (c: { pi: Harness }, submissionId: SubmissionId) => {
        const root = await c.pi.root(BACKGROUND_CONTEXT);
        return Object.values(
          (await c.pi.snapshot(Delegations, root.id, BACKGROUND_CONTEXT))
            ?.calls ?? {},
        ).filter((link) => link.inputs.includes(submissionId));
      },
      sentinelAudits: async (
        c: { pi: Harness },
        submissionId: SubmissionId,
      ) => {
        const root = await c.pi.root(BACKGROUND_CONTEXT);
        const state = await c.pi.snapshot(
          Delegations,
          root.id,
          BACKGROUND_CONTEXT,
        );
        return Object.entries(state?.calls ?? {})
          .filter(([, link]) => link.inputs.includes(submissionId))
          .flatMap(([id]) => (state?.reviews?.[id] ? [state.reviews[id]] : []));
      },
      awaitCancellation: async (
        c: { pi: Harness },
        submissionId: SubmissionId,
      ) => {
        const root = await c.pi.root(BACKGROUND_CONTEXT);
        const taskId = (
          await c.pi.snapshot(Delegations, root.id, BACKGROUND_CONTEXT)
        )?.cancellations[String(submissionId)];
        if (
          taskId &&
          (await c.pi.waitForTask(taskId, BACKGROUND_CONTEXT)).state.outcome
            .status !== "completed"
        )
          throw new CoreError("runtime");
      },
      requestSubmission: async (c: { pi: Harness }, requestId: string) =>
        (await c.pi.snapshot(Receipt, requestId, BACKGROUND_CONTEXT))
          ?.submissionId ?? null,
      cancelRequest: async (c: { pi: Harness }, requestId: string) => {
        const root = await c.pi.root(BACKGROUND_CONTEXT);
        const submissionId = await root.commit(async (tx) => {
          const receipt = await tx.doc(Receipt, requestId, null);
          receipt.cancelled = true;
          return receipt.submissionId;
        }, BACKGROUND_CONTEXT);
        if (submissionId !== null) await stopSubmission(c.pi, submissionId);
      },
      cancelInputs: async (c: { pi: Harness }, inputs: SubmissionId[]) => {
        for (const id of inputs) await stopSubmission(c.pi, id);
      },
      cancelCascade: async (
        c: { key: string[]; pi: Harness },
        submissionId: SubmissionId,
      ) => {
        const root = await c.pi.root(BACKGROUND_CONTEXT);
        const record = await (
          await c.pi.submission(submissionId, BACKGROUND_CONTEXT)
        )?.status(BACKGROUND_CONTEXT);
        if (!record || record.conversationId !== root.id)
          throw new CoreError("denied");
        if (c.key.length === 4) {
          await stopSubmission(c.pi, submissionId);
          const final = await (
            await c.pi.submission(submissionId, BACKGROUND_CONTEXT)
          )?.status(BACKGROUND_CONTEXT);
          return final?.status === "unanswered" &&
            ["aborted", "withdrawn"].includes(final.reason)
            ? ("aborted" as const)
            : ("settled" as const);
        }
        // Withdraw atomically before inspecting active runs; placement cannot slip past this check.
        await c.pi.abortSubmission(submissionId, BACKGROUND_CONTEXT, root.id);
        const decision = await root.commit(async (tx) => {
          const state = await tx.doc(Delegations, root.id);
          const existing = state.cancellations[String(submissionId)];
          if (existing) return { taskId: existing };
          const live = await tx.doc(LiveDoc, root.id);
          if (!live.run?.inputs.includes(submissionId)) return {};
          for (const id of live.run.inputs) state.cancelled[String(id)] = true;
          const links = Object.values(state.calls).filter((link) =>
            link.inputs.some((id) => live.run?.inputs.includes(id)),
          );
          const taskId = await tx.createTask(
            cancelDelegated,
            {
              scope: scopeOf(c.key),
              runId: live.run.taskId,
              inputs: [...live.run.inputs],
              links,
            },
            { ownership: { kind: "conversation" }, background: true },
          );
          for (const id of live.run.inputs)
            state.cancellations[String(id)] = taskId;
          return { taskId };
        }, BACKGROUND_CONTEXT);
        if (decision.taskId) {
          const task = await c.pi.waitForTask(
            decision.taskId,
            BACKGROUND_CONTEXT,
          );
          if (task.state.outcome.status !== "completed")
            throw new CoreError("runtime");
        } else {
          await stopSubmission(c.pi, submissionId);
        }
        const final = await (
          await c.pi.submission(submissionId, BACKGROUND_CONTEXT)
        )?.status(BACKGROUND_CONTEXT);
        return final?.status === "unanswered" &&
          ["aborted", "withdrawn"].includes(final.reason)
          ? ("aborted" as const)
          : final?.status === "done" || final?.status === "unanswered"
            ? ("settled" as const)
            : ("already_placed" as const);
      },
    },
  };
  const interaction = pi({
    ...common,
    documents: [Delegations, Operations],
    registry: interactionTools,
    onBeforeConnect: guard("interaction"),
    onWake: async (c) => {
      await common.onWake(c);
      const root = await c.pi.root(BACKGROUND_CONTEXT);
      await root.configure(
        {
          instructions:
            (options.operations
              ? `${interactionInstructions}\n\n${operationalInstructions}`
              : interactionInstructions) +
            (options.axiomMcp ? `\n\n${axiomInstructions}` : ""),
          model: modelRef(options.model),
          ...(options.thinkingLevel
            ? { thinkingLevel: options.thinkingLevel }
            : {}),
        },
        BACKGROUND_CONTEXT,
      );
    },
  });
  const worker = pi({
    ...common,
    model: options.workerModel ?? options.model,
    registry: workerTools,
    onBeforeConnect: guard("worker"),
    onWake: async (c) => {
      await common.onWake(c);
      const capabilities = await tavily.capabilities(scopeOf(c.key));
      const fileTools = await files.available(scopeOf(c.key));
      const tools = (tavilyExtension.tools ?? []).filter((tool) =>
        capabilities.includes(
          tool.name === "web_search" ? "web.search" : "web.extract",
        ),
      );
      const root = await c.pi.root(BACKGROUND_CONTEXT);
      await root.configure(
        {
          tools: [...tools, ...fileTools],
          instructions: workerInstructions,
          model: modelRef(options.workerModel ?? options.model),
          ...(options.thinkingLevel
            ? { thinkingLevel: options.thinkingLevel }
            : {}),
        },
        BACKGROUND_CONTEXT,
      );
    },
  });
  const registry = setup({ use: { interaction, worker } });
  let internalClient: Client<typeof registry> | undefined;
  const handle = (
    client: Client<typeof registry>,
    role: "interaction" | "worker",
    key: string[],
    signal?: AbortSignal,
  ) =>
    client[role].getOrCreate(key, {
      params: { token: token(role, key) },
      signal,
    });

  function controlClient() {
    if (!internalClient) {
      const config = registry.parseConfig();
      internalClient = createClient<typeof registry>({
        endpoint: config.endpoint,
        namespace: config.namespace,
        token: config.token,
        poolName: config.node.poolName,
        headers: config.headers,
        disableMetadataLookup: true,
      });
    }
    return internalClient;
  }

  // Actor recovery must not depend on a browser/gateway connection attaching first.
  async function dispatch(
    scope: Scope,
    label: string,
    text: string,
    requestId: string,
    signal?: AbortSignal,
    admittedCallback?: (id: SubmissionId) => Promise<unknown>,
  ): Promise<PiPromptResult> {
    const actor = handle(
      controlClient(),
      "worker",
      [...scopeKey(scope), label],
      signal,
    );
    const admitted = await actor.admit(text, requestId);
    if ("conflict" in admitted) throw new CoreError("conflict");
    if ("cancelled" in admitted) throw new CoreError("denied");
    await admittedCallback?.(admitted.submissionId);
    const result = await actor.submission.wait(admitted.submissionId);
    if (result.status !== "done" || result.type !== "input")
      return {
        status: "unanswered",
        reason: result.reason ?? "no_answer",
        submissionId: result.id,
      };
    const answer = await actor.conversation.entries(
      result.conversationId,
      { minEntryId: result.answer, maxEntryId: result.answer },
      1,
    );
    const textResult = answer.items
      .flatMap((entry) => entry.model ?? [])
      .flatMap((message) =>
        message.role === "assistant"
          ? message.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
          : [],
      )
      .join("");
    return { status: "done", text: textResult, submissionId: result.id };
  }

  function attach(client: Client<typeof registry>) {
    /** Call only after authenticating the user on the server; never bind request-body identities. */
    return function bind(trustedScope: Scope) {
      const scope = Object.freeze({ ...trustedScope });
      const ownedKey = scopeKey(scope);
      const resolve = async (
        id: string,
        capability: Capability,
        signal?: AbortSignal,
        existingOnly = false,
      ) => {
        let parts: unknown;
        try {
          parts = JSON.parse(id);
        } catch {
          throw new CoreError("invalid");
        }
        if (
          !Array.isArray(parts) ||
          !parts.every((part) => typeof part === "string")
        )
          throw new CoreError("invalid");
        const [role, ...key] = parts as string[];
        if (
          (role !== "interaction" || key.length !== 3) &&
          (role !== "worker" || key.length !== 4)
        )
          throw new CoreError("invalid");
        if (key.slice(0, 3).some((part, i) => part !== ownedKey[i]))
          throw new CoreError("denied");
        await permit(scope, capability);
        if (existingOnly)
          return client[role as "interaction" | "worker"].get(key, {
            params: { token: token(role, key) },
            signal,
          });
        return handle(client, role as "interaction" | "worker", key, signal);
      };
      const run = <T>(operation: string, body: () => Promise<T>) =>
        Effect.runPromise(
          Effect.tryPromise({
            try: body,
            catch: (error) =>
              error instanceof CoreError ? error : new CoreError("runtime"),
          }).pipe(
            Effect.withSpan(`computah.${operation}`),
            Effect.provide(effectTracing),
          ),
        );
      return {
        interactionId: interactionId(scope),
        workerId: (label = "primary") => workerId(scope, label),
        submit: (
          id: string,
          text: string,
          requestId: string,
          signal?: AbortSignal,
        ) =>
          run("submit", async () => {
            if (
              !text.trim() ||
              !requestId ||
              text.length > 100_000 ||
              requestId.length > 200
            )
              throw new CoreError("invalid");
            const actor = await resolve(id, "task.send", signal);
            const admitted = await actor.admit(text, `input:${requestId}`);
            if ("conflict" in admitted) throw new CoreError("conflict");
            if ("cancelled" in admitted) throw new CoreError("denied");
            return admitted;
          }),
        wait: (id: string, submissionId: SubmissionId, signal?: AbortSignal) =>
          run("wait", async () => {
            const actor = await resolve(id, "history.read", signal);
            // Each actor has one root; submissions must also belong to it.
            const root = await actor.harness.root();
            const record = await actor.harness.submission(submissionId);
            if (!record || record.conversationId !== root.id)
              throw new CoreError("denied");
            const settled = await actor.submission.wait(submissionId);
            await actor.awaitCancellation(submissionId);
            return settled;
          }),
        result: (
          id: string,
          submissionId: SubmissionId,
          wait = false,
          signal?: AbortSignal,
        ) =>
          run("result", async () => {
            const actor = await resolve(id, "history.read", signal);
            const root = await actor.harness.root();
            const record = await actor.harness.submission(submissionId);
            if (!record || record.conversationId !== root.id)
              throw new CoreError("denied");
            const submission = wait
              ? await actor.submission.wait(submissionId)
              : record;
            if (submission.status === "unanswered")
              await actor.awaitCancellation(submissionId);
            const entries =
              submission.status === "done" && submission.type === "input"
                ? (
                    await actor.conversation.entries(
                      root.id,
                      {
                        minEntryId: submission.answer,
                        maxEntryId: submission.answer,
                      },
                      1,
                    )
                  ).items
                : [];
            await permit(scope, "history.read");
            return { submission, entries };
          }),
        /** Private native views. Never send these objects across the public boundary. */
        observe: async function* (
          submissionId: SubmissionId,
          signal: AbortSignal,
        ) {
          const actor = await resolve(
            interactionId(scope),
            "history.read",
            signal,
          );
          const root = await actor.harness.root();
          const record = await actor.harness.submission(submissionId);
          if (!record || record.conversationId !== root.id)
            throw new CoreError("denied");
          const views = new Map<string, CoreObservation>();
          const stops: (() => Promise<void>)[] = [];
          let dirty = true;
          let failure: unknown;
          let notify: (() => void) | undefined;
          const workerRequests = new Map<string, string>();
          const changed = () => {
            dirty = true;
            notify?.();
          };
          const fail = (error: unknown) => {
            failure = error;
            changed();
          };
          const attachView = async (
            id: string,
            source: "interaction" | "worker",
            workerLabel: string | null,
            requestId?: string,
          ) => {
            const target = await resolve(id, "history.read", signal);
            const conversation = await target.harness.root();
            const conn = target.connect();
            let interrupt: () => void = () => {};
            const interrupted = new Promise<never>((_, reject) => {
              interrupt = () => reject(new CoreError("runtime"));
            });
            void interrupted.catch(() => {});
            const local = <T>(pending: Promise<T>) =>
              Promise.race([pending, interrupted]);
            const dispose = () => {
              interrupt();
              void conn.dispose();
            };
            signal.addEventListener("abort", dispose, { once: true });
            if (signal.aborted) dispose();
            stops.push(async () => {
              signal.removeEventListener("abort", dispose);
              await conn.dispose();
            });
            let value: ConversationView | undefined;
            let sequence = 0;
            let pending: PiViewFrame[] = [];
            let refresh: Promise<void> | undefined;
            const accept = (frame: PiViewFrame) => {
              if (!value) {
                pending.push(frame);
                return;
              }
              if (frame.seq === 0 && frame.value) {
                value = frame.value;
                sequence = 1;
              } else if (frame.seq === sequence && frame.ops) {
                value = applyImmutable(value, frame.ops);
                sequence++;
              } else {
                // Native gaps are repaired from the authoritative full view, never guessed.
                if (!refresh)
                  refresh = conn.conversation
                    .watch(conversation.id)
                    .then((initial) => {
                      value = initial.value;
                      sequence = 1;
                      views.set(id, {
                        source,
                        workerLabel,
                        view: value,
                        submission: views.get(id)?.submission,
                      });
                      changed();
                    })
                    .catch(fail)
                    .finally(() => {
                      refresh = undefined;
                    });
                return;
              }
              const current = views.get(id);
              views.set(id, {
                source,
                workerLabel,
                view: value,
                submission: current?.submission,
              });
              changed();
            };
            conn.on("pi.view", (frame) => {
              try {
                accept(frame as PiViewFrame);
              } catch (error) {
                fail(error);
              }
            });
            conn.onError(fail);
            await local(conn.ready);
            if (source === "interaction") {
              conn.on("pi.doc", changed);
              await local(
                conn.harness.watchDoc(
                  Delegations.definition.kind,
                  conversation.id,
                ),
              );
            }
            const initial = await local(
              conn.conversation.watch(conversation.id),
            );
            value = initial.value;
            sequence = 1;
            views.set(id, {
              source,
              workerLabel,
              view: value,
              submission: undefined,
            });
            for (const frame of pending) accept(frame);
            pending = [];
            return async () => {
              const latestRequest = workerRequests.get(id) ?? requestId;
              const nativeId = latestRequest
                ? await target.requestSubmission(latestRequest)
                : submissionId;
              const current = views.get(id);
              if (current)
                current.submission =
                  nativeId === null
                    ? undefined
                    : await target.harness.submission(nativeId);
            };
          };
          const updaters = new Map<string, () => Promise<void>>();
          const aborted = () => notify?.();
          signal.addEventListener("abort", aborted, { once: true });
          try {
            updaters.set(
              interactionId(scope),
              await attachView(interactionId(scope), "interaction", null),
            );
            while (!signal.aborted) {
              if (!dirty)
                await new Promise<void>((done) => {
                  notify = done;
                  if (dirty || signal.aborted) done();
                });
              notify = undefined;
              if (signal.aborted) break;
              if (failure) throw new CoreError("runtime");
              dirty = false;
              for (const link of await actor.delegations(submissionId)) {
                const id = workerId(scope, link.worker);
                workerRequests.set(id, link.requestId);
                // Several calls may reuse the same Worker; latest link is the current observation.
                if (!updaters.has(id))
                  updaters.set(
                    id,
                    await attachView(id, "worker", link.worker, link.requestId),
                  );
              }
              await Promise.all(
                [...updaters.values()].map((update) => update()),
              );
              await permit(scope, "history.read");
              yield [...views.values()];
            }
          } finally {
            signal.removeEventListener("abort", aborted);
            await Promise.allSettled(stops.map((stop) => stop()));
          }
        },
        operatorHistory: (id: string, cursor?: Cursor, signal?: AbortSignal) =>
          run("operator.history", async () => {
            await permit(scope, "history.read");
            const actor = await resolve(id, "operator.read", signal, true);
            try {
              const root = await actor.harness.root();
              const page = await actor.conversation.entries(
                root.id,
                { order: "ascending" },
                100,
                cursor,
              );
              await permit(scope, "history.read");
              await permit(scope, "operator.read");
              return page;
            } catch (error) {
              await permit(scope, "history.read");
              await permit(scope, "operator.read");
              if (
                error &&
                typeof error === "object" &&
                "group" in error &&
                error.group === "actor" &&
                "code" in error &&
                error.code === "not_found"
              )
                return null;
              throw error;
            }
          }),
        history: (id: string, cursor?: Cursor, signal?: AbortSignal) =>
          run("history", async () => {
            const actor = await resolve(id, "history.read", signal);
            const root = await actor.harness.root();
            return actor.conversation.entries(
              root.id,
              { order: "ascending" },
              100,
              cursor,
            );
          }),
        cancel: (id: string, submissionId: SubmissionId) =>
          run("cancel", async () => {
            const actor = await resolve(id, "task.control");
            return actor.cancelCascade(submissionId);
          }),
        sentinelAudits: (id: string, submissionId: SubmissionId) =>
          run("history", async () => {
            const actor = await resolve(id, "history.read");
            const root = await actor.harness.root();
            const record = await actor.harness.submission(submissionId);
            if (!record || record.conversationId !== root.id)
              throw new CoreError("denied");
            const audits = await actor.sentinelAudits(submissionId);
            await permit(scope, "history.read");
            return audits;
          }),
        compact: (id: string) =>
          run("compact", async () => {
            const actor = await resolve(id, "core.maintain");
            const root = await actor.harness.root();
            const task = await actor.conversation.compact(root.id);
            return actor.harness.waitForTask(task);
          }),
        sleep: (id: string) =>
          run("sleep", async () => {
            await (await resolve(id, "core.maintain")).sleep();
          }),
      };
    };
  }
  return {
    registry,
    attach,
    close: async () => {
      await registry.shutdown();
      await internalClient?.dispose();
    },
  };
}

export type CoreSession = ReturnType<
  ReturnType<ReturnType<typeof createCore>["attach"]>
>;

function modelRef(value: string) {
  const slash = value.indexOf("/");
  if (slash < 1 || slash === value.length - 1) throw new CoreError("invalid");
  return { provider: value.slice(0, slash), modelId: value.slice(slash + 1) };
}
