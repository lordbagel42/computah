CREATE TABLE operator_grants (
  user_id TEXT PRIMARY KEY REFERENCES user(id),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1))
);
CREATE TABLE bootstrap_claim (
  id INTEGER PRIMARY KEY CHECK(id=1),
  email TEXT NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0 CHECK(completed IN (0,1))
);
