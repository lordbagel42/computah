CREATE TABLE issues (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('open','investigating','blocked','resolved')),
  assignee TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1,
  report TEXT NOT NULL,
  created TEXT NOT NULL,
  updated TEXT NOT NULL
);
CREATE INDEX issues_updated ON issues(updated);
CREATE TABLE issue_events (
  id TEXT PRIMARY KEY NOT NULL,
  issue TEXT NOT NULL REFERENCES issues(id),
  status TEXT NOT NULL,
  actor TEXT NOT NULL,
  note TEXT NOT NULL,
  created TEXT NOT NULL
);
CREATE INDEX issue_events_issue ON issue_events(issue,created);
