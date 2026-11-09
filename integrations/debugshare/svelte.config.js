import adapter from "@sveltejs/adapter-cloudflare";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

export default {
  preprocess: vitePreprocess(),
  kit: {
    // The deployment config's main is the hand-written wrapper. The adapter
    // writes to `main`, so it MUST use this separate build-only config.
    adapter: adapter({ config: "wrangler.svelte.jsonc" }),
    files: { assets: "ui/public" },
    csp: {
      mode: "auto",
      directives: {
        "default-src": ["self"],
        "script-src": ["self"],
        "style-src": ["self", "unsafe-inline"],
        "img-src": ["self", "data:"],
        "font-src": ["self"],
        "connect-src": ["self"],
        "frame-ancestors": ["none"],
        "base-uri": ["none"],
        "form-action": ["self"],
      },
    },
  },
};
