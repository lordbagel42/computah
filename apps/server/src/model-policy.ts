import { traceModelStream, traceOperation } from "@computah/observability";
import type {
  Api,
  AssistantMessage,
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
  const requests: Pick<
    Models,
    "stream" | "streamSimple" | "complete" | "completeSimple"
  > = {
    stream(model, context, input) {
      const stream = traceModelStream(
        model.id,
        () => models.stream<Api>(model, context, options(model, input ?? {})),
        parent(input),
      );
      void stream.result().then(
        (message) => terminal(model, message),
        () => {
          report({
            model: `${model.provider}/${model.id}`,
            event: "terminal",
            requested: "priority",
            outcome: "provider-error",
          });
        },
      );
      return stream;
    },
    streamSimple(model, context, input) {
      const stream = traceModelStream(
        model.id,
        () =>
          models.streamSimple(model, context, {
            ...options(model, input ?? {}),
            reasoning: "high",
          }),
        parent(input),
      );
      void stream.result().then(
        (message) => terminal(model, message),
        () => {
          report({
            model: `${model.provider}/${model.id}`,
            event: "terminal",
            requested: "priority",
            outcome: "provider-error",
          });
        },
      );
      return stream;
    },
    async complete(model, context, input) {
      return terminal(
        model,
        await traceOperation(
          "model",
          async (span) => {
            const message = await models.complete<Api>(
              model,
              context,
              options(model, input ?? {}),
            );
            span.setAttribute("outcome", message.stopReason);
            if (message.stopReason === "error") span.setStatus({ code: 2 });
            return message;
          },
          parent(input),
        ),
      );
    },
    async completeSimple(model, context, input) {
      return terminal(
        model,
        await traceOperation(
          "model",
          async (span) => {
            const message = await models.completeSimple(model, context, {
              ...options(model, input ?? {}),
              reasoning: "high",
            });
            span.setAttribute("outcome", message.stopReason);
            if (message.stopReason === "error") span.setStatus({ code: 2 });
            return message;
          },
          parent(input),
        ),
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
