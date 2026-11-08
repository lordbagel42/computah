// Private native process protocol, not a public wire contract or generated action API.

import { readFile, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import {
  runtimeLog,
  startObservability,
  traceEvent,
  traceOperation,
} from "@computah/observability";
import { Backend } from "./backend.mjs";
import { renderReply } from "./ui-catalog.mjs";

// Exporter failure must not stop local recovery or admission.
const telemetry = await startObservability("native").catch(() => ({
  close: async () => {},
}));
let backend;
const tasks = new Set();
let shutdown;
const stop = () =>
  (shutdown ??= (async () => {
    await Promise.allSettled([...tasks]);
    traceEvent("native.process", { outcome: "stop" });
    runtimeLog("native.process", { outcome: "stopped" });
    await telemetry.close();
  })());
process.once("SIGTERM", () => {
  backend?.close();
  // Bounded local drain, never a remote cancellation or a successful result.
  setTimeout(() => process.exit(0), 10000).unref();
  void stop().finally(() => process.exit(0));
});
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const demo = process.argv.includes("--demo");
const root = new URL("../", import.meta.url);
let currentTheme = JSON.parse(
  await readFile(new URL("layout.json", root), "utf8"),
).theme;
const render = (input) =>
  traceOperation("native.render", async (span) => {
    try {
      const reply = renderReply(input, currentTheme);
      if (reply.app) currentTheme = reply.app.theme;
      emit({ type: "ui", reply });
      span.setAttribute("outcome", "success");
      runtimeLog("native.render", { outcome: "success" });
    } catch (error) {
      runtimeLog(
        "native.render",
        { outcome: "error", reason: "invalid_input" },
        "warn",
      );
      throw error;
    }
  });
if (!demo) {
  try {
    backend = new Backend({
      url: process.env.COMPUTAH_URL,
      token: process.env.COMPUTAH_TOKEN,
      outbox: process.env.COMPUTAH_OUTBOX,
      emit,
    });
    await traceOperation("native.recovery", async () => {
      await backend.connect();
      runtimeLog("native.recovery", {
        operation: "recovery",
        outcome: "ready",
        resumed: !!backend.pending,
      });
    });
  } catch {
    runtimeLog(
      "native.process",
      { outcome: "error", reason: "not_configured" },
      "error",
    );
    emit({
      type: "error",
      text: "Connection unavailable · check trusted endpoint/sign-in and restart",
    });
  }
}
traceEvent("native.process", { outcome: "ready" });
runtimeLog("native.process", { outcome: "ready" });
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
      await render(
        JSON.parse(await readFile(process.env.COMPUTAH_UI_FILE, "utf8")),
      );
    } catch {
      runtimeLog(
        "native.render",
        { outcome: "error", reason: "invalid_input" },
        "warn",
      );
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
    runtimeLog("native.ipc", { outcome: "denied", reason: "capacity" }, "warn");
    continue;
  }
  // Do not await here: cancellation must remain available while a send is polling.
  let operation;
  const task = traceOperation("native.ipc", async (span) => {
    try {
      const command = JSON.parse(line);
      operation = command.op;
      if (command.op === "send") {
        if (demo) {
          const name = /remove everything|delete all|empty/i.test(command.text)
            ? "empty"
            : /table|compare/i.test(command.text)
              ? "table"
              : "restaurant";
          await render(
            JSON.parse(
              await readFile(new URL(`fixtures/${name}.json`, root), "utf8"),
            ),
          );
        } else if (backend) await backend.send(command.text);
        else throw new Error("Connection unavailable");
      } else if (command.op === "retry" && backend) {
        runtimeLog("native.ipc", { outcome: "retry" });
        await backend.send();
      } else if (command.op === "cancel" && backend) {
        const outcome = await backend.cancel();
        runtimeLog("native.ipc", {
          operation: "cancel",
          outcome: outcome === "cancelled" ? "cancelled" : "other",
        });
      } else throw new Error("command");
      span.setAttribute("outcome", "success");
      runtimeLog("native.ipc", { outcome: "success" });
    } catch {
      span.setAttribute("outcome", "error");
      span.setStatus({ code: 2 });
      runtimeLog("native.ipc", { outcome: "error" }, "error");
      emit({
        type: operation === "cancel" ? "status" : "error",
        pending: !!backend?.pending,
        text:
          operation === "cancel"
            ? "Cancellation unknown · work may continue; Stop is still available"
            : backend?.pending
              ? "Request unsettled · Retry safely reuses the saved mutation ID"
              : "Command unavailable or rejected · draft retained; check connection",
      });
    }
  });
  tasks.add(task);
  void task.finally(() => tasks.delete(task));
}
await stop();
