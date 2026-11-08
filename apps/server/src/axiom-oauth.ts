import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { traceOperation } from "@computah/observability";
import {
  type AuthProvider,
  type McpFetch,
  McpHttpError,
} from "@earendil-works/pi-mcp";
import {
  type McpOAuthState,
  refreshAuthorization,
} from "@earendil-works/pi-mcp/oauth";

/** One explicitly mounted public-client OAuth grant, never an ambient credential search. */
export function createAxiomOAuth(path: string) {
  if (!isAbsolute(path))
    throw new Error("COMPUTAH_AXIOM_MCP_OAUTH_FILE must be absolute");
  let state: McpOAuthState | undefined;
  let loading: Promise<McpOAuthState> | undefined;
  let refresh: Promise<void> | undefined;
  let saving: Promise<void> | undefined;
  let pendingSave = false;
  const secrets: string[] = [];
  const remember = (value: McpOAuthState) => {
    for (const token of [
      value.tokens?.access_token,
      value.tokens?.refresh_token,
    ])
      if (token && !secrets.includes(token)) secrets.push(token);
    secrets.splice(0, Math.max(0, secrets.length - 8));
  };
  const unavailable = () =>
    new McpHttpError(401, "Axiom OAuth authorization required");
  const read = async () => {
    if (state) return state;
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 65_536 || stat.mode & 0o077)
        throw unavailable();
      const value = JSON.parse(await file.readFile("utf8")) as McpOAuthState;
      if (
        value.serverUrl !== "https://mcp.axiom.co/mcp" ||
        typeof value.clientInformation?.client_id !== "string" ||
        value.clientInformation.client_secret ||
        typeof value.tokens?.access_token !== "string" ||
        !value.tokens.access_token ||
        typeof value.tokens.token_type !== "string" ||
        value.tokens.token_type.toLowerCase() !== "bearer"
      )
        throw unavailable();
      state = value;
      remember(value);
      return value;
    } finally {
      await file.close();
    }
  };
  const load = () => {
    if (state) return Promise.resolve(state);
    loading ??= read().catch((error) => {
      loading = undefined;
      throw error;
    });
    return loading;
  };
  const save = async (value: McpOAuthState) => {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const file = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600,
      );
      try {
        await file.writeFile(JSON.stringify(value));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, path);
      pendingSave = false;
    } finally {
      await unlink(temporary).catch(() => {});
    }
  };
  const persist = (value: McpOAuthState) => {
    saving ??= traceOperation("axiom.persist", async (span) => {
      try {
        await save(value);
        span.setAttribute("outcome", "ready");
      } catch {
        span.setAttribute("outcome", "error");
        span.setStatus({ code: 2 });
        throw unavailable();
      }
    }).finally(() => {
      saving = undefined;
    });
    return saving;
  };
  const refreshGrant = async (fetch: McpFetch, rejectedToken?: string) => {
    refresh ??= traceOperation("axiom.refresh", async (span) => {
      try {
        const value = await load();
        if (pendingSave) await persist(value);
        if (rejectedToken && rejectedToken !== value.tokens?.access_token) {
          span.setAttribute("outcome", "ready");
          return;
        }
        if (!value.tokens?.refresh_token || !value.clientInformation)
          throw unavailable();
        const tokens = await refreshAuthorization(
          "https://authorization.axiom.co",
          {
            metadata: {
              issuer: "https://authorization.axiom.co",
              authorization_endpoint:
                "https://authorization.axiom.co/oauth2/authorize",
              token_endpoint: "https://authorization.axiom.co/oauth2/token",
              response_types_supported: ["code"],
              token_endpoint_auth_methods_supported: ["none"],
            },
            clientInformation: value.clientInformation,
            refreshToken: value.tokens.refresh_token,
            resource: "https://mcp.axiom.co/mcp",
            // The caller's bounded, grant-checked transport also bounds refresh.
            fetch,
          },
        );
        state = {
          ...value,
          tokens,
          tokensExpireAt:
            tokens.expires_in === undefined
              ? undefined
              : Date.now() + tokens.expires_in * 1000,
        };
        remember(state);
        pendingSave = true;
        await persist(state);
        span.setAttribute("outcome", "ready");
      } catch (error) {
        span.setAttribute(
          "outcome",
          error instanceof Error && error.name === "TimeoutError"
            ? "timeout"
            : error instanceof Error && error.name === "AbortError"
              ? "cancelled"
              : "error",
        );
        span.setStatus({ code: 2 });
        throw unavailable();
      }
    }).finally(() => {
      refresh = undefined;
    });
    await refresh;
  };
  const provider = (fetch: McpFetch): AuthProvider => ({
    async token() {
      try {
        if (refresh) await refresh;
        const value = await load();
        if (pendingSave) await persist(value);
        if (
          value.tokensExpireAt !== undefined &&
          value.tokensExpireAt <= Date.now() + 30_000
        )
          await refreshGrant(fetch, value.tokens?.access_token);
        return state?.tokens?.access_token;
      } catch {
        throw unavailable();
      }
    },
    async onUnauthorized(context) {
      if (context.response.status !== 401) throw unavailable();
      await refreshGrant(fetch, context.token);
    },
  });
  return {
    provider,
    containsSecret: (text: string) =>
      secrets.some((secret) => text.includes(secret)),
  };
}
