import type { Infer } from "apps";
import { createAppClient, queryReference } from "apps/client";
import { useEffect, useMemo, useState } from "react";
import type { getIssueTrace } from "../index.js";
import { TraceResult } from "../traces.js";
import { Button } from "./components/ui.js";
import { traceRows } from "./waterfall.js";

const ms = (value: number) =>
  `${value.toLocaleString(undefined, { maximumFractionDigits: 3 })} ms`;

export function TraceViewer({
  id,
  correlation,
  label,
}: {
  id: string;
  correlation: "capture" | "transport";
  label: string;
}) {
  const client = useMemo(() => createAppClient(), []);
  const [attempt, setAttempt] = useState(0);
  const [data, setData] = useState<Infer<typeof TraceResult>>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(
    () => () => {
      void client.dispose();
    },
    [client],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt explicitly invalidates the one-shot query when Reload spans is pressed.
  useEffect(() => {
    let current = true;
    setLoading(true);
    setError("");
    void client
      .query(
        queryReference<typeof getIssueTrace>("getIssueTrace"),
        { id, correlation },
        TraceResult,
      )
      .then((result) => {
        if (current) setData(result);
      })
      .catch((failure) => {
        if (current)
          setError(
            failure instanceof Error
              ? failure.message
              : "Trace load failed. Retry or open Axiom.",
          );
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [client, id, correlation, attempt]);
  const spans = data?.spans ?? [];
  const start = spans.length ? Math.min(...spans.map((span) => span.start)) : 0;
  const end = spans.length
    ? Math.max(...spans.map((span) => span.start + span.duration))
    : 0;
  const duration = Math.max(end - start, 0.001);
  return (
    <section className="trace-viewer" aria-label={label}>
      <div className="trace-toolbar">
        <h3>{label}</h3>
        <Button
          type="button"
          variant="outline"
          disabled={loading}
          onClick={() => setAttempt((n) => n + 1)}
        >
          {loading ? "Loading spans…" : "Reload spans"}
        </Button>
      </div>
      <div aria-live="polite">
        {loading && <p>Querying Axiom for this report’s recorded trace…</p>}
        {error && (
          <p role="alert" className="text-red-300">
            {error}
          </p>
        )}
        {!loading && data?.notice && <p>{data.notice}</p>}
        {data?.partial && (
          <p role="status">
            Partial trace: at most 500 spans are shown. Open Axiom for the
            complete result.
          </p>
        )}
      </div>
      {spans.length > 0 && (
        <>
          <p className="trace-summary">
            {spans.length} spans · {ms(end - start)} elapsed ·{" "}
            {spans.filter((span) => span.error).length} errors
            {loading || error ? " · previous result" : ""}
          </p>
          <section
            className="trace-scroll"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: The overflowing viewport must be keyboard-scrollable.
            tabIndex={0}
            aria-label="Trace waterfall. Scroll horizontally on narrow screens."
          >
            <div className="trace-axis">
              <span>Operation / service</span>
              <span>
                0 ms<span>{ms(end - start)}</span>
              </span>
            </div>
            {traceRows(spans).map(({ span, depth, missingParent }) => (
              <details
                className={`trace-span${span.error ? " trace-error" : ""}`}
                key={span.id}
              >
                <summary>
                  <span
                    className="trace-name"
                    style={{ paddingLeft: `${Math.min(depth, 8) * 12}px` }}
                  >
                    <svg
                      className="trace-chevron"
                      aria-hidden="true"
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <path d="m9 5 7 7-7 7" />
                    </svg>
                    <strong>{span.name}</strong>
                    <small>
                      {span.service}
                      {missingParent ? " · parent not in result" : ""}
                      {span.error ? " · error" : ""}
                    </small>
                  </span>
                  <span
                    className="trace-lane"
                    role="img"
                    aria-label={`${span.name}: starts at ${ms(span.start - start)}, lasts ${ms(span.duration)}${span.error ? ", error" : ""}`}
                  >
                    <span
                      className="trace-bar"
                      style={{
                        left: `${((span.start - start) / duration) * 100}%`,
                        width: `${(span.duration / duration) * 100}%`,
                      }}
                    />
                  </span>
                  <span className="trace-duration">{ms(span.duration)}</span>
                </summary>
                <div className="trace-span-detail">
                  <p>
                    Span <code>{span.id}</code> · parent{" "}
                    <code>{span.parent || "none"}</code> ·{" "}
                    {new Date(span.start).toISOString()}
                  </p>
                  <pre>{JSON.stringify(span.fields, null, 2)}</pre>
                </div>
              </details>
            ))}
          </section>
        </>
      )}
    </section>
  );
}
