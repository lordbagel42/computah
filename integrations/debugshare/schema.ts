import { array, json, number, object, string } from "apps";

export const Report = object({
  // apps.string supports minLength only; exact dual-format validation is enforced
  // by isDebugshareId at import, lookup and update, not by a parallel schema regex.
  id: string({ minLength: 1 }),
  requestedAt: string(),
  requestedBy: string(),
  source: object({
    team: string(),
    channel: string(),
    message: string(),
    thread: json(),
  }),
  scope: object({ tenantId: string(), userId: string(), agentId: string() }),
  transport: object({
    requestId: string(),
    traceId: string(),
    spanId: string(),
  }).optional(),
  capture: object({ traceId: string(), spanId: string() }).optional(),
  messages: array(object({ author: string(), ts: string(), text: string() })),
  participants: array(string()),
  submissions: array(string()),
  activity: array(string()),
  limitations: array(string()),
});
export const Summary = object({
  id: string(),
  title: string(),
  status: string(),
  assignee: string(),
  revision: number(),
  created: string(),
  updated: string(),
});
export const Event = object({
  id: string(),
  status: string(),
  actor: string(),
  note: string(),
  created: string(),
});
export const Detail = object({
  issue: Summary,
  report: Report,
  events: array(Event),
});
// Explorer projections: bounded read-only views over the same two tables.
// json() fields are nullable: optional report fields stay absent, not invented.
export const IndexRow = object({
  id: string(),
  title: string(),
  status: string(),
  assignee: string(),
  revision: number(),
  created: string(),
  updated: string(),
  bytes: number(),
  requestedAt: string(),
  requestedBy: string(),
  team: string(),
  channel: string(),
  message: string(),
  thread: json(),
  tenantId: string(),
  userId: string(),
  agentId: string(),
  requestId: json(),
  transportTrace: json(),
  transportSpan: json(),
  captureTrace: json(),
  captureSpan: json(),
  participants: array(string()),
  submissions: array(string()),
  messageCount: number(),
  submissionCount: number(),
  activityCount: number(),
  limitationCount: number(),
  eventCount: number(),
  firstResponse: json(),
  lastActor: string(),
  lastNote: string(),
});
export const FeedEvent = object({
  id: string(),
  issue: string(),
  title: string(),
  status: string(),
  actor: string(),
  note: string(),
  created: string(),
});
export const Explore = object({
  issues: array(IndexRow),
  events: array(FeedEvent),
  totals: object({
    issues: number(),
    events: number(),
    messages: number(),
    bytes: number(),
  }),
});
export const SearchInput = object({
  text: string(),
  author: string(),
  channel: string(),
  submission: string(),
  trace: string(),
  actor: string(),
});
export const SearchResult = object({
  issues: array(string()),
  messages: array(
    object({
      channel: string(),
      ts: string(),
      author: string(),
      text: string(),
      issues: array(string()),
    }),
  ),
  events: array(FeedEvent),
});
export const Inspection = object({
  issue: Summary,
  report: Report,
  events: array(Event),
  snapshot: object({ bytes: number(), sha256: string() }),
  related: array(
    object({
      id: string(),
      title: string(),
      status: string(),
      created: string(),
      reasons: array(string()),
    }),
  ),
});
export const statuses = [
  "open",
  "investigating",
  "blocked",
  "resolved",
] as const;
