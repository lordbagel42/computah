import { createHash } from "node:crypto";
import type { Capability, Scope } from "./core.js";

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
  "task.control",
  "core.maintain",
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
  const model =
    mode === "faux" ? "computah-smoke/deterministic" : env.COMPUTAH_MODEL;
  if (!model || !/^[^/]+\/.+$/.test(model))
    throw new Error("COMPUTAH_MODEL=provider/model is required in real mode");
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
  return {
    mode: mode as "real" | "faux",
    secret,
    principals,
    model,
    port,
    authFile,
    apiKeys: key ? { [provider]: key } : undefined,
  };
}
