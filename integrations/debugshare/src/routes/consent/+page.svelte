<script lang="ts">
import "../../../ui/style.css";
import { authClient } from "../../../ui/auth-client.js";

// Server load must verify the signed query and resolve the public client.
let {
  data,
}: {
  data: {
    consent?: {
      verified: boolean;
      clientName: string;
      redirectHost: string;
      scopes: string[];
      claims?: string[];
    };
  };
} = $props();
let saving = $state(false);
let error = $state("");
async function decide(accept: boolean) {
  if (saving || !data.consent?.verified) return;
  saving = true;
  error = "";
  try {
    const result = await authClient.oauth2.consent({ accept });
    if (result.error) {
      error =
        "The authorization request is invalid or expired. Restart the connection from your client.";
      return;
    }
    const response = result.data as {
      redirect?: boolean;
      url?: string;
      redirect_uri?: string;
    } | null;
    const target = response?.url ?? response?.redirect_uri;
    if (target) {
      const url = new URL(target, location.origin);
      if (url.protocol === "https:" || url.protocol === "http:")
        location.assign(url.href);
      else error = "The client returned an unsupported redirect.";
    }
  } catch {
    error =
      "Could not complete authorization. Check your connection and try again.";
  } finally {
    saving = false;
  }
}
</script>

<svelte:head><title>Authorize connection · Computah issues</title></svelte:head>
<main class="auth-screen">
  <section class="auth-form" aria-label="Authorize connection">
    <h1>Connect to Computah issues</h1>
    {#if data.consent?.verified}<p>
        <strong>{data.consent.clientName}</strong> is requesting access to your account.
      </p>
      <p class="muted">
        Return destination: <span class="mono">{data.consent.redirectHost}</span
        >
      </p>
      <div class="panel p-4">
        <h2 class="mb-2">Requested permissions</h2>
        <ul>
          {#each data.consent.scopes as scope}<li class="mono py-1">
              {scope}
            </li>{/each}
        </ul>
        {#if data.consent.claims?.length}<p class="muted mt-3 text-xs">
            Account fields: {data.consent.claims.join(", ")}
          </p>{/if}
      </div>
      <p class="muted text-xs">
        Only approve clients you recognize. Their registered name is not proof
        of their identity.
      </p>
      {#if error}<p class="error" role="alert">{error}</p>{/if}
      <div class="flex gap-3">
        <button class="button" disabled={saving} onclick={() => decide(false)}
          >Deny</button
        ><button
          class="button primary"
          disabled={saving}
          onclick={() => decide(true)}
          >{saving ? "Continuing…" : "Allow access"}</button
        >
      </div>{:else}<p class="error" role="alert">
        This authorization request could not be verified. Restart the connection
        from your client.
      </p>
      <a class="button" href="/">Back to explorer</a>{/if}
  </section>
</main>
