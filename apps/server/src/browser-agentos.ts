import { currentTraceHeaders, traceOperation } from "@computah/observability";
import { AgentOs, type AgentOsSidecar } from "@rivet-dev/agentos-core";
import { Effect } from "effect";
import { z } from "zod";
import type { Browser, BrowserResult } from "./browser.js";
import type { Scope } from "./core.js";

/** Explicit embedded host-function bridge; NOT the hosted guest process API.
 * Guest code receives only browser.read({url}), never host paths/credentials.
 * One operation owns the VM and joins its callback before disposing it.
 */
export function createAgentOSBrowser(host: Browser): Browser {
  let active = 0;
  return {
    available: host.available,
    read(
      scope: Readonly<Scope>,
      url: string,
      current?: () => Promise<void>,
      parent?: Record<string, string>,
    ) {
      const principal = Object.freeze({ ...scope });
      return Effect.suspend(() => {
        let settlement: Promise<BrowserResult> | undefined;
        return Effect.promise((signal) => {
          settlement = traceOperation(
            "browser.agentos",
            async (span): Promise<BrowserResult> => {
              const fail = (
                code:
                  | "capacity"
                  | "runtime"
                  | "cancelled"
                  | "cleanup_unknown"
                  | "denied",
                started: boolean,
              ): Extract<BrowserResult, { status: "unavailable" }> => ({
                status: "unavailable",
                code,
                requestState: started ? "possibly_sent" : "not_sent",
                cleanup:
                  code === "cleanup_unknown"
                    ? "unknown"
                    : started
                      ? "unknown"
                      : "not_started",
              });
              let started = false;
              let result: BrowserResult = fail("runtime", false);
              const permitted = async () => {
                try {
                  await current?.();
                  return await host.available(principal);
                } catch {
                  return false;
                }
              };
              if (!(await permitted())) result = fail("denied", false);
              else if (active >= 2) result = fail("capacity", false);
              else {
                active++;
                let vm: AgentOs | undefined;
                let sidecar: AgentOsSidecar | undefined;
                let callback: Promise<BrowserResult> | undefined;
                const controller = new AbortController();
                const cancel = () => controller.abort();
                signal.addEventListener("abort", cancel, { once: true });
                if (signal.aborted) cancel();
                const carrier = currentTraceHeaders();
                try {
                  signal.throwIfAborted();
                  sidecar = await AgentOs.createSidecar();
                  vm = await AgentOs.create({
                    sidecar: { kind: "explicit", handle: sidecar },
                    environment: {},
                    permissions: {
                      fs: "allow",
                      childProcess: "allow",
                      env: "deny",
                      network: "deny",
                      hostFunction: {
                        default: "deny",
                        rules: [
                          {
                            mode: "allow",
                            operations: ["invoke"],
                            patterns: ["browser:read"],
                          },
                        ],
                      },
                    },
                    hostFunctions: {
                      browser: {
                        read: {
                          inputSchema: z
                            .object({ url: z.string().min(1).max(2048) })
                            .strict()
                            .describe(
                              "Read a page with a fresh host-native browser; untrusted text, no login or interactions.",
                            ),
                          execute: ({ url: target }) => {
                            started = true;
                            callback = Effect.runPromise(
                              host.read(principal, target, current, carrier),
                              { signal: controller.signal },
                            );
                            return callback;
                          },
                        },
                      },
                    },
                  });
                  controller.signal.throwIfAborted();
                  const execution = await vm.process.execFile(
                    "/bin/agentos-browser",
                    ["read", "--json", JSON.stringify({ url })],
                    {
                      signal: controller.signal,
                      timeoutMs: 75_000,
                      output: { capture: "all", retainEvents: false },
                    },
                  );
                  if (execution.exitCode !== 0 || !callback)
                    throw new Error("guest");
                  // Return the actual callback's typed result, not guest-controlled JSON.
                  result = await callback;
                } catch {
                  result = fail(
                    signal.aborted ? "cancelled" : "runtime",
                    started,
                  );
                } finally {
                  controller.abort();
                  try {
                    await callback;
                  } catch {
                    /* Effect cancellation joins native cleanup. */
                  }
                  if (vm) {
                    try {
                      await vm.dispose();
                    } catch {
                      result = fail("cleanup_unknown", started);
                    }
                  }
                  if (sidecar) {
                    try {
                      await sidecar.dispose();
                    } catch {
                      result = fail("cleanup_unknown", started);
                    }
                  }
                  signal.removeEventListener("abort", cancel);
                  active--;
                }
                // Disposal awaits are part of the release boundary too.
                if (!(await permitted()))
                  result = {
                    ...fail("denied", started),
                    cleanup: result.cleanup,
                  };
              }
              if (
                result.status === "unavailable" &&
                result.cleanup === "unknown"
              )
                result = { ...result, code: "cleanup_unknown" };
              span.setAttribute(
                "outcome",
                result.status === "ready"
                  ? "ready"
                  : result.code === "runtime" ||
                      result.code === "cleanup_unknown"
                    ? "error"
                    : result.code,
              );
              if (result.status !== "ready") span.setStatus({ code: 2 });
              return result;
            },
            parent,
          );
          return settlement;
        }).pipe(
          Effect.onInterrupt(() =>
            Effect.promise(async () => {
              await settlement;
            }),
          ),
        );
      });
    },
  };
}
