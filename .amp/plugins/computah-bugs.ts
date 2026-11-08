import type { PluginAPI } from "@ampcode/plugin";

export const description =
  "Links Computah bug IDs to the authenticated Computah issue tracker.";

export default function (amp: PluginAPI) {
  amp.registerLinkPattern({
    id: "computah-bug",
    pattern: "computah_bug_[a-z0-9]{24}",
    href: "https://computah-issues.raygen.executor.website/#{{match}}",
  });
}
