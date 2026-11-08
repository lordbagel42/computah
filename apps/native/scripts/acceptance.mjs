// Explicit real-service acceptance. The operator supplies credentials in-process/env.
// Emits booleans/outcomes/trace IDs only, never tokens, prompts, history or handles.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  currentTraceHeaders,
  startObservability,
  traceOperation,
} from "@computah/observability";
import { Backend } from "./backend.mjs";

export async function acceptance() {
  assert.ok(
    process.env.COMPUTAH_URL && process.env.COMPUTAH_TOKEN,
    "Trusted private connection required",
  );
  const telemetry = await startObservability("native");
  const directory = await mkdtemp(
    join(tmpdir(), "computah-native-acceptance-"),
  );
  const events = [];
  const options = {
    url: process.env.COMPUTAH_URL,
    token: process.env.COMPUTAH_TOKEN,
    outbox: join(directory, "outbox.json"),
    emit: (event) => events.push(event),
  };
  const deadline = Date.now() + 600000;
  const connection = (overrides = {}) => {
    const backend = new Backend({ ...options, ...overrides });
    const request = backend.request.bind(backend);
    backend.request = (...args) => {
      if (Date.now() > deadline)
        throw new Error("Acceptance deadline; pending work retained");
      return request(...args);
    };
    return backend;
  };
  let success = false;
  try {
    return await traceOperation("native.process", async () => {
      const receipt = { traceparent: currentTraceHeaders().traceparent };
      const denied = connection({
        token: "native-acceptance-intentionally-invalid",
      });
      await assert.rejects(denied.connect(), /Sign-in required|Access denied/);
      receipt.forgedBearerDenied = true;
      const first = connection();
      await first.connect();
      receipt.authenticatedViewerAndHistory =
        events.some((e) => e.type === "ready") &&
        events.some((e) => e.type === "history");
      const marker = `native-acceptance-${randomUUID()}`;
      let originalHandle;
      const original = first.request.bind(first);
      first.request = async (...args) => {
        const value = await original(...args);
        if (args[0] === "/v1/submissions") {
          originalHandle = value.id;
          throw new Error(
            "Acceptance: acknowledgement deliberately lost after real admission",
          );
        }
        return value;
      };
      await assert.rejects(
        first.send(
          `Please ask your primary Worker using Task to return exactly ${marker}. This is a harmless native client acceptance check.`,
        ),
        /deliberately lost/,
      );
      const saved = JSON.parse(await readFile(options.outbox, "utf8"));
      assert.equal(saved.pending.id, null);
      const recovered = connection();
      await recovered.connect();
      assert.equal(
        recovered.pending.clientMutationId,
        saved.pending.clientMutationId,
      );
      const recoverRequest = recovered.request.bind(recovered);
      recovered.request = async (...args) => {
        const value = await recoverRequest(...args);
        if (args[0] === "/v1/submissions")
          assert.equal(value.id, originalHandle);
        return value;
      };
      await recovered.send();
      assert.equal(
        events.findLast((e) => e.type === "result")?.outcome,
        "completed",
      );
      const text = (messages) =>
        messages
          .filter((m) => m.role === "assistant")
          .flatMap((m) => m.blocks ?? [])
          .filter((b) => b.kind === "text")
          .map((b) => b.text)
          .join("\n");
      assert.ok(
        text(events.findLast((e) => e.type === "result").messages).includes(
          marker,
        ),
      );
      receipt.realResultAfterLostAcknowledgement = true;
      receipt.sameMutationAndHandleOnRetry = true;
      const reconnect = connection();
      await reconnect.connect();
      assert.equal(reconnect.pending, null);
      assert.ok(
        text(events.findLast((e) => e.type === "history").messages).includes(
          marker,
        ),
      );
      receipt.historyAfterReconnect = true;
      // Exercise the actual process boundary, not only the Backend class. The
      // bearer is inherited privately, never passed as argv or emitted.
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "scripts/host.mjs"],
        {
          cwd: fileURLToPath(new URL("../", import.meta.url)),
          env: {
            ...process.env,
            COMPUTAH_OUTBOX: options.outbox,
            COMPUTAH_UI_FILE: "",
          },
          stdio: ["pipe", "pipe", "ignore"],
        },
      );
      const exited = once(child, "exit");
      let timer;
      try {
        const reply = await new Promise((resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("Native host acceptance deadline")),
            Math.max(1, deadline - Date.now()),
          );
          child.once("error", reject);
          child.once("exit", () =>
            reject(new Error("Native host exited before a result")),
          );
          createInterface({ input: child.stdout }).on("line", (line) => {
            const event = JSON.parse(line);
            if (event.type === "error")
              reject(new Error("Native host request failed"));
            if (event.type === "ready") {
              receipt.realHostConnected = true;
              child.stdin.write(
                `${JSON.stringify({ op: "send", text: "Please ask your primary Worker using Task to repeat the exact native acceptance marker from our immediately preceding turn and append ' follow-up'. Do not invent a new marker." })}\n`,
              );
            }
            if (event.type === "result") resolve(event);
          });
        });
        assert.equal(reply.outcome, "completed");
        assert.ok(text(reply.messages).includes(marker));
        child.stdin.end();
        assert.equal((await exited)[0], 0);
        receipt.realHostProcessRoundtrip = true;
      } finally {
        clearTimeout(timer);
        if (child.exitCode === null) {
          child.kill("SIGTERM");
          await exited;
        }
      }
      receipt.realFollowupRecalledMarker = true;
      const sending = reconnect.send(
        "Please ask your primary Worker using Task to answer 'native cancellation acceptance'. This harmless turn will be cancelled if still running.",
      );
      // Attach immediately: a rejected send must not become an unhandled rejection.
      const settled = sending.then(
        () => null,
        (error) => error,
      );
      const admissionDeadline = Date.now() + 30000;
      while (
        !reconnect.pending?.id &&
        reconnect.running &&
        Date.now() < admissionDeadline
      )
        await new Promise((resolve) => setTimeout(resolve, 25));
      receipt.cancellationEndpointExercised = !!reconnect.pending?.id;
      receipt.cancellationStatus = await reconnect.cancel();
      const error = await settled;
      if (error) throw error;
      receipt.cancellationTerminalOutcome = events.findLast(
        (e) => e.type === "result",
      )?.outcome;
      if (receipt.cancellationStatus === "cancelled")
        assert.equal(receipt.cancellationTerminalOutcome, "cancelled");
      if (!receipt.cancellationEndpointExercised)
        receipt.cancellationSkippedTurnAlreadySettled = !reconnect.pending;
      // This does NOT claim actual Task invocation from public assistant prose.
      // Operator separately inspects only aggregate private Task/Worker evidence.
      receipt.workerDelegationRequiresPrivateOperatorVerification = true;
      success = true;
      return receipt;
    });
  } finally {
    await telemetry.close();
    if (success) await rm(directory, { recursive: true, force: true });
    else
      console.error(
        `Acceptance incomplete; private recovery outbox retained in ${directory}`,
      );
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  acceptance().then(
    (receipt) => console.log(JSON.stringify(receipt)),
    () => {
      console.error(
        "Native real acceptance failed; inspect private recovery state locally, not in public logs.",
      );
      process.exitCode = 1;
    },
  );
}
