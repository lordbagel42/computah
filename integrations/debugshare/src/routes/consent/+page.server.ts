import { verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import { error, redirect } from "@sveltejs/kit";
import { createAuth } from "../../../auth.js";
import type { PageServerLoad } from "./$types";

/** Consent copy must come from the verified OAuth query, not arbitrary URL text. */
export const load: PageServerLoad = async ({ request, url, platform }) => {
  const env = (
    platform as { env?: Parameters<typeof createAuth>[0] } | undefined
  )?.env;
  if (!env) error(503, "Authorization is temporarily unavailable.");
  const auth = createAuth(env);
  const params = url.searchParams;
  const signed = new Set(["sig", "ba_param", ...params.getAll("ba_param")]);
  const query = new URLSearchParams(
    [...params].filter(([key]) => signed.has(key)),
  ).toString();
  const { secret } = await auth.$context;
  if (!(await verifyOAuthQueryParams(query, secret))) {
    error(
      400,
      "The authorization request is invalid or expired. Restart the connection from your client.",
    );
  }
  const verified = new URLSearchParams(query);
  const clientId = verified.get("client_id");
  const destination = verified.get("redirect_uri");
  if (!clientId || !destination)
    error(400, "The authorization request is incomplete.");
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    const next = new URLSearchParams(params);
    next.set("callbackURL", `${url.pathname}${url.search}`);
    redirect(303, `/sign-in?${next}`);
  }
  let client: Awaited<ReturnType<typeof auth.api.getOAuthClientPublic>>;
  try {
    client = await auth.api.getOAuthClientPublic({
      query: { client_id: clientId },
      headers: request.headers,
    });
  } catch {
    error(
      400,
      "This client is unavailable. Restart the connection from your client.",
    );
  }
  let redirectHost: string;
  try {
    const target = new URL(destination);
    redirectHost = target.host || target.protocol;
  } catch {
    error(400, "The client return destination is invalid.");
  }
  let claims: string[] = [];
  try {
    const value = JSON.parse(verified.get("claims") ?? "{}");
    if (value.userinfo && typeof value.userinfo === "object")
      claims = Object.keys(value.userinfo);
  } catch {
    error(400, "The requested account fields are invalid.");
  }
  return {
    consent: {
      verified: true,
      clientName: client.client_name || clientId,
      redirectHost,
      scopes: (verified.get("scope") ?? "").split(" ").filter(Boolean),
      claims,
    },
  };
};
