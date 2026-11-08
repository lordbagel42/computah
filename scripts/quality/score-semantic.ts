import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Offline evidence validation, not a provider client or a scheduled model judge.
// Provider generation/scoring must be explicitly requested outside required CI.
const dataset = JSON.parse(
  await readFile(new URL("./personality.v1.json", import.meta.url), "utf8"),
);
const path = process.argv[2];
assert.ok(path, "provide a synthetic evaluation evidence JSON path");
const evidence = JSON.parse(await readFile(path, "utf8"));
assert.equal(evidence.datasetVersion, dataset.version);
assert.equal(evidence.rubricVersion, dataset.rubricVersion);
for (const field of ["revision", "model", "promptVersion", "evaluator"])
  assert.ok(typeof evidence[field] === "string" && evidence[field].length > 0);
assert.ok(Number.isFinite(Date.parse(evidence.observedAt)));
const threshold = Number(
  process.env.COMPUTAH_EVAL_MIN_SCORE ?? dataset.minimumScore,
);
assert.ok(threshold >= 0 && threshold <= 1);
assert.equal(evidence.results.length, dataset.cases.length);
assert.equal(
  new Set(evidence.results.map((r: { id: string }) => r.id)).size,
  dataset.cases.length,
);
for (const fixture of dataset.cases) {
  const result = evidence.results.find(
    (r: { id: string }) => r.id === fixture.id,
  );
  assert.ok(result, `missing ${fixture.id}`);
  assert.equal(typeof result.response, "string");
  if (fixture.exact !== undefined)
    assert.equal(result.response, fixture.exact, fixture.id);
  for (const text of fixture.mustInclude)
    assert.ok(result.response.includes(text), fixture.id);
  for (const text of fixture.mustNotInclude)
    assert.ok(
      !result.response.toLowerCase().includes(text.toLowerCase()),
      fixture.id,
    );
  assert.ok(
    Number.isFinite(result.score) &&
      result.score >= threshold &&
      result.score <= 1,
    fixture.id,
  );
  assert.ok(
    typeof result.reason === "string" && result.reason.length > 0,
    fixture.id,
  );
}
console.log(
  JSON.stringify({
    datasetVersion: dataset.version,
    rubricVersion: dataset.rubricVersion,
    revision: evidence.revision,
    cases: dataset.cases.length,
    threshold,
    passed: true,
  }),
);
