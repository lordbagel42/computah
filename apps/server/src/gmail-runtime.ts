import { mkdirSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { traceEvent, traceOperation } from "@computah/observability";
import { type Principal, principalKey } from "./config.js";
import type { CoreOptions, CoreSession, Scope } from "./core.js";
import {
  createComposioGmail,
  GmailError,
  GmailIngress,
  type GmailProvider,
} from "./gmail.js";
import { projectMessages } from "./http.js";

/** Protected host configuration, never an OAuth callback, model or public DTO. */
export function gmailConfig(
  env: NodeJS.ProcessEnv,
  principals: Iterable<Principal>,
) {
  if (!env.COMPUTAH_GMAIL_JSON) return undefined;
  try {
    const input = JSON.parse(env.COMPUTAH_GMAIL_JSON);
    const fields = [
      "scope",
      "owner",
      "account",
      "authConfigId",
      "path",
      "approvedManagedFullMail",
    ];
    if (
      !input ||
      Object.keys(input).some((k) => !fields.includes(k)) ||
      !input.scope ||
      Object.keys(input.scope).sort().join(",") !== "agentId,tenantId,userId" ||
      ![
        input.owner,
        input.account,
        input.authConfigId,
        input.path,
        input.scope.tenantId,
        input.scope.userId,
        input.scope.agentId,
      ].every(
        (v) => typeof v === "string" && v.length > 0 && v.length <= 512,
      ) ||
      !isAbsolute(input.path) ||
      typeof input.approvedManagedFullMail !== "boolean" ||
      !env.COMPUTAH_COMPOSIO_API_KEY
    )
      throw new Error();
    const scope = input.scope as Scope;
    const principal = [...principals].find(
      (p) => principalKey(p) === principalKey(scope),
    );
    if (
      !principal?.capabilities.includes("history.read") ||
      !principal.capabilities.includes("task.send")
    )
      throw new Error();
    return {
      scope: { ...scope },
      owner: input.owner as string,
      account: input.account as string,
      authConfigId: input.authConfigId as string,
      path: input.path as string,
      approvedManagedFullMail: input.approvedManagedFullMail as boolean,
      apiKey: env.COMPUTAH_COMPOSIO_API_KEY,
    };
  } catch {
    throw new Error("Invalid COMPUTAH_GMAIL_JSON protected binding");
  }
}

/** One paced persistent source/sync loop. No public listener or provider writes. */
export function createGmailRuntime(options: {
  config: NonNullable<ReturnType<typeof gmailConfig>>;
  authorize(scope: Scope): boolean;
  bind(scope: Scope): CoreSession;
  provider?: GmailProvider;
}) {
  const config = options.config;
  mkdirSync(dirname(config.path), { recursive: true, mode: 0o700 });
  let binding: { handle: string; version: string } | undefined;
  let adopting = true;
  const stop = new AbortController();
  const owns = (scope: Scope) =>
    principalKey(scope) === principalKey(config.scope) &&
    options.authorize(scope);
  const ingress = new GmailIngress(config.path, {
    provider:
      options.provider ??
      createComposioGmail({
        apiKey: config.apiKey,
        authConfigId: config.authConfigId,
        approvedManagedFullMail: config.approvedManagedFullMail,
      }),
    approvedManagedFullMail: config.approvedManagedFullMail,
    authorize: (scope, handle, version) =>
      owns(scope) &&
      (adopting ||
        !handle ||
        (binding?.handle === handle && binding.version === version)),
    run: async (work, current) => {
      await current();
      const session = options.bind(work.scope);
      const admitted = await session.submitSource(
        "Prepare an UNSENT LOCAL DRAFT for a newly received email; do not send or create provider drafts.",
        work.receipt,
        {
          handle: work.handle,
          version: work.grantVersion,
        },
        work.text,
      );
      const result = await session.result(
        session.interactionId,
        admitted.submissionId,
        true,
        stop.signal,
      );
      await current();
      if (result.submission.status !== "done") throw new GmailError("provider");
      return projectMessages(result.entries)
        .flatMap((message) =>
          message.blocks.flatMap((block) =>
            block.kind === "text" ? [block.text] : [],
          ),
        )
        .join("\n");
    },
  });
  const requireBinding = (scope: Scope) => {
    if (!owns(scope) || !binding) throw new GmailError("denied");
    return binding;
  };
  const sources: NonNullable<CoreOptions["sources"]> = {
    available: (scope) => owns(scope) && !!binding,
    check: (scope, grant) =>
      traceOperation("gmail.authority", async () => {
        const current = requireBinding(scope);
        if (
          current.handle !== grant.handle ||
          current.version !== grant.version
        )
          throw new GmailError("denied");
        await ingress.authority(scope, grant.handle, grant.version);
      }),
    preload: (scope, query) =>
      traceOperation("gmail.retrieval", async () => {
        if (!owns(scope) || !binding) return null;
        const terms = query
          .match(/[\p{L}\p{N}]{3,}/gu)
          ?.slice(0, 10)
          .join(" ");
        if (!terms) return null;
        const originals = await ingress.search(
          scope,
          binding.handle,
          terms.slice(0, 256),
        );
        if (!originals.length) return null;
        // Per-request evidence budget, not a total history/indexing cap. Preserve
        // complete JSON/provenance rather than slicing through a source record.
        const evidence = originals.slice(0, 3).map((source) => ({
          id: source.id,
          revision: source.revision,
          message: {
            ...source.message,
            text: source.message.text.slice(0, 4000),
          },
          limitations: [
            ...source.limitations,
            "Retrieval excerpt capped at4000 characters.",
          ],
        }));
        return { grants: [{ ...binding }], text: JSON.stringify(evidence) };
      }),
  };
  let loop: Promise<void> | undefined;
  return {
    sources,
    async initialize() {
      try {
        await traceOperation("gmail.bind", async () => {
          // Existing grant generation must be available to the current-authority
          // callback during idempotent adoption, without trusting public input.
          binding = await ingress.adoptConnected(
            config.scope,
            config.owner,
            config.account,
          );
        });
      } finally {
        adopting = false;
      }
      await traceOperation("gmail.sync", () =>
        ingress.initializeSync(
          config.scope,
          requireBinding(config.scope).handle,
        ),
      );
    },
    start() {
      if (loop) return;
      loop = (async () => {
        let failures = 0;
        while (!stop.signal.aborted) {
          try {
            const current = requireBinding(config.scope);
            await traceOperation("gmail.sync", () =>
              ingress.reconcilePage(config.scope, current.handle),
            );
            await traceOperation("gmail.import", () =>
              ingress.importPage(config.scope, current.handle),
            );
            await traceOperation("gmail.drain", () => ingress.drainOne());
            failures = 0;
          } catch {
            // No provider body, IDs, mail, credentials or raw exception text.
            failures = Math.min(8, failures + 1);
            traceEvent("gmail.sync", { outcome: "error" });
          }
          await delay(Math.min(60_000, 2000 * 2 ** failures), undefined, {
            signal: stop.signal,
          }).catch(() => {});
        }
      })();
    },
    async status(scope: Scope) {
      const current = requireBinding(scope);
      return traceOperation("gmail.sync", () =>
        ingress.progress(scope, current.handle),
      );
    },
    async drafts(scope: Scope) {
      const current = requireBinding(scope);
      return ingress.drafts(scope, current.handle);
    },
    async close() {
      stop.abort();
      await loop;
      ingress.close();
    },
  };
}
