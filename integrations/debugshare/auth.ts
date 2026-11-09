import { oauthProvider } from "@better-auth/oauth-provider";
import { betterAuth } from "better-auth";
import { jwt } from "better-auth/plugins";

export const canonicalOrigin = "https://debug.raygen.dev";

export function createAuth(env: Env, bootstrap = false) {
  return betterAuth({
    appName: "Computah Debug",
    baseURL: canonicalOrigin,
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,
    database: env.AUTH_DB,
    trustedOrigins: [canonicalOrigin],
    emailAndPassword: {
      enabled: true,
      disableSignUp: !bootstrap,
      minPasswordLength: 8,
    },
    session: { expiresIn: 8 * 60 * 60, disableSessionRefresh: true },
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 60,
      customRules: {
        "/sign-in/email": { window: 60, max: 5 },
        "/sign-up/email": { window: 60, max: 3 },
      },
    },
    advanced: {
      useSecureCookies: true,
      cookiePrefix: "debugshare",
      defaultCookieAttributes: {
        sameSite: "strict",
        secure: true,
        httpOnly: true,
        path: "/",
      },
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
    },
    disabledPaths: ["/token"],
    plugins: [
      jwt({ jwt: { issuer: `${canonicalOrigin}/api/auth` } }),
      oauthProvider({
        loginPage: "/sign-in",
        consentPage: "/consent",
        scopes: [
          "openid",
          "profile",
          "email",
          "offline_access",
          "issues:read",
          "issues:write",
          "traces:read",
        ],
        validAudiences: [`${canonicalOrigin}/mcp`],
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        clientRegistrationDefaultScopes: ["issues:read"],
      }),
    ],
    logger: { disabled: true },
  });
}

export async function operatorAllowed(env: Env, id: string): Promise<boolean> {
  return Boolean(
    await env.AUTH_DB.prepare(
      "SELECT user_id FROM operator_grants WHERE user_id=? AND enabled=1",
    )
      .bind(id)
      .first(),
  );
}
