#!/opt/computah/toolchain/bin/node
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

// Host-only operator client. The bearer never appears in argv or output.
try {
  const text = process.argv.slice(2).join(" ").trim();
  if (!text) throw new Error("usage");
  const config = readFileSync("/etc/computah/runtime.env", "utf8");
  const prefix = "COMPUTAH_AUTH_JSON=";
  const bindings = JSON.parse(
    config
      .split("\n")
      .find((line) => line.startsWith(prefix))
      .slice(prefix.length),
  );
  const headers = {
    authorization: `Bearer ${bindings[0].token}`,
    "content-type": "application/json",
  };
  const base = "http://127.0.0.1:8787";
  const response = await fetch(`${base}/v1/submissions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ text, clientMutationId: randomUUID() }),
    signal: AbortSignal.timeout(30000),
  });
  if (response.status !== 202) throw new Error("submit");
  const { id } = await response.json();
  console.error(`Accepted submission: ${id}`);
  const deadline = Date.now() + 180000;
  let completed = false;
  while (Date.now() < deadline) {
    const result = await fetch(`${base}/v1/submissions/${id}?wait=true`, {
      headers,
      signal: AbortSignal.timeout(35000),
    });
    if (!result.ok) throw new Error("result");
    const { submission, messages } = await result.json();
    if (submission.outcome === "completed") {
      for (const message of messages.filter(
        (entry) => entry.role === "assistant",
      )) {
        console.log(
          message.blocks
            .filter((block) => block.kind === "text")
            .map((block) => block.text)
            .join("\n"),
        );
      }
      completed = true;
      break;
    }
    if (!["accepted", "streaming"].includes(submission.outcome))
      throw new Error("terminal");
  }
  if (!completed) throw new Error("timeout");
} catch {
  console.error(
    "Chat did not complete. Check service health/history; do not assume a disconnected request was cancelled. Usage: sudo /usr/local/lib/computah/chat 'message'",
  );
  process.exitCode = 1;
}
