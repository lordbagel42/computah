<script lang="ts">
import { authClient } from "./auth-client.js";

let { onsuccess }: { onsuccess: () => void } = $props();
let saving = $state(false);
let error = $state("");
async function submit(event: SubmitEvent) {
  event.preventDefault();
  if (saving) return;
  const form = event.currentTarget as HTMLFormElement;
  const data = new FormData(form);
  saving = true;
  error = "";
  try {
    const result = await authClient.signIn.email({
      email: String(data.get("email") ?? ""),
      password: String(data.get("password") ?? ""),
    });
    form.reset();
    if (result.error) {
      error = "Sign in failed. Check your email and password and try again.";
      return;
    }
    // Better Auth's redirect plugin continues the signed OAuth request.
    // Do not race that navigation with the explorer's ordinary callback.
    if (result.data?.redirect) return;
    onsuccess();
  } catch {
    form.reset();
    error = "Could not sign in. Check your connection and retry.";
  } finally {
    saving = false;
  }
}
</script>

<main class="auth-screen">
  <section class="auth-form" aria-label="Operator sign in">
    <div>
      <h1>Computah <span class="muted">issues</span></h1>
      <p class="muted mt-2">Sign in to open the internal explorer.</p>
    </div>
    <form onsubmit={submit}>
      <label
        >Email<input
          name="email"
          type="email"
          autocomplete="username"
          required
          disabled={saving}
        /></label
      ><label
        >Password<input
          name="password"
          type="password"
          autocomplete="current-password"
          minlength="8"
          required
          disabled={saving}
        /></label
      >{#if error}<p class="error" role="alert">{error}</p>{/if}<button
        type="submit"
        class="button primary"
        disabled={saving}>{saving ? "Signing in…" : "Sign in"}</button
      >
      <p class="muted text-xs">
        Access is limited to provisioned operators. No public registration.
      </p>
    </form>
  </section>
</main>
