import { array, type Infer } from "apps";
import {
  createAppClient,
  mutationReference,
  queryReference,
} from "apps/client";
import { useAppQuery } from "apps/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { getIssue, listIssues, updateIssue } from "../index.js";
import { Detail, Summary, statuses } from "../schema.js";
import "./style.css";

const client = createAppClient();
const list = client.queryAtom(
  queryReference<typeof listIssues>("listIssues"),
  {},
  array(Summary),
);
const update = mutationReference<typeof updateIssue>("updateIssue");
const date = (value: string) => new Date(value).toLocaleString();
function Badge({ status }: { status: string }) {
  return <span className={`badge ${status}`}>{status}</span>;
}

function Resolution({ issue }: { issue: Infer<typeof Summary> }) {
  const [status, setStatus] = useState(issue.status);
  const [assignee, setAssignee] = useState(issue.assignee);
  const [revision, setRevision] = useState(issue.revision);
  const [actor, setActor] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  return (
    <form
      className="resolution"
      onSubmit={async (event) => {
        event.preventDefault();
        setSaving(true);
        setError("");
        try {
          const saved = await client.mutate(
            update,
            {
              id: issue.id,
              expectedRevision: revision,
              status,
              assignee,
              actor,
              note,
            },
            Summary,
          );
          setRevision(saved.revision);
          setNote("");
        } catch (error) {
          setError(
            error instanceof Error
              ? error.message
              : "Update failed. Refresh and check the saved state before retrying.",
          );
        } finally {
          setSaving(false);
        }
      }}
    >
      <h2>Resolution</h2>
      {issue.revision > revision && !saving && (
        <div role="status" className="error">
          <p>
            Another operator updated this issue. Your draft is preserved, but
            cannot overwrite the newer revision. Copy any evidence you want to
            keep before loading the latest state.
          </p>
          <button
            type="button"
            onClick={() => {
              setRevision(issue.revision);
              setStatus(issue.status);
              setAssignee(issue.assignee);
              setNote("");
              setError("");
            }}
          >
            Discard draft and load latest
          </button>
        </div>
      )}
      <div className="form-grid">
        <label>
          State
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            {statuses.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <label>
          Assigned to
          <input
            value={assignee}
            maxLength={200}
            onChange={(e) => setAssignee(e.target.value)}
            placeholder="Agent or operator"
          />
        </label>
        <label>
          Updated by
          <input
            required
            value={actor}
            maxLength={200}
            onChange={(e) => setActor(e.target.value)}
            placeholder="Declared attribution"
          />
        </label>
      </div>
      <label>
        Investigation or resolution evidence
        <textarea
          required
          maxLength={4000}
          rows={3}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="What changed? What evidence supports this state?"
        />
      </label>
      <div className="form-footer">
        <p>
          Revision {revision} · authenticated writes · attribution is
          self-declared
        </p>
        <button
          type="submit"
          disabled={
            saving || issue.revision > revision || !actor.trim() || !note.trim()
          }
        >
          {saving ? "Saving…" : "Save update"}
        </button>
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </form>
  );
}

function IssueView({ id }: { id: string }) {
  const atom = useMemo(
    () =>
      client.queryAtom(
        queryReference<typeof getIssue>("getIssue"),
        { id },
        Detail,
      ),
    [id],
  );
  const { data, pending, error } = useAppQuery(atom);
  const lastSaved = useRef(data);
  if (data) lastSaved.current = data;
  const snapshot = data ?? lastSaved.current;
  if (!snapshot)
    return (
      <section className="detail empty" aria-live="polite">
        <h2>{pending ? "Loading captured report…" : "Report unavailable"}</h2>
        <p>{error || "Resolving the exact issue ID."}</p>
      </section>
    );
  const { issue, report, events } = snapshot;
  const source = report.source;
  const slack = `slack://channel?team=${encodeURIComponent(source.team)}&id=${encodeURIComponent(source.channel)}`;
  return (
    <article className="detail">
      {error && (
        <p className="error" role="alert">
          Refresh failed. Showing the last saved report: {error}
        </p>
      )}
      <header className="issue-heading">
        <div>
          <div className="issue-id">{issue.id}</div>
          <h1>{issue.title}</h1>
          <p>
            Requested by {report.requestedBy} · {date(report.requestedAt)}
          </p>
        </div>
        <Badge status={issue.status} />
      </header>
      <section className="source" aria-labelledby="source-title">
        <h2 id="source-title">Conversation pointer</h2>
        <dl>
          <div>
            <dt>Workspace / location</dt>
            <dd>
              {source.team} / {source.channel}
            </dd>
          </div>
          <div>
            <dt>Message / thread</dt>
            <dd>
              {source.message} /{" "}
              {typeof source.thread === "string" ? source.thread : "top-level"}
            </dd>
          </div>
          <div>
            <dt>Participants in snapshot</dt>
            <dd>{report.participants.join(", ")}</dd>
          </div>
          <div>
            <dt>Trusted core scope</dt>
            <dd>
              {report.scope.tenantId} / {report.scope.userId} /{" "}
              {report.scope.agentId}
            </dd>
          </div>
        </dl>
        <a href={slack}>Open originating Slack conversation</a>
      </section>
      <section aria-labelledby="snapshot-title">
        <div className="section-heading">
          <h2 id="snapshot-title">Conversation snapshot</h2>
          <span>{report.messages.length} captured messages · partial</span>
        </div>
        <ol className="messages">
          {report.messages.map((message) => (
            <li key={message.ts}>
              <div className="message-meta">
                <strong>{message.author}</strong>
                <time>{message.ts}</time>
              </div>
              <p>{message.text}</p>
            </li>
          ))}
        </ol>
      </section>
      <section className="evidence" aria-labelledby="activity-title">
        <h2 id="activity-title">Computah activity & correlation</h2>
        <ul>
          {report.activity.map((entry) => (
            <li key={entry}>{entry}</li>
          ))}
        </ul>
        <dl>
          <div>
            <dt>Capture trace / span</dt>
            <dd>
              {report.capture
                ? `${report.capture.traceId} / ${report.capture.spanId}`
                : "No capture span was retained in this report."}
            </dd>
          </div>
          <div>
            <dt>Transport receipt (not a core submission)</dt>
            <dd>{report.transport?.requestId ?? "Not retained"}</dd>
          </div>
          {report.transport && (
            <div>
              <dt>Receive trace / span</dt>
              <dd>
                {report.transport.traceId} / {report.transport.spanId}
              </dd>
            </div>
          )}
        </dl>
        <h3>Observed submission handles</h3>
        {report.submissions.length ? (
          <ul className="identifiers">
            {report.submissions.map((id) => (
              <li key={id}>{id}</li>
            ))}
          </ul>
        ) : (
          <p>No submission handle was available at this location.</p>
        )}
        <details>
          <summary>Capture boundaries and unavailable evidence</summary>
          <ul>
            {report.limitations.map((entry) => (
              <li key={entry}>{entry}</li>
            ))}
          </ul>
        </details>
      </section>
      <Resolution key={issue.id} issue={issue} />
      <section className="timeline" aria-labelledby="timeline-title">
        <h2 id="timeline-title">Investigation history</h2>
        <ol>
          {events.map((entry) => (
            <li key={entry.id}>
              <div>
                <Badge status={entry.status} />
                <strong>{entry.actor}</strong>
                <time>{date(entry.created)}</time>
              </div>
              <p>{entry.note}</p>
            </li>
          ))}
        </ol>
      </section>
    </article>
  );
}

function App() {
  const { data, pending, error } = useAppQuery(list);
  const [id, setId] = useState(location.hash.slice(1));
  const [lookup, setLookup] = useState("");
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  useEffect(() => {
    const change = () => setId(location.hash.slice(1));
    addEventListener("hashchange", change);
    return () => removeEventListener("hashchange", change);
  }, []);
  const issues = (data ?? []).filter(
    (issue) =>
      (filter === "all" || issue.status === filter) &&
      `${issue.id} ${issue.title} ${issue.assignee}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  return (
    <main>
      <header className="app-heading">
        <a href={location.pathname} className="brand">
          Computah <span>Issues</span>
        </a>
        <span className="internal">Internal · Executor authentication</span>
      </header>
      <div className="workspace">
        <aside className="inbox">
          <div className="inbox-heading">
            <h1>Debugshares</h1>
            <span>{data?.length ?? 0} recent</span>
          </div>
          <p>From a conversation to a tracked resolution.</p>
          <form
            className="lookup"
            onSubmit={(event) => {
              event.preventDefault();
              location.hash = lookup.trim();
            }}
          >
            <label htmlFor="issue-id">Look up an exact issue ID</label>
            <div>
              <input
                id="issue-id"
                value={lookup}
                onChange={(e) => setLookup(e.target.value)}
                placeholder="Paste DEBUGSHARE ID"
                required
              />
              <button type="submit">Open</button>
            </div>
          </form>
          <label className="search">
            Search recent issues
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Title, issue ID or assignee"
            />
          </label>
          <label className="filter">
            Filter state
            <select value={filter} onChange={(e) => setFilter(e.target.value)}>
              <option value="all">All states</option>
              {statuses.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
          {error && (
            <p role="alert" className="error">
              Could not refresh: {error}
            </p>
          )}
          {pending ? (
            <p aria-live="polite">Loading issues…</p>
          ) : issues.length ? (
            <ol className="issue-list">
              {issues.map((issue) => (
                <li key={issue.id}>
                  <a
                    className={id === issue.id ? "selected" : ""}
                    href={`#${issue.id}`}
                    aria-current={id === issue.id ? "page" : undefined}
                  >
                    <div>
                      <Badge status={issue.status} />
                      <time>
                        {new Date(issue.created).toLocaleDateString()}
                      </time>
                    </div>
                    <strong>{issue.title}</strong>
                    <small>
                      {issue.assignee || "Unassigned"} · {issue.id}
                    </small>
                  </a>
                </li>
              ))}
            </ol>
          ) : (
            <div className="empty-list">
              <h2>
                {data?.length
                  ? "No matching issues"
                  : "No captured reports yet"}
              </h2>
              <p>
                {data?.length
                  ? "Change your search or state filter."
                  : "Send DEBUGSHARE with a short issue description in an authorized Computah conversation. Reports appear after the uploader is connected."}
              </p>
            </div>
          )}
        </aside>
        {id ? (
          <IssueView key={id} id={id} />
        ) : (
          <section className="detail empty">
            <h2>Follow the evidence.</h2>
            <p>
              Choose a report to see the actual conversation snapshot, its
              origin and the investigation history.
            </p>
            <p>
              Existing identifier-only UUIDs cannot recover context that was
              never stored.
            </p>
          </section>
        )}
      </div>
    </main>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing app root");
createRoot(root).render(<App />);
