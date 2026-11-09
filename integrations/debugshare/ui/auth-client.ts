import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { createAuthClient } from "better-auth/svelte";

/** The official plugin forwards only the signed OAuth parameters on POSTs. */
export const authClient = createAuthClient({
  plugins: [oauthProviderClient()],
});
