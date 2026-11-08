// Private native process protocol, not a public wire contract or generated action API.

import { readFile, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { Backend } from "./backend.mjs";
import { renderReply } from "./ui-catalog.mjs";

const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const demo = process.argv.includes("--demo");
const root = new URL("../", import.meta.url);
let currentTheme = JSON.parse(
  await readFile(new URL("layout.json", root), "utf8"),
).theme;
const render = (input) => {
  const reply = renderReply(input, currentTheme);
  if (reply.app) currentTheme = reply.app.theme;
  emit({ type: "ui", reply });
};
const backend =
  !demo &&
  new Backend({
    url: process.env.COMPUTAH_URL,
    token: process.env.COMPUTAH_TOKEN,
    outbox: process.env.COMPUTAH_OUTBOX,
    emit,
  });
if (backend) {
  try {
    await backend.connect();
  } catch {
    emit({
      type: "error",
      text: "Connection unavailable · check trusted endpoint/sign-in and restart",
    });
  }
}
// A host-configured file can deliver validated whole-app/card replacements. The deployed
// backend has no component endpoint yet; never parse ordinary assistant prose as a spec.
let modified = 0;
if (process.env.COMPUTAH_UI_FILE)
  setInterval(async () => {
    try {
      const info = await stat(process.env.COMPUTAH_UI_FILE);
      if (info.mtimeMs === modified) return;
      modified = info.mtimeMs;
      if (info.size > 128 * 1024) throw new Error("budget");
      render(JSON.parse(await readFile(process.env.COMPUTAH_UI_FILE, "utf8")));
    } catch {
      emit({
        type: "status",
        text: "UI replacement rejected · current composition retained",
      });
    }
  }, 500).unref();

for await (const line of createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
})) {
  if (Buffer.byteLength(line) > 160 * 1024) {
    emit({
      type: "error",
      pending: !!backend?.pending,
      text: "Command exceeds budget · draft retained",
    });
    continue;
  }
  try {
    const command = JSON.parse(line);
    if (command.op === "send") {
      if (demo) {
        const name = /remove everything|delete all|empty/i.test(command.text)
          ? "empty"
          : /table|compare/i.test(command.text)
            ? "table"
            : "restaurant";
        render(
          JSON.parse(
            await readFile(new URL(`fixtures/${name}.json`, root), "utf8"),
          ),
        );
      } else
        backend.send(command.text).catch(() =>
          emit({
            type: "error",
            pending: !!backend.pending,
            text: backend.pending
              ? "Request unsettled · Retry safely reuses the saved mutation ID"
              : "Message not sent · draft retained; check connection or shorten text",
          }),
        );
    } else if (command.op === "retry" && backend) {
      backend.send().catch(() =>
        emit({
          type: "error",
          text: "Request unsettled · pending request retained",
        }),
      );
    } else if (command.op === "cancel" && backend) {
      backend.cancel().catch(() =>
        emit({
          type: "status",
          text: "Cancellation unknown · request may still be running",
        }),
      );
    } else throw new Error("command");
  } catch {
    emit({
      type: "error",
      pending: !!backend?.pending,
      text: "Command rejected · draft retained",
    });
  }
}
