import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  open,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { PluginAPI } from "@ampcode/plugin";
import { createReceiver, owner } from "./receiver.js";
import { createWorkflow, space } from "./workflow.js";

// Tool calls can return direct structured data or a full MCP envelope. Unknown
// results fail closed: a resolved archive call is not archive confirmation.
function toolValue(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object")
    throw new Error("workflow_tool_result_invalid");
  const value = raw as Record<string, unknown>;
  if (value.structuredContent) return toolValue(value.structuredContent);
  if (Array.isArray(value.content)) {
    for (const block of value.content) {
      if (block.type === "amp_builtin_call" && block.result)
        return toolValue(block.result);
      if (block.type === "text") {
        try {
          return toolValue(JSON.parse(block.text));
        } catch {
          /* Try structured blocks. */
        }
      }
    }
    throw new Error("workflow_tool_result_unavailable");
  }
  return value;
}

export default async function (amp: PluginAPI) {
  if (process.env.AMP_THREAD_ID !== owner) return;
  const root = fileURLToPath(
    new URL("../../.amp/debugshare-listener/", import.meta.url),
  );
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const workflow = await createWorkflow(`${root}/assignments`, {
    async create() {
      const thread = await amp.getBuiltinAgent("medium").createThread({
        parentThreadID: owner,
        features: ["fast"],
        executor: "orb",
        project: "lordbagel42/computah",
      });
      return thread.id;
    },
    async start(thread, prompt) {
      await amp.threads
        .get(thread as `T-${string}`)
        .appendUserMessage({ type: "user-message", content: prompt });
    },
  });
  const cleanupSubscriptions = new Map<string, { unsubscribe(): void }>();
  const watchCleanup = async (id: string, thread: string) => {
    if (cleanupSubscriptions.has(id)) return;
    const child = amp.threads.get(thread as `T-${string}`);
    let queued = false;
    const wake = async () => {
      if (queued) return;
      queued = true;
      cleanupSubscriptions.get(id)?.unsubscribe();
      cleanupSubscriptions.delete(id);
      await amp.threads.get(owner).appendUserMessage({
        type: "user-message",
        content: `[computah-cleanup:${id}:v1] Worker ${thread} became idle after verified resolution was recorded. Inspect computah_bug_workflow state, recheck acceptance/followups and use resolve to confirm explicit archival. Idle alone never means resolved.`,
      });
    };
    cleanupSubscriptions.set(
      id,
      child.state.subscribe((state) => {
        if (state === "idle")
          void wake().catch(() => {
            console.error("computah.debugshare.cleanup.wake_failed");
          });
      }),
    );
    if ((await child.state.get()) === "idle") await wake();
  };
  for (const record of await workflow.unresolvedCleanup()) {
    try {
      if (record.thread) await watchCleanup(record.id, record.thread);
    } catch {
      console.error("computah.debugshare.cleanup.recovery_failed");
    }
  }
  const pending = `${root}/pending`;
  await mkdir(pending, { recursive: true, mode: 0o700 });
  const syncDirectory = async () => {
    const directory = await open(pending, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  };
  const receiver = createReceiver({
    fetch,
    token: () => readFile(`${root}/tracker-token`, "utf8"),
    dispatch: (id, signal) => workflow.dispatch(id, signal),
    assigned: async (id) => Boolean((await workflow.inspect(id))?.thread),
    async begin(id) {
      let file: Awaited<ReturnType<typeof open>>;
      try {
        file = await open(`${pending}/${id}-v1`, "wx", 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw error;
      }
      try {
        await file.sync();
      } finally {
        await file.close();
      }
      await syncDirectory();
      return true;
    },
    async clear(id) {
      try {
        await unlink(`${pending}/${id}-v1`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await syncDirectory();
    },
  });
  const { url } = await amp.createWebhook({
    key: "debugshare-ingested-v1",
    handler: receiver.handle,
  });
  await writeFile(`${root}/endpoint`, url, { mode: 0o600 });
  await chmod(`${root}/endpoint`, 0o600);
  amp.registerTool({
    name: "computah_bug_workflow",
    description:
      "Coordinator-only durable bug assignment lookup, verified main-landing notice, and explicit resolution/archive. Never resolve with pending human/runtime acceptance or followups. Inspect uncertain effects rather than reset/create competing workers.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["inspect", "landed", "resolve"] },
        id: { type: "string" },
        commit: {
          type: "string",
          description: "Full actual-main SHA with this worker's Amp trailer",
        },
        evidence: {
          type: "string",
          description:
            "For landed: user-visible fix plus source/runtime limits. For resolve: verified production adoption and report-specific acceptance evidence, never source publication alone. No secrets/raw histories.",
        },
        recurrence: {
          type: "string",
          description:
            "Resolve requires a durable coordinator/monitor handoff receipt: adoption anchor, ledger link, owner and finite +2h/+2d/+7d schedule receipt or completed checkpoints. Ongoing transferred recurrence is not a worker followup.",
        },
        pending: {
          type: "array",
          items: { type: "string" },
          description:
            "Explicit remaining assigned followups; resolve requires an empty list",
        },
      },
      required: ["action", "id"],
      additionalProperties: false,
    },
    async execute(input, ctx) {
      if (ctx.thread.id !== owner) throw new Error("wrong_workflow_owner");
      const args = input as {
        action: string;
        id: string;
        commit?: string;
        evidence?: string;
        recurrence?: string;
        pending?: string[];
      };
      let outcome = "failure";
      try {
        if (args.action === "inspect") {
          outcome = "inspected";
          return JSON.stringify((await workflow.inspect(args.id)) ?? null);
        }
        const verify = async (thread: string, commit: string) => {
          ctx.signal.throwIfAborted();
          if (thread === owner || thread === space)
            throw new Error("invalid_worker_target");
          const git = promisify(execFile);
          try {
            await git("git", ["fetch", "--quiet", "origin", "main"], {
              signal: ctx.signal,
            });
            await git(
              "git",
              ["merge-base", "--is-ancestor", commit, "origin/main"],
              { signal: ctx.signal },
            );
            const body = await git(
              "git",
              ["show", "-s", "--format=%B", commit],
              { signal: ctx.signal },
            );
            if (
              !body.stdout
                .split("\n")
                .includes(
                  `Amp-Thread-ID: https://ampcode.com/threads/${thread}`,
                )
            )
              throw new Error("foreign_commit");
          } catch {
            throw new Error("workflow_main_verification_failed");
          }
          const linked = toolValue(
            await ctx.tools.call("amp.find_thread", {
              query: `id:${thread} commit:${commit}`,
              limit: 1,
            }),
          );
          if (
            !Array.isArray(linked.threads) ||
            !linked.threads.some((item) => item.id === thread)
          )
            throw new Error("workflow_linkage_unconfirmed");
        };
        const status = async (thread: string) => {
          const result = toolValue(
            await ctx.tools.call("amp.get_thread_status", { thread }),
          );
          const metadata = result.metadata as
            | Record<string, unknown>
            | undefined;
          if (
            metadata?.threadID !== thread ||
            metadata.viewerOwnsThread !== true ||
            typeof metadata.archived !== "boolean"
          )
            throw new Error("workflow_worker_authority_unconfirmed");
          return { result, metadata };
        };
        if (args.action === "landed") {
          const record = await workflow.landed(
            args.id,
            args.commit ?? "",
            args.evidence ?? "",
            {
              verify,
              async notify(thread, commit, summary) {
                ctx.signal.throwIfAborted();
                await ctx.tools.call("send_thread_message", {
                  thread: space,
                  message: `Worker report from https://ampcode.com/threads/${owner}:\nResult: Verified main landing for ${args.id}: ${summary}\nWhere: https://ampcode.com/threads/${thread} ; https://github.com/lordbagel42/computah/commit/${commit}\nNot done: Source publication does not establish runtime adoption/acceptance.\nNext: Preserve assigned acceptance/followups before archival; verify Space attachment/shipment aggregation.`,
                });
              },
            },
          );
          outcome = "landing_reported";
          return JSON.stringify(record);
        }
        if (args.action !== "resolve" || !Array.isArray(args.pending))
          throw new Error("workflow_action_invalid");
        const record = await workflow.resolve(
          args.id,
          args.commit ?? "",
          args.evidence ?? "",
          args.pending,
          {
            recurrence: args.recurrence ?? "",
            verify,
            async archived(thread) {
              return (await status(thread)).metadata.archived === true;
            },
            async idle(thread) {
              const { result } = await status(thread);
              return (
                !result.awaitingUserInput &&
                (result.agentState as { state?: string })?.state === "idle"
              );
            },
            async archive(thread) {
              ctx.signal.throwIfAborted();
              await ctx.tools.call("amp.update_thread", {
                thread,
                archived: true,
              });
            },
          },
        );
        if (record.phase === "resolved" && record.thread)
          await watchCleanup(record.id, record.thread);
        outcome = record.phase;
        return JSON.stringify(record);
      } finally {
        ctx.logger.log("computah.debugshare.workflow.completed", outcome);
      }
    },
  });
  amp.registerTool({
    name: "computah_debugshare_listener_status",
    description:
      "Read dedicated DEBUGSHARE receiver counters; never returns webhook credentials.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async execute() {
      return JSON.stringify(receiver.status());
    },
  });
}
