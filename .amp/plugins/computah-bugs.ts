import type { PluginAPI } from "@ampcode/plugin";
import listen from "../../integrations/debugshare-listener/index.js";

export const description =
  "Links Computah bug IDs to the authenticated Computah issue tracker.";

export default async function (amp: PluginAPI) {
  amp.registerLinkPattern({
    id: "computah-bug",
    pattern: "computah_bug_[a-z0-9]{24}",
    href: "https://computah-issues.raygen.executor.website/#{{match}}",
  });
  await listen(amp);
}
