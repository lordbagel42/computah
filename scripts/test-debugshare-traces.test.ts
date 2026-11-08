import assert from "node:assert/strict";
import test from "node:test";
import { axiomTraceUrl } from "../integrations/debugshare/ui/axiom.js";

test("Axiom links select the exact recorded trace with a bounded absolute time range", () => {
  const traceId = "7d1dc86a056a08c639788082c425edf0";
  const href = axiomTraceUrl(traceId, "2026-11-08T10:21:56.893Z");
  assert.ok(href);
  const url = new URL(href);
  assert.equal(url.origin, "https://app.axiom.co");
  assert.equal(url.pathname, "/bagel-w3ue/query");
  assert.equal(url.username, "");
  assert.equal(url.password, "");
  assert.deepEqual(JSON.parse(url.searchParams.get("initForm") ?? ""), {
    apl: "['computah-prod-traces'] | where trace_id == '7d1dc86a056a08c639788082c425edf0' | sort by _time asc",
    queryOptions: {
      startTime: "2026-11-07T10:21:56.893Z",
      endTime: "2026-11-09T10:21:56.893Z",
    },
  });
  assert.equal(url.searchParams.size, 1);
});

test("missing or malformed correlations never become trace queries", () => {
  for (const traceId of [
    undefined,
    "",
    "0".repeat(32),
    "f".repeat(31),
    "f".repeat(33),
    "A".repeat(32),
    `${"f".repeat(32)}\n`,
    "x' | take 1000 //",
  ])
    assert.equal(axiomTraceUrl(traceId, "2026-11-08T10:21:56.893Z"), null);
  assert.equal(axiomTraceUrl("a".repeat(32), "invalid"), null);
});
