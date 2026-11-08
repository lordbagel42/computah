import { registerHooks } from "node:module";

// Executable import guard, not a static grep. Bus-only restart must never load
// provider/Pi/core modules, even when there is durable queued work to recover.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier.startsWith("@earendil-works/") ||
      specifier.startsWith("@rivet-dev/pi") ||
      (context.parentURL?.includes("/apps/server/src/") &&
        /^\.\/(core|main|bus-core)\.(js|ts)$/.test(specifier))
    ) {
      throw new Error("Forbidden model-runtime import in bus-only process");
    }
    return nextResolve(specifier, context);
  },
});
