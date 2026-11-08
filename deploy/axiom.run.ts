import * as Axiom from "@alchemy.run/axiom";
import * as Alchemy from "alchemy";
import { retain } from "alchemy/RemovalPolicy";
import { Effect } from "effect";

// Independent control-plane stack: never adopts or replaces the serving container.
export default Alchemy.Stack(
  "computah-observability",
  { providers: Axiom.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const traces = yield* Axiom.Dataset("traces", {
      name: "computah-prod-traces",
      // Axiom's current API calls logs/traces datasets Events (OTLP still uses /v1/traces).
      kind: "axiom:events:v1",
      description:
        "Computah production traces; payloads and identities excluded before export",
    }).pipe(retain());
    return {
      traces: traces.name,
      endpoint: traces.otelTracesEndpoint,
    };
  }),
);
