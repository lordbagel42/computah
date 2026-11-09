<script lang="ts">
import "../../../ui/style.css";

let saving = $state(false);
let error = $state("");
let complete = $state(false);
async function submit(event: SubmitEvent) {
  event.preventDefault();
  if (saving) return;
  const form = event.currentTarget as HTMLFormElement;
  const fields = new FormData(form);
  saving = true;
  error = "";
  try {
    const response = await fetch("/api/bootstrap", {
      method: "POST",
      credentials: "same-origin",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${fields.get("token") ?? ""}`,
      },
      body: JSON.stringify({
        email: fields.get("email"),
        name: fields.get("name"),
        password: fields.get("password"),
      }),
    });
    form.reset();
    if (!response.ok) {
      error =
        response.status === 409
          ? "Owner setup is already claimed or completed. Sign in with the provisioned account."
          : response.status === 403
            ? "Setup was not authorized. Check the bootstrap credential with your administrator."
            : "Setup did not complete. Check the account details with your administrator before retrying.";
      return;
    }
    complete = true;
  } catch {
    form.reset();
    error =
      "Could not confirm setup. Check your connection and try signing in before retrying setup.";
  } finally {
    saving = false;
  }
}
</script>

<svelte:head><title>Owner setup · Computah issues</title></svelte:head>
<main class="auth-screen">
  <section class="auth-form" aria-label="One-time owner setup">
    <h1>Set up the first operator</h1>
    {#if complete}
      <p class="success" role="status">
        Owner account created. Sign in to open the explorer.
      </p>
      <a class="button primary" href="/sign-in">Continue to sign in</a>
    {:else}
      <p class="muted">
        One-time administrator setup only. Public account registration is not
        available.
      </p>
      <form onsubmit={submit}>
        <label
          >Bootstrap credential<input
            type="password"
            name="token"
            autocomplete="off"
            required
            disabled={saving}
          /></label
        >
        <label
          >Name<input
            name="name"
            autocomplete="name"
            required
            maxlength="200"
            disabled={saving}
          /></label
        >
        <label
          >Email<input
            type="email"
            name="email"
            autocomplete="username"
            required
            disabled={saving}
          /></label
        >
        <label
          >Password<input
            type="password"
            name="password"
            autocomplete="new-password"
            minlength="8"
            required
            disabled={saving}
          /></label
        >
        {#if error}<p role="alert" class="error">{error}</p>{/if}
        <button class="button primary" type="submit" disabled={saving}
          >{saving ? "Creating owner…" : "Create owner account"}</button
        >
      </form>
      <a href="/sign-in">Already set up? Sign in</a>
    {/if}
  </section>
</main>
