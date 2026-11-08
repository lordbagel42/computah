import {
  currentTraceHeaders,
  registerContentSecrets,
  runtimeContent,
  traceModelStream,
  traceOperation,
  withTraceContext,
} from "@computah/observability";
import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  Models,
  StreamOptions,
} from "@earendil-works/pi-ai";

export const interactionModel = "openai-codex/gpt-6.1-terra";
export const workerModel = "openai-codex/gpt-6.1-sol";

type Diagnostic = {
  model: string;
  event: "request" | "response" | "tier" | "terminal";
  requested: "priority";
  status?: number;
  tier?: "priority" | "fast" | "default" | "auto" | "missing" | "other";
  stage?: "created" | "completed";
  outcome?: "success" | "aborted" | "reasoning-not-allowed" | "provider-error";
};

/** Wrap the shared native Models boundary, including checkpoint replay and compaction. */
export function priorityModels(
  models: Models,
  report: (diagnostic: Diagnostic) => void,
): Models {
  // Restored durable tasks carry their authoritative parent explicitly; ambient
  // OTel context may belong to a gateway or recovery action instead.
  function parent(input?: StreamOptions) {
    if (!input?.telemetry) return undefined;
    try {
      return input.telemetry.propagation?.inject(input.telemetry) ?? {};
    } catch {
      // A telemetry adapter failure must not break model work or mis-parent it.
      return {};
    }
  }
  function options<T extends StreamOptions>(model: Model<Api>, original: T): T {
    const id = `${model.provider}/${model.id}`;
    // Do not silently substitute an old checkpoint's model or provider.
    if (
      ![interactionModel, workerModel].includes(id) ||
      model.api !== "openai-codex-responses"
    )
      throw new Error(
        "COMPUTAH_MODEL checkpoint requires supported Terra/Sol Codex model",
      );
    return {
      ...original,
      onPayload: async (payload, ref) => {
        const final = (await original.onPayload?.(payload, ref)) ?? payload;
        if (!final || typeof final !== "object" || Array.isArray(final))
          throw new Error("COMPUTAH_MODEL invalid native provider payload");
        const body = final as Record<string, unknown>;
        report({ model: id, event: "request", requested: "priority" });
        // Simple options discard serviceTier; finalize after ALL caller transforms.
        // High is supported for both roles; off caused Terra's observed HTTP403.
        return {
          ...body,
          service_tier: "priority",
          reasoning: {
            ...(body.reasoning && typeof body.reasoning === "object"
              ? body.reasoning
              : {}),
            effort: "high",
          },
        };
      },
      onResponse: async (response, ref) => {
        report({
          model: id,
          event: "response",
          requested: "priority",
          status: response.status,
        });
        await original.onResponse?.(response, ref);
      },
      onProviderStreamEvent: async (data, ref) => {
        if (data && typeof data === "object") {
          const event = data as {
            type?: unknown;
            response?: { service_tier?: unknown };
          };
          if (
            event.type === "response.created" ||
            event.type === "response.completed"
          ) {
            const raw = event.response?.service_tier;
            const tier =
              raw === undefined
                ? "missing"
                : raw === "priority" ||
                    raw === "fast" ||
                    raw === "default" ||
                    raw === "auto"
                  ? raw
                  : "other";
            report({
              model: id,
              event: "tier",
              requested: "priority",
              tier,
              stage:
                event.type === "response.created" ? "created" : "completed",
            });
          }
        }
        await original.onProviderStreamEvent?.(data, ref);
      },
    };
  }
  function terminal(model: Model<Api>, message: AssistantMessage) {
    runtimeContent("model.output", {
      model: `${model.provider}/${model.id}`,
      sourceTruncated: message.content.length > 128,
      missing: message.content
        .slice(0, 128)
        .some((part) => part.type === "thinking")
        ? ["hidden_reasoning_excluded"]
        : [],
      stopReason: message.stopReason,
      error: message.errorMessage,
      usage: message.usage && {
        input: message.usage.input,
        output: message.usage.output,
        cacheRead: message.usage.cacheRead,
        cacheWrite: message.usage.cacheWrite,
        totalTokens: message.usage.totalTokens,
      },
      content: message.content.slice(0, 128).flatMap<unknown>((part) =>
        part.type === "text"
          ? [{ type: part.type, text: part.text }]
          : part.type === "toolCall"
            ? [
                {
                  type: part.type,
                  id: part.id,
                  name: part.name,
                  arguments: part.arguments,
                },
              ]
            : [],
      ),
    });
    report({
      model: `${model.provider}/${model.id}`,
      event: "terminal",
      requested: "priority",
      outcome:
        message.stopReason === "aborted"
          ? "aborted"
          : message.stopReason === "error"
            ? /reasoning_effort_not_allowed|reasoning level isn't available/i.test(
                message.errorMessage ?? "",
              )
              ? "reasoning-not-allowed"
              : "provider-error"
            : "success",
    });
    return message;
  }
  function captureInput(
    model: Model<Api>,
    context: Context,
    input?: StreamOptions,
  ) {
    registerContentSecrets(input?.apiKey ? [input.apiKey] : []);
    const messages = context.messages.slice(-64);
    const missing = new Set<string>();
    let sourceTruncated = context.messages.length > 64;
    const projected = messages.map((message) => {
      if (Array.isArray(message.content) && message.content.length > 128)
        sourceTruncated = true;
      return {
        role: message.role,
        content:
          typeof message.content === "string"
            ? message.content
            : message.content.slice(0, 128).flatMap<unknown>((part) => {
                if (part.type === "text")
                  return [{ type: part.type, text: part.text }];
                if (part.type === "toolCall")
                  return [
                    {
                      type: part.type,
                      id: part.id,
                      name: part.name,
                      arguments: part.arguments,
                    },
                  ];
                if (part.type === "image") {
                  missing.add("image_bytes_excluded");
                  return [{ type: part.type, mimeType: part.mimeType }];
                }
                missing.add("hidden_reasoning_excluded");
                return [];
              }),
        ...(message.role === "system"
          ? {
              sections: message.sections,
              toolsAdded: message.toolsAdded?.slice(0, 64),
              toolsRemoved: message.toolsRemoved?.slice(0, 64),
            }
          : {}),
        ...(message.role === "toolResult"
          ? {
              toolCallId: message.toolCallId,
              toolName: message.toolName,
              isError: message.isError,
            }
          : {}),
      };
    });
    runtimeContent("model.input", {
      model: `${model.provider}/${model.id}`,
      sourceTruncated:
        sourceTruncated ||
        (context.tools?.length ?? 0) > 64 ||
        messages.some(
          (message) =>
            message.role === "system" &&
            ((message.toolsAdded?.length ?? 0) > 64 ||
              (message.toolsRemoved?.length ?? 0) > 64),
        ),
      missing: [...missing],
      // Most recent first so the shared byte budget prioritizes this request.
      messageOrder: "newest_first",
      messages: projected.reverse(),
      system: context.systemPrompt,
      tools: context.tools?.slice(0, 64),
    });
  }
  function failure(model: Model<Api>, input?: StreamOptions) {
    runtimeContent("model.output", {
      model: `${model.provider}/${model.id}`,
      outcome: input?.signal?.aborted ? "cancelled" : "error",
      error: "model_request_failed",
    });
    report({
      model: `${model.provider}/${model.id}`,
      event: "terminal",
      requested: "priority",
      outcome: input?.signal?.aborted ? "aborted" : "provider-error",
    });
  }
  function observeStream<T extends { result(): Promise<AssistantMessage> }>(
    model: Model<Api>,
    context: Context,
    input: StreamOptions | undefined,
    call: () => T,
  ): T {
    // Invoked INSIDE traceModelStream's active span. Restore that exact carrier
    // for terminal callbacks rather than inheriting the result consumer's context.
    const carrier = currentTraceHeaders();
    captureInput(model, context, input);
    try {
      const stream = call();
      void stream.result().then(
        (message) => withTraceContext(carrier, () => terminal(model, message)),
        () => withTraceContext(carrier, () => failure(model, input)),
      );
      return stream;
    } catch (error) {
      failure(model, input);
      throw error;
    }
  }
  const requests: Pick<
    Models,
    "stream" | "streamSimple" | "complete" | "completeSimple"
  > = {
    stream(model, context, input) {
      return traceModelStream(
        model.id,
        () =>
          observeStream(model, context, input, () =>
            models.stream<Api>(model, context, options(model, input ?? {})),
          ),
        parent(input),
      );
    },
    streamSimple(model, context, input) {
      return traceModelStream(
        model.id,
        () =>
          observeStream(model, context, input, () =>
            models.streamSimple(model, context, {
              ...options(model, input ?? {}),
              reasoning: "high",
            }),
          ),
        parent(input),
      );
    },
    async complete(model, context, input) {
      return traceOperation(
        "model",
        async (span) => {
          captureInput(model, context, input);
          try {
            const message = await models.complete<Api>(
              model,
              context,
              options(model, input ?? {}),
            );
            span.setAttribute("outcome", message.stopReason);
            if (message.stopReason === "error") span.setStatus({ code: 2 });
            return terminal(model, message);
          } catch (error) {
            failure(model, input);
            throw error;
          }
        },
        parent(input),
      );
    },
    async completeSimple(model, context, input) {
      return traceOperation(
        "model",
        async (span) => {
          captureInput(model, context, input);
          try {
            const message = await models.completeSimple(model, context, {
              ...options(model, input ?? {}),
              reasoning: "high",
            });
            span.setAttribute("outcome", message.stopReason);
            if (message.stopReason === "error") span.setStatus({ code: 2 });
            return terminal(model, message);
          } catch (error) {
            failure(model, input);
            throw error;
          }
        },
        parent(input),
      );
    },
  };
  return new Proxy(models, {
    get(target, property) {
      if (Object.hasOwn(requests, property))
        return Reflect.get(requests, property);
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
