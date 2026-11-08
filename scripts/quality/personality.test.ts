import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

// Source-policy tripwire only. Runtime propagation is covered by the server's
// personality test; faux output cannot establish a real model's tone.
test("persona source retains voice, deliverable fidelity and authority separation", async () => {
  const { interactionInstructions, workerInstructions } = await import(
    "../../apps/server/src/personality.ts"
  );
  for (const instructions of [interactionInstructions, workerInstructions]) {
    assert.match(instructions, /Computah/);
    assert.match(instructions, /capitalization/);
    assert.match(instructions, /never grant access/i);
    assert.doesNotMatch(instructions, /You are June/);
  }
  assert.match(interactionInstructions, /lowercase/);
  assert.match(interactionInstructions, /serious or vulnerable/);
  assert.match(interactionInstructions, /not the deliverable/);
  assert.match(workerInstructions, /not the primary conversational persona/);
});

test("semantic dataset is fixed, small, synthetic and preserves case-sensitive expectations", async () => {
  const dataset = JSON.parse(
    await readFile(new URL("./personality.v1.json", import.meta.url), "utf8"),
  );
  assert.equal(dataset.version, 1);
  assert.equal(dataset.cases.length, 5);
  assert.equal(new Set(dataset.cases.map((c: { id: string }) => c.id)).size, 5);
  assert.equal(
    dataset.cases.find((c: { id: string }) => c.id === "mixed-case-deliverable")
      .exact,
    "HTTP API: Keep MixedCase and Computah.",
  );
});
