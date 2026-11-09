import { createHash } from "node:crypto";
import type { Capability, CoreOptions, Scope } from "./core.js";
import { interactionModel, workerModel } from "./model-policy.js";

export type Principal = Scope & {
  tokenHash: string;
  capabilities: Capability[];
  displayName: string;
};
export const tokenHash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const principalKey = (scope: Scope) =>
  JSON.stringify([scope.tenantId, scope.userId, scope.agentId]);
const capabilities: Capability[] = [
  "task.send",
  "history.read",
  "operator.read",
  "task.control",
  "core.maintain",
  "web.search",
  "web.extract",
  "browser.read",
  "operations.read",
  "files.read",
  "files.write",
  "axiom.read",
  "executor.catalog",
];

export function readConfig(env: NodeJS.ProcessEnv) {
  const mode = env.COMPUTAH_MODE ?? "real";
  if (mode !== "real" && mode !== "faux")
    throw new Error("COMPUTAH_MODE must be real or faux");
  const secret = env.COMPUTAH_CONNECTION_SECRET;
  if (!secret || Buffer.byteLength(secret) < 32)
    throw new Error(
      "COMPUTAH_CONNECTION_SECRET must contain at least 32 random bytes",
    );
  let input: unknown;
  try {
    input = JSON.parse(env.COMPUTAH_AUTH_JSON ?? "");
  } catch {
    throw new Error("COMPUTAH_AUTH_JSON must be a secret JSON array");
  }
  if (!Array.isArray(input) || input.length === 0)
    throw new Error("COMPUTAH_AUTH_JSON needs at least one binding");
  const principals = new Map<string, Principal>();
  const scopes = new Set<string>();
  for (const item of input) {
    if (
      !item ||
      typeof item !== "object" ||
      typeof item.token !== "string" ||
      item.token.length < 32 ||
      ![item.tenantId, item.userId, item.agentId].every(
        (value) =>
          typeof value === "string" && value.length > 0 && value.length <= 200,
      ) ||
      !Array.isArray(item.capabilities) ||
      !item.capabilities.every((value: unknown) =>
        capabilities.includes(value as Capability),
      ) ||
      (item.displayName !== undefined && typeof item.displayName !== "string")
    )
      throw new Error("Invalid COMPUTAH_AUTH_JSON binding");
    const principal: Principal = {
      tenantId: item.tenantId,
      userId: item.userId,
      agentId: item.agentId,
      displayName: item.displayName ?? item.userId,
      tokenHash: tokenHash(item.token),
      capabilities: [...new Set<Capability>(item.capabilities)],
    };
    if (
      principals.has(principal.tokenHash) ||
      scopes.has(principalKey(principal))
    )
      throw new Error("Duplicate auth token or scope binding");
    principals.set(principal.tokenHash, principal);
    scopes.add(principalKey(principal));
  }
  if (mode === "real" && env.COMPUTAH_MODEL)
    throw new Error(
      "COMPUTAH_MODEL is obsolete; use COMPUTAH_INTERACTION_MODEL and COMPUTAH_WORKER_MODEL",
    );
  if (
    mode === "real" &&
    ((env.COMPUTAH_INTERACTION_MODEL &&
      env.COMPUTAH_INTERACTION_MODEL !== interactionModel) ||
      (env.COMPUTAH_WORKER_MODEL && env.COMPUTAH_WORKER_MODEL !== workerModel))
  )
    throw new Error(
      "COMPUTAH_MODEL role configuration must select the supported Terra/Sol pair",
    );
  const model =
    mode === "faux" ? "computah-smoke/deterministic" : interactionModel;
  const executionModel = mode === "faux" ? model : workerModel;
  let sentinel:
    | Omit<NonNullable<CoreOptions["sentinel"]>, "review">
    | undefined;
  if (env.COMPUTAH_SENTINEL_JSON) {
    try {
      if (mode !== "real") throw new Error();
      const policy = JSON.parse(env.COMPUTAH_SENTINEL_JSON);
      const validScope = (scope: Scope) =>
        scope &&
        typeof scope === "object" &&
        Object.keys(scope).sort().join(",") === "agentId,tenantId,userId" &&
        [scope.tenantId, scope.userId, scope.agentId].every(
          (value) =>
            typeof value === "string" &&
            value.length > 0 &&
            value.length <= 200,
        ) &&
        scopes.has(principalKey(scope));
      if (
        !policy ||
        Object.keys(policy).sort().join(",") !== "ownerScope,reviews" ||
        !validScope(policy.ownerScope) ||
        !Array.isArray(policy.reviews) ||
        !policy.reviews.length ||
        policy.reviews.length > principals.size ||
        policy.reviews.some(
          (entry: { scope: Scope; mode: string }) =>
            !entry ||
            Object.keys(entry).sort().join(",") !== "mode,scope" ||
            !validScope(entry.scope) ||
            !["monitor", "preflight"].includes(entry.mode),
        ) ||
        new Set(
          policy.reviews.map((entry: { scope: Scope }) =>
            principalKey(entry.scope),
          ),
        ).size !== policy.reviews.length
      )
        throw new Error();
      sentinel = policy;
    } catch {
      throw new Error(
        "Invalid COMPUTAH_SENTINEL_JSON: explicit existing owner/review scopes and monitor/preflight modes required in real mode",
      );
    }
  }
  const port = Number(env.PORT ?? "3000");
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("PORT must be an integer between 0 and 65535");
  const provider = model.split("/")[0];
  const key = env.COMPUTAH_PROVIDER_API_KEY;
  const authFile = env.COMPUTAH_PI_AUTH_FILE;
  if (authFile && !authFile.startsWith("/"))
    throw new Error(
      "COMPUTAH_PI_AUTH_FILE must be an absolute private writable path",
    );
  let privilegedUrlPrefixes: string[];
  try {
    const input: unknown = JSON.parse(
      env.COMPUTAH_OPERATOR_PRIVILEGED_URL_PREFIXES ?? "[]",
    );
    if (
      !Array.isArray(input) ||
      input.length > 64 ||
      !input.every(
        (value) =>
          typeof value === "string" &&
          value.length <= 2048 &&
          ["http:", "https:", "ws:", "wss:"].includes(new URL(value).protocol),
      )
    )
      throw new Error();
    privilegedUrlPrefixes = input;
  } catch {
    throw new Error("Invalid COMPUTAH_OPERATOR_PRIVILEGED_URL_PREFIXES");
  }
  const executable = env.COMPUTAH_BROWSER_EXECUTABLE;
  const chromium = env.COMPUTAH_BROWSER_CHROMIUM;
  if (
    (executable || chromium) &&
    (!executable?.startsWith("/") || !chromium?.startsWith("/"))
  )
    throw new Error(
      "Native browser requires both explicit absolute COMPUTAH_BROWSER_EXECUTABLE and COMPUTAH_BROWSER_CHROMIUM paths",
    );
  return {
    mode: mode as "real" | "faux",
    secret,
    principals,
    model,
    workerModel: executionModel,
    sentinel,
    port,
    authFile,
    browser: executable && chromium ? { executable, chromium } : undefined,
    apiKeys: key ? { [provider]: key } : undefined,
    operatorRedactValues: [
      secret,
      ...input.map((binding) => binding.token as string),
      key,
      env.COMPUTAH_TAVILY_API_KEY,
      env.COMPUTAH_AXIOM_INGEST_TOKEN,
      env.AXIOM_TOKEN,
      env.AXIOM_API_TOKEN,
    ].filter((value): value is string => Boolean(value)),
    privilegedUrlPrefixes,
  };
}
