import {
  type Api,
  type AssistantMessage,
  createAssistantMessageEventStream,
  type Model,
  type Models,
  type StreamOptions,
} from "@earendil-works/pi-ai";

/** Codex payload hooks precede its internal retry loop. Fence each HTTP attempt
 * and prohibit WebSocket retries, which do not use the supplied fetch transport. */
export function sourceRequestOptions<T extends StreamOptions>(
  input: T,
  current: () => Promise<void>,
): T {
  return {
    ...input,
    transport: "sse",
    fetch: async (...args) => {
      try {
        await current();
      } catch {
        // Codex retries arbitrary fetch errors. Abort this logical request rather
        // than spending its backoff budget repeatedly attempting denied access.
        throw new DOMException("Source access denied", "AbortError");
      }
      input.signal?.throwIfAborted();
      return (input.fetch ?? globalThis.fetch)(...args);
    },
    onPayload: async (payload, model) => {
      await current();
      const result = (await input.onPayload?.(payload, model)) ?? payload;
      await current();
      return result;
    },
  };
}

/** Private invocation-signal fence, never provider metadata. Hooks register a
 * fresh committed-state check; missing/failed hooks cannot authorize a request.
 * Pi 1.5 reports hook throws and continues, so the Models boundary MUST enforce it.
 */
export function sourceModels(models: Models) {
  const checks = new WeakMap<AbortSignal, () => Promise<void>>();
  const check = async (signal?: AbortSignal) => {
    const current = signal && checks.get(signal);
    if (!current || signal?.aborted) throw new Error("Source access denied");
    await current();
    signal?.throwIfAborted();
  };
  function options<T extends StreamOptions>(input: T): T {
    return sourceRequestOptions(input, () => check(input.signal));
  }
  function denied(model: Model<Api>): AssistantMessage {
    return {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      stopReason: "error",
      errorMessage: "Source access denied",
      timestamp: Date.now(),
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
  }
  const methods: Pick<
    Models,
    | "stream"
    | "streamSimple"
    | "complete"
    | "completeSimple"
    | "fetchDeferred"
    | "streamDeferred"
  > = {
    stream(model, context, input) {
      const output = createAssistantMessageEventStream();
      void (async () => {
        try {
          await check(input?.signal);
          const stream = models.stream<Api>(
            model,
            context,
            options(input ?? {}),
          );
          for await (const event of stream) output.push(event);
          output.end(await stream.result());
        } catch {
          output.push({ type: "error", reason: "error", error: denied(model) });
        }
      })();
      return output;
    },
    streamSimple(model, context, input) {
      const output = createAssistantMessageEventStream();
      void (async () => {
        try {
          await check(input?.signal);
          const stream = models.streamSimple(
            model,
            context,
            options(input ?? {}),
          );
          for await (const event of stream) output.push(event);
          output.end(await stream.result());
        } catch {
          output.push({ type: "error", reason: "error", error: denied(model) });
        }
      })();
      return output;
    },
    async complete(model, context, input) {
      await check(input?.signal);
      return models.complete<Api>(model, context, options(input ?? {}));
    },
    async completeSimple(model, context, input) {
      await check(input?.signal);
      return models.completeSimple(model, context, options(input ?? {}));
    },
    async fetchDeferred(model, handle, input) {
      // The pinned native poll phase has no generation hook. Its unregistered
      // signal is denied rather than using a stale request's account authority.
      await check(input?.signal);
      return models.fetchDeferred(model, handle, input);
    },
    streamDeferred(model) {
      // No supported native polling hook can register a fresh source authority.
      const output = createAssistantMessageEventStream();
      output.push({ type: "error", reason: "error", error: denied(model) });
      return output;
    },
  };
  return {
    register(signal: AbortSignal, current: () => Promise<void>) {
      checks.set(signal, current);
    },
    models: new Proxy(models, {
      get(target, property) {
        if (Object.hasOwn(methods, property))
          return Reflect.get(methods, property);
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  };
}
