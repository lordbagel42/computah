import { createHash } from "node:crypto";
import { traceOperation } from "@computah/observability";
import { awaitWithContext, type Context } from "@earendil-works/chord/context";
import {
  defineDocFamily,
  defineExtension,
  defineTool,
  type ToolExecutionApi,
  type Tx,
} from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";

export type DraftRequest = {
  action: string;
  operationId: string;
  requestId: string;
  expectedVersion: string;
  recipients: string;
  subject: string;
  body: string;
};
export class ProcedureError extends Error {
  constructor(
    readonly code:
      | "invalid"
      | "conflict"
      | "unavailable"
      | "held"
      | "denied"
      | "cancelled"
      | "runtime",
  ) {
    super(`Local draft ${code}`);
  }
}
type Draft = {
  operationId: string;
  version: number;
  policyVersion: 1;
  holdMs: 120000;
  createdAt: number;
  updatedAt: number;
  notBefore: number;
  state: "held" | "local-eligible" | "cancelled";
  recipients: string;
  subject: string;
  body: string;
  creatorTaskId: string;
};
const Drafts = defineDocFamily<{ value: Draft | null }, null>({
  kind: "computah.procedure-draft",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({ value: null }),
  checkpointWhen: () => false,
});
const Requests = defineDocFamily<{ hash: string }, null>({
  kind: "computah.procedure-request",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({ hash: "" }),
  checkpointWhen: () => false,
});

/** No provider, scheduler, source index, or external dispatch capability. */
export function createProcedures(options: {
  current(api: ToolExecutionApi, context: Context): Promise<void>;
}) {
  const run = async (
    args: DraftRequest,
    api: Pick<ToolExecutionApi, "commit">,
    check: () => Promise<void>,
    creatorTaskId: string,
    context: Context,
    parent?: Record<string, string>,
  ) => {
    const completed = await traceOperation(
      "procedures.draft",
      async (span) => {
        let outcome: "success" | "error" | "denied" | "cancelled" = "error";
        try {
          const current = async () => {
            try {
              await awaitWithContext(check(), context);
            } catch {
              outcome = "denied";
              throw new ProcedureError("denied");
            }
            if (context.abortSignal?.aborted) {
              outcome = "cancelled";
              throw new ProcedureError("cancelled");
            }
          };
          await current();
          if (
            Object.keys(args).length !== 7 ||
            ![
              args.action,
              args.operationId,
              args.requestId,
              args.expectedVersion,
              args.recipients,
              args.subject,
              args.body,
            ].every((value) => typeof value === "string") ||
            !/^[a-zA-Z0-9:_-]{1,160}$/.test(args.operationId) ||
            !/^[a-zA-Z0-9:_-]{1,160}$/.test(args.requestId) ||
            args.expectedVersion.length > 16 ||
            !["create", "read", "edit", "cancel", "claim"].includes(
              args.action,
            ) ||
            args.body.length > 16000 ||
            args.subject.length > 1000 ||
            args.recipients.length > 2000
          )
            throw new ProcedureError("invalid");
          const hash = createHash("sha256")
            .update(
              JSON.stringify([
                args.action,
                args.operationId,
                args.expectedVersion,
                args.recipients,
                args.subject,
                args.body,
              ]),
            )
            .digest("hex");
          const draft = await api.commit(async (tx: Tx) => {
            // No network await inside this serialized Pi transaction.
            const receipt = await tx.doc(Requests, args.requestId, null);
            if (receipt.hash && receipt.hash !== hash)
              throw new ProcedureError("conflict");
            const row = await tx.doc(Drafts, args.operationId, null);
            if (context.abortSignal?.aborted)
              throw new ProcedureError("cancelled");
            const observedAt = Date.now();
            if (receipt.hash)
              return {
                draft: JSON.parse(JSON.stringify(row.value)) as Draft,
                observedAt,
              };
            const now = observedAt;
            if (args.action === "create") {
              if (
                row.value ||
                args.expectedVersion !== "0" ||
                !args.recipients.trim() ||
                !args.body.trim()
              )
                throw new ProcedureError("conflict");
              row.value = {
                operationId: args.operationId,
                version: 1,
                policyVersion: 1,
                holdMs: 120000,
                createdAt: now,
                updatedAt: now,
                notBefore: now + 120000,
                state: "held",
                recipients: args.recipients,
                subject: args.subject,
                body: args.body,
                creatorTaskId,
              };
            } else {
              const value = row.value;
              if (!value) throw new ProcedureError("unavailable");
              if (args.action !== "read") {
                if (
                  String(value.version) !== args.expectedVersion ||
                  value.state !== "held"
                )
                  throw new ProcedureError("conflict");
                if (args.action === "edit") {
                  if (!args.recipients.trim() || !args.body.trim())
                    throw new ProcedureError("invalid");
                  value.recipients = args.recipients;
                  value.subject = args.subject;
                  value.body = args.body;
                  value.notBefore = now + value.holdMs;
                } else if (args.action === "cancel") value.state = "cancelled";
                else {
                  if (now < value.notBefore) throw new ProcedureError("held");
                  value.state = "local-eligible";
                }
                value.version++;
                value.updatedAt = now;
              }
            }
            // Reads are live projections, not stale idempotency snapshots.
            if (args.action !== "read") {
              receipt.hash = hash;
            }
            return {
              draft: JSON.parse(JSON.stringify(row.value)) as Draft,
              observedAt,
            };
          }, context);
          await current();
          outcome = "success";
          return {
            result: {
              output: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    ...draft.draft,
                    observedAt: draft.observedAt,
                    localEligible:
                      draft.draft.state !== "cancelled" &&
                      draft.observedAt >= draft.draft.notBefore,
                    delivery: "UNSENT LOCAL DRAFT",
                    externalSendEnabled: false,
                  }),
                },
              ],
            },
          };
        } catch (error) {
          if (context.abortSignal?.aborted) outcome = "cancelled";
          span.setStatus({ code: 2 });
          // Classify typed failures inside the span; throw only after its outcome
          // is exported, so traceOperation does not reclassify denial as error.
          return {
            error: context.abortSignal?.aborted
              ? new ProcedureError("cancelled")
              : error instanceof ProcedureError
                ? error
                : new ProcedureError("runtime"),
          };
        } finally {
          span.setAttributes({ outcome });
        }
      },
      parent ?? context.telemetry.propagation?.inject(context.telemetry),
    );
    if ("error" in completed) throw completed.error;
    return completed.result;
  };
  const tool = defineTool({
    name: "procedure_draft",
    description:
      "Durable local-only delayed email draft. action=create/read/edit/cancel/claim. Stable operationId identifies this Worker's draft; unique requestId deduplicates mutations (changed payload conflicts). expectedVersion is 0 for create or the exact current version for mutations. Supply recipients/subject/body for create/edit, empty strings otherwise. Edit resets the full 120-second hold. claim atomically marks only LOCAL eligible/UNSENT at notBefore, never sends. No attachments or provider draft/send authority. Read returns exact eligibility and current version; cancellation guaranteed while held, including due-but-unclaimed drafts.",
    parameters: obj({
      action: str(),
      operationId: str(),
      requestId: str(),
      expectedVersion: str(),
      recipients: str(),
      subject: str(),
      body: str(),
    }),
    replay: "safe",
    execute: (args, api, context) =>
      run(
        args,
        api,
        () => options.current(api, context),
        String(api.taskId),
        context,
      ),
  });
  return {
    extension: defineExtension({ name: "computah.procedures", tools: [tool] }),
    tool,
    run,
  };
}
