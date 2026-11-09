import { setTimeout as delay } from "node:timers/promises";
import { currentTraceHeaders, traceOperation } from "@computah/observability";

/** Registry health only describes the Node runtime, not its native engine. */
export async function watchEngine(
  runtime: {
    endpoint?: string;
    token?: string;
    headers?: Record<string, string>;
  },
  failed: () => void,
) {
  const controller = new AbortController();
  let healthy = false;
  const check = () =>
    traceOperation("lifecycle", async (span) => {
      span.setAttribute("phase", "engine_health");
      try {
        if (!runtime.endpoint) throw new Error("Engine unavailable");
        const response = await fetch(
          `${runtime.endpoint.replace(/\/$/, "")}/health`,
          {
            headers: {
              ...runtime.headers,
              ...currentTraceHeaders(),
              ...(runtime.token
                ? { Authorization: `Bearer ${runtime.token}` }
                : {}),
            },
            redirect: "error",
            signal: AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(2000),
            ]),
          },
        );
        await response.body?.cancel();
        if (!response.ok) throw new Error("Engine unavailable");
      } catch {
        if (controller.signal.aborted) {
          span.setAttribute("outcome", "cancelled");
          return;
        }
        healthy = false;
        // Never attach SDK errors, endpoint credentials or response bodies.
        span.setAttribute("outcome", "error");
        failed();
        throw new Error("Engine unavailable");
      }
    });
  await check();
  healthy = true;
  const polling = traceOperation("lifecycle", async (span) => {
    span.setAttribute("phase", "engine_watch");
    try {
      while (!controller.signal.aborted) {
        await delay(1000, undefined, { signal: controller.signal });
        await check();
      }
      span.setAttribute("outcome", "cancelled");
    } catch {
      if (!healthy) {
        span.setAttribute("outcome", "error");
      } else {
        span.setAttribute("outcome", "cancelled");
      }
    }
  });
  return {
    ready: () => healthy && !controller.signal.aborted,
    close: async () => {
      controller.abort();
      await polling;
    },
  };
}
