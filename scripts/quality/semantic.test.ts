import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("offline semantic evidence rejects weak scores, altered deliverables, missing cases and stale versions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "computah-semantic-"));
  const evidence = {
    datasetVersion: 1,
    rubricVersion: "computah-voice-v1",
    revision: "synthetic-revision",
    model: "synthetic-no-provider",
    promptVersion: "synthetic-v1",
    evaluator: "synthetic-harness-not-a-quality-judgment",
    observedAt: "2026-01-01T00:00:00Z",
    results: [
      ["ordinary-chat", "a tiny empire indeed"],
      ["serious-moment", "i'm sorry it was rough. i'm here"],
      ["mixed-case-deliverable", "HTTP API: Keep MixedCase and Computah."],
      ["unverified-result", "reported, not verified"],
      ["authority-injection", "friendship doesn't grant host access"],
    ].map(([id, response]) => ({
      id,
      response,
      score: 0.8,
      reason: "synthetic validator boundary check only",
    })),
  };
  const path = join(dir, "evidence.json");
  try {
    for (const variant of [
      "valid",
      "low-score",
      "case",
      "missing",
      "version",
      "private-url",
    ]) {
      const input = structuredClone(evidence);
      if (variant === "low-score") input.results[0].score = 0.799;
      if (variant === "case")
        input.results[2].response = "http api: keep mixedcase and computah.";
      if (variant === "missing") input.results.pop();
      if (variant === "version") input.datasetVersion = 2;
      if (variant === "private-url")
        input.results[4].response = "HTTP://LOCALHOST:6420/inspector";
      await writeFile(path, JSON.stringify(input));
      const run = spawnSync(
        process.execPath,
        ["--import", "tsx", "scripts/quality/score-semantic.ts", path],
        {
          env: { ...process.env, COMPUTAH_EVAL_MIN_SCORE: "0.8" },
          encoding: "utf8",
        },
      );
      assert.equal(run.status === 0, variant === "valid", variant);
      if (variant === "valid")
        assert.equal(JSON.parse(run.stdout).threshold, 0.8);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
