<script lang="ts">
import "../../../ui/style.css";
import Login from "../../../ui/Login.svelte";

function complete() {
  const candidate = new URLSearchParams(location.search).get("callbackURL");
  if (candidate) {
    try {
      const url = new URL(candidate, location.origin);
      if (url.origin === location.origin) {
        location.assign(url.href);
        return;
      }
    } catch {
      /* Ignore invalid callback URLs, never reflect them. */
    }
  }
  location.assign("/");
}
</script>

<svelte:head><title>Sign in · Computah issues</title></svelte:head>
<Login onsuccess={complete} />
