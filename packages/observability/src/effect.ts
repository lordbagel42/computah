import { OtelTracer } from "@effect/opentelemetry";

// Only Effect consumers load the Effect bridge; Slack needs neither Effect nor its startup cost.
export const effectTracing = OtelTracer.layerGlobal;
