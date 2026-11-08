import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { PluginAPI } from "@ampcode/plugin";
import { createReceiver } from "./receiver.ts";

export const description = "Computah's designated durable Axiom alert receiver";

const owner = "T-01a1ba7b-4ecc-71c5-9a22-3df77cc7ed04";
const root = fileURLToPath(new URL("../../.amp/listener/", import.meta.url));

export default async function (amp: PluginAPI) {
  if (process.env.AMP_THREAD_ID !== owner) return;
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const receiver = await createReceiver(`${root}/state.json`);
  const { url } = await amp.createWebhook({
    key: "computah-axiom-alerts",
    handler: receiver.handle,
  });
  await writeFile(`${root}/endpoint`, url, { mode: 0o600 });
  await receiver.recover(amp.threads.get(owner));
  amp.registerTool({
    name: "computah_listener_status",
    description:
      "Read bounded listener counters and authenticated-history watermarks, never credentials or hint text.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async execute() {
      return JSON.stringify(receiver.status());
    },
  });
  amp.registerTool({
    name: "computah_listener_provision",
    description:
      "Provision the native capability-URL Axiom notifier without exposing credentials. Does not attach monitors.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async execute(_input, ctx) {
      if (ctx.thread.id !== owner) throw new Error("Designated owner required");
      try {
        await readFile(`${root}/provision-result.json`, "utf8");
        return "Prior provision response exists; inspect privately before any retry.";
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      try {
        const result = await ctx.tools.call("axiom.createNotifier", {
          notifierJson: JSON.stringify({
            name: "Computah · durable Amp alert listener",
            properties: { amp: { webhookUrl: url } },
          }),
        });
        await writeFile(
          `${root}/provision-result.json`,
          JSON.stringify(result),
          { mode: 0o600 },
        );
        return "Provision response saved privately; inspect only notifier ID/status.";
      } catch (error) {
        await writeFile(`${root}/provision-error`, String(error), {
          mode: 0o600,
        });
        return "Provision outcome unknown; inspect live notifier list before retrying.";
      }
    },
  });
}
