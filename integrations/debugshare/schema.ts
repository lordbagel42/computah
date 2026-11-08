import { array, json, number, object, string } from "apps";

export const Report = object({
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
export const statuses = [
  "open",
  "investigating",
  "blocked",
  "resolved",
] as const;
