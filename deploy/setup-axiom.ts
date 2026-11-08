import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import * as Alchemist from "alchemy/Alchemist";
import { Effect } from "effect";
import stack from "./axiom.run.js";

// Keep provisioning state outside Git and the Docker build context.
process.umask(0o077);
const state = join(homedir(), ".local/state/computah-axiom");
await mkdir(state, { recursive: true, mode: 0o700 });
process.chdir(state);
process.env.CI = "true";
try {
  const output = await Effect.runPromise(
    Effect.gen(function* () {
      const plan = yield* Alchemist.plan({
        stack,
        operation: "deploy",
        stage: "production",
      });
      if (plan.summary.replace || plan.summary.delete || plan.summary.orphaned)
        return yield* Effect.die(
          "Axiom deletion/replacement requires a separate operator decision",
        );
      return yield* Alchemist.apply(plan);
    }).pipe(Effect.provide(Alchemist.layer()), Effect.scoped),
  );
  console.info(
    JSON.stringify({
      dataset: output.traces,
      endpoint: output.endpoint,
    }),
  );
} catch (error) {
  console.error(error instanceof Error ? error.name : "Provisioning error");
  console.error(
    "Axiom provisioning failed; inspect permissions and protected local state without publishing credentials",
  );
  process.exitCode = 1;
}
