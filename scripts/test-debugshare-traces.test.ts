import assert from "node:assert/strict";
import test from "node:test";
import { readTrace } from "../integrations/debugshare/traces.js";
import { axiomTraceUrl } from "../integrations/debugshare/ui/axiom.js";
import { traceRows } from "../integrations/debugshare/ui/waterfall.js";

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

const traceId = "a".repeat(32);
const when = "2026-11-08T11:00:00.000Z";
function table(rows: Record<string, unknown>[], partial = false) {
  const fields = [
    "_time",
    "trace_id",
    "span_id",
    "parent_span_id",
    "name",
    "duration_ms",
    "error",
    "service.name",
  ];
  return Response.json({
    status: { isPartial: partial },
    tables: [
      {
        fields: fields.map((name) => ({ name })),
        columns: fields.map((name) => rows.map((row) => row[name] ?? null)),
      },
    ],
  });
}
const root = {
  _time: when,
  trace_id: traceId,
  span_id: "1".repeat(16),
  parent_span_id: null,
  name: "receive",
  duration_ms: 3,
  error: false,
  "service.name": "slack",
};

test("live trace reads keep absolute timings, failures, hierarchy and parent gaps", async () => {
  const child = {
    ...root,
    _time: "2026-11-08T11:00:00.050Z",
    span_id: "2".repeat(16),
    parent_span_id: root.span_id,
    name: "capture",
    duration_ms: 12.5,
    error: true,
  };
  const orphan = {
    ...root,
    span_id: "3".repeat(16),
    parent_span_id: "f".repeat(16),
    name: "missing parent",
  };
  const result = await readTrace(
    async (url, init) => {
      assert.equal(url, "https://api.axiom.co/v1/datasets/_apl?format=tabular");
      const body = JSON.parse(String(init?.body));
      assert.match(
        body.apl,
        /where trace_id == 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'/,
      );
      assert.equal(body.startTime, "2026-11-07T11:00:00.000Z");
      assert.equal(body.endTime, "2026-11-09T11:00:00.000Z");
      assert.equal(init?.redirect, "manual");
      return table([child, root, orphan]);
    },
    new AbortController().signal,
    {},
    traceId,
    when,
  );
  assert.equal(result.spans.length, 3);
  const rows = traceRows(result.spans);
  assert.deepEqual(
    rows.map(({ span, depth, missingParent }) => [
      span.name,
      depth,
      missingParent,
    ]),
    [
      ["receive", 0, false],
      ["capture", 1, false],
      ["missing parent", 0, true],
    ],
  );
  assert.equal(result.spans[0]?.duration, 12.5);
  assert.equal(result.spans[0]?.start, Date.parse(when) + 50);
  assert.equal(result.spans[0]?.error, true);
  assert.equal(result.partial, false);
});

test("trace reads disclose truncation and upstream partial results, and reject foreign rows", async () => {
  for (const partial of [false, true]) {
    const result = await readTrace(
      async () =>
        table(
          Array.from({ length: 501 }, (_, i) => ({
            ...root,
            span_id: (i + 1).toString(16).padStart(16, "0"),
          })),
          partial,
        ),
      new AbortController().signal,
      {},
      traceId,
      when,
    );
    assert.equal(result.spans.length, 500);
    assert.equal(result.partial, true);
  }
  const partial = await readTrace(
    async () => table([root], true),
    new AbortController().signal,
    {},
    traceId,
    when,
  );
  assert.equal(partial.partial, true);
  await assert.rejects(
    readTrace(
      async () => table([{ ...root, trace_id: "b".repeat(32) }]),
      new AbortController().signal,
      {},
      traceId,
      when,
    ),
    /identity/,
  );
  const first = partial.spans[0];
  assert.ok(first);
  const cyclic = [
    { ...first, parent: "2".repeat(16) },
    { ...first, id: "2".repeat(16), parent: root.span_id },
  ];
  assert.equal(traceRows(cyclic).length, 2);
});

test("upstream denials, cancellation and oversized replies stay bounded and never echo response bodies", async () => {
  await assert.rejects(
    readTrace(
      async () => new Response("private upstream details", { status: 403 }),
      new AbortController().signal,
      {},
      traceId,
      when,
    ),
    {
      message:
        "Axiom refused trace access. Check the tracker’s read-only Axiom account.",
    },
  );
  const abort = new AbortController();
  await assert.rejects(
    readTrace(
      async (_url, init) => {
        abort.abort();
        assert.equal(init?.signal?.aborted, true);
        throw new Error("private transport details");
      },
      abort.signal,
      {},
      traceId,
      when,
    ),
    /Trace query cancelled/,
  );
  await assert.rejects(
    readTrace(
      async () => new Response("x".repeat(2_000_001)),
      new AbortController().signal,
      {},
      traceId,
      when,
    ),
    /2 MB limit/,
  );
});

test("post-header stream errors and cancellation hide upstream details", async () => {
  for (const cancelled of [false, true]) {
    const abort = new AbortController();
    await assert.rejects(
      readTrace(
        async () =>
          new Response(
            new ReadableStream({
              pull(controller) {
                if (cancelled) abort.abort();
                controller.error(new Error("private stream details"));
              },
            }),
          ),
        abort.signal,
        {},
        traceId,
        when,
      ),
      {
        message: cancelled
          ? "Trace query cancelled"
          : "Axiom trace query timed out or could not connect. Retry the load.",
      },
    );
  }
  await assert.rejects(
    readTrace(
      async () =>
        new Response(
          new ReadableStream({
            cancel() {
              throw new Error("private cancellation details");
            },
          }),
          { status: 403 },
        ),
      new AbortController().signal,
      {},
      traceId,
      when,
    ),
    /Axiom refused trace access/,
  );
});
