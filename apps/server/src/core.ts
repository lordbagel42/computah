import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { applyImmutable } from "@earendil-works/chord/delta";
import {
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
import { interactionInstructions, workerInstructions } from "./personality.js";

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
  | "task.control"
  | "core.maintain";

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
  { hash: string; submissionId: SubmissionId | null; cancelled?: boolean },
  null
>({
  kind: "computah.receipt",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({ hash: "", submissionId: null }),
  checkpointWhen: () => false,
});

type Delegation = {
  worker: string;
  requestId: string;
  inputs: SubmissionId[];
  submissionId?: SubmissionId;
};
const Delegations = defineDoc<{
  calls: Record<string, Delegation>;
  cancelled: Record<string, boolean>;
  cancellations: Record<string, TaskId>;
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
    { scope: Scope; runId: TaskId; links: Delegation[] },
    { phase: "cancel" },
    null
  >({
    name: "computah.cancel",
    version: 1,
    initial: () => ({ phase: "cancel" }),
    phases: {
      cancel: async (task, runtime, context) => {
        const { scope, runId, links } = task.input;
        try {
          const actor = handle(controlClient(), "interaction", scopeKey(scope));
          await actor.harness.abortTask(runId);
          for (const link of links) {
            await handle(controlClient(), "worker", [
              ...scopeKey(scope),
              link.worker,
            ]).cancelRequest(link.requestId);
          }
          await actor.harness.waitForTask(runId);
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
      tasks: [cancelDelegated],
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
            await permit(binding.scope, "task.send");
            workerId(binding.scope, args.worker);
            const requestId = `task:${api.taskId}`;
            await api.commit(async (tx) => {
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

  const common = {
    model: options.model,
    thinkingLevel: options.thinkingLevel,
    providers: options.providers,
    apiKeys: options.apiKeys,
    models: options.models,
    settings: options.settings,
    // Never install CodingTools or a host environment implicitly, including for the owner.
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
          const id = await root.submit(tx, {
            type: "input",
            content: text,
            requestId,
            whenBusy: "followUp",
          });
          receipt.hash = hash;
          receipt.submissionId = id;
          return { submissionId: id };
        }, BACKGROUND_CONTEXT);
      },
      delegations: async (c: { pi: Harness }, submissionId: SubmissionId) => {
        const root = await c.pi.root(BACKGROUND_CONTEXT);
        return Object.values(
          (await c.pi.snapshot(Delegations, root.id, BACKGROUND_CONTEXT))
            ?.calls ?? {},
        ).filter((link) => link.inputs.includes(submissionId));
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
            { scope: scopeOf(c.key), runId: live.run.taskId, links },
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
    documents: [Delegations],
    registry: interactionTools,
    onBeforeConnect: guard("interaction"),
    onWake: async (c) => {
      await common.onWake(c);
      const root = await c.pi.root(BACKGROUND_CONTEXT);
      await root.configure(
        {
          instructions: interactionInstructions,
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
    registry: createRegistry(),
    onBeforeConnect: guard("worker"),
    onWake: async (c) => {
      await common.onWake(c);
      const root = await c.pi.root(BACKGROUND_CONTEXT);
      await root.configure(
        {
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
        return handle(client, role as "interaction" | "worker", key, signal);
      };
      const run = <T>(operation: string, body: () => Promise<T>) =>
        Effect.runPromise(
          Effect.tryPromise({
            try: body,
            catch: (error) =>
              error instanceof CoreError ? error : new CoreError("runtime"),
          }).pipe(Effect.withSpan(`computah.${operation}`)),
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
