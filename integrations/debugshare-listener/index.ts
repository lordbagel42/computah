import {
  chmod,
  mkdir,
  open,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { PluginAPI } from "@ampcode/plugin";
import { createReceiver, owner } from "./receiver.js";

export default async function (amp: PluginAPI) {
  if (process.env.AMP_THREAD_ID !== owner) return;
  const root = fileURLToPath(
    new URL("../../.amp/debugshare-listener/", import.meta.url),
  );
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const pending = `${root}/pending`;
  await mkdir(pending, { recursive: true, mode: 0o700 });
  const syncDirectory = async () => {
    const directory = await open(pending, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  };
  const receiver = createReceiver({
    fetch,
    token: () => readFile(`${root}/tracker-token`, "utf8"),
    async begin(id) {
      let file: Awaited<ReturnType<typeof open>>;
      try {
        file = await open(`${pending}/${id}-v1`, "wx", 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw error;
      }
      try {
        await file.sync();
      } finally {
        await file.close();
      }
      await syncDirectory();
      return true;
    },
    async clear(id) {
      try {
        await unlink(`${pending}/${id}-v1`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await syncDirectory();
    },
  });
  const { url } = await amp.createWebhook({
    key: "debugshare-ingested-v1",
    handler: receiver.handle,
  });
  await writeFile(`${root}/endpoint`, url, { mode: 0o600 });
  await chmod(`${root}/endpoint`, 0o600);
  amp.registerTool({
    name: "computah_debugshare_listener_status",
    description:
      "Read dedicated DEBUGSHARE receiver counters; never returns webhook credentials.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async execute() {
      return JSON.stringify(receiver.status());
    },
  });
}
