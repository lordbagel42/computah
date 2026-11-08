import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { debugshareIdPattern, isDebugshareId } from "../ids.js";
import {
  axiomIssueUrl,
  axiomLogsUrl,
  axiomSpanUrl,
  axiomTraceUrl,
} from "./axiom.js";

export { isDebugshareId };
export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));

// ---------- routing: hash only, so `#<issue id>` links keep working ----------
export type Route =
  | { view: "overview" }
  | { view: "issues" }
  | { view: "activity" }
  | { view: "search"; q: string }
  | { view: "tables"; table: string }
  | { view: "index"; kind: EntityKind }
  | { view: "entity"; kind: EntityKind; value: string }
  | { view: "issue"; id: string; section?: string; message?: string }
  | { view: "unknown"; raw: string };
export type EntityKind =
  | "people"
  | "channels"
  | "traces"
  | "submissions"
  | "actors";
export const entityKinds: EntityKind[] = [
  "people",
  "channels",
  "traces",
  "submissions",
  "actors",
];

export function parseRoute(hash: string): Route {
  let raw: string;
  try {
    raw = decodeURIComponent(hash.replace(/^#/, ""));
  } catch {
    return { view: "unknown", raw: hash.replace(/^#/, "") };
  }
  if (!raw || raw === "/") return { view: "overview" };
  if (!raw.startsWith("/")) {
    const [id, a, b] = raw.split("/");
    if (!isDebugshareId(id)) return { view: "unknown", raw };
    if (a === "m" && b) return { view: "issue", id, message: b };
    return { view: "issue", id, section: a };
  }
  const [, head, ...rest] = raw.split("/");
  const tail = rest.join("/");
  if (head === "issues") return { view: "issues" };
  if (head === "activity") return { view: "activity" };
  if (head === "search") return { view: "search", q: tail };
  if (head === "tables") return { view: "tables", table: tail || "issues" };
  if ((entityKinds as string[]).includes(head))
    return tail
      ? { view: "entity", kind: head as EntityKind, value: tail }
      : { view: "index", kind: head as EntityKind };
  return { view: "unknown", raw };
}
const enc = encodeURIComponent;
export const href = {
  overview: "#",
  issues: "#/issues",
  activity: "#/activity",
  search: (q: string) => `#/search/${enc(q)}`,
  tables: (t = "issues") => `#/tables/${t}`,
  index: (k: EntityKind) => `#/${k}`,
  entity: (k: EntityKind, v: string) => `#/${k}/${enc(v)}`,
  issue: (id: string, section?: string) =>
    `#${id}${section ? `/${section}` : ""}`,
  message: (id: string, ts: string) => `#${id}/m/${enc(ts)}`,
};
/** Single-key shortcuts ignore modified keys and focused controls. */
export const ignoreShortcut = (e: KeyboardEvent) =>
  e.metaKey ||
  e.ctrlKey ||
  e.altKey ||
  !!(e.target as HTMLElement | null)?.closest?.(
    "a,button,input,textarea,select,[contenteditable],[role=dialog]",
  );
export const absolute = (hash: string) =>
  `${location.origin}${location.pathname}${hash}`;

// ---------- time & numbers ----------
export const slackDate = (ts: string) => {
  const n = Number(ts);
  return Number.isFinite(n) && n > 1e9 ? new Date(n * 1000) : null;
};
const two = (n: number) => String(n).padStart(2, "0");
export const fmtDate = (d: Date | string | null | undefined) => {
  if (!d) return "—";
  const x = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(x.getTime())) return String(d);
  return `${x.getFullYear()}-${two(x.getMonth() + 1)}-${two(x.getDate())} ${two(x.getHours())}:${two(x.getMinutes())}:${two(x.getSeconds())}`;
};
export const fmtTime = (d: Date) =>
  `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
export const duration = (ms: number) => {
  const a = Math.abs(ms);
  if (a < 1000) return `${Math.round(a)}ms`;
  if (a < 60_000) return `${(a / 1000).toFixed(a < 10_000 ? 2 : 1)}s`;
  if (a < 3_600_000)
    return `${Math.floor(a / 60_000)}m ${Math.round((a % 60_000) / 1000)}s`;
  if (a < 86_400_000)
    return `${Math.floor(a / 3_600_000)}h ${Math.round((a % 3_600_000) / 60_000)}m`;
  return `${Math.floor(a / 86_400_000)}d ${Math.round((a % 86_400_000) / 3_600_000)}h`;
};
export const ago = (d: string | Date, now = Date.now()) => {
  const t = typeof d === "string" ? Date.parse(d) : d.getTime();
  if (!Number.isFinite(t)) return "";
  const s = (now - t) / 1000;
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};
export const bytes = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1048576
      ? `${(n / 1024).toFixed(1)} KB`
      : `${(n / 1048576).toFixed(2)} MB`;
export const plural = (n: number, word: string) =>
  `${n} ${word}${n === 1 ? "" : "s"}`;

// ---------- external destinations (no credentials; viewers sign in there) ----------
// Axiom deep links share the strict validation and +/-1 day window in axiom.ts.
export const axiom = {
  trace: (trace: string, around?: string | null) =>
    axiomTraceUrl(trace, around ?? ""),
  logs: (trace: string, around?: string | null) =>
    axiomLogsUrl(trace, around ?? ""),
  span: (span: string, around?: string | null) =>
    axiomSpanUrl(span, around ?? ""),
  issue: (id: string, around?: string | null) =>
    axiomIssueUrl(id, around ?? ""),
};
export const slack = {
  channelApp: (team: string, channel: string) =>
    `slack://channel?team=${enc(team)}&id=${enc(channel)}`,
  channelWeb: (team: string, channel: string) =>
    `https://slack.com/app_redirect?team=${enc(team)}&channel=${enc(channel)}`,
  userApp: (team: string, user: string) =>
    `slack://user?team=${enc(team)}&id=${enc(user)}`,
};
export const isRealSlack = (team: string) => /^T[A-Z0-9]{6,}$/.test(team);
export const ampThread = (id: string) => `https://ampcode.com/threads/${id}`;
export const commitUrl = (sha: string) =>
  `https://github.com/lordbagel42/computah/commit/${sha}`;
export const isSynthetic = (row: { team: string; tenantId?: string }) =>
  row.team === "SYNTHETIC" || row.tenantId === "synthetic";

// ---------- linkify: every identifier in stored text becomes a destination ----------
export type Token =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | {
      kind: "link";
      text: string;
      href: string;
      external: boolean;
      type: string;
      prefix?: string;
    };
const sources = [
  String.raw`https?:\/\/[^\s<>()\]|]+[^\s<>()\]|.,;:!?'"’]`,
  String.raw`\bT-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b`,
  debugshareIdPattern,
  "(?<![0-9a-f])[0-9a-f]{40}(?![0-9a-f])",
  "(?:trace|(?<![0-9a-f]))[0-9a-f]{32}(?![0-9a-f])",
  "(?:span|(?<![0-9a-zA-Z]))[0-9a-f]{16}(?![0-9a-zA-Z])",
  String.raw`\b[UW](?=[A-Z0-9]*\d)[A-Z0-9]{8,10}\b`,
  String.raw`\b[CDG](?=[A-Z0-9]*\d)[A-Z0-9]{8,10}\b`,
  "`[^`\\n]+`",
];
const combined = new RegExp(sources.map((s) => `(${s})`).join("|"), "gu");
const trackerHost = "computah-issues.raygen.executor.website";

export function tokenize(text: string, around?: string | null): Token[] {
  const out: Token[] = [];
  let last = 0;
  for (const m of text.matchAll(combined)) {
    const start = m.index ?? 0;
    if (start > last) out.push({ kind: "text", text: text.slice(last, start) });
    last = start + m[0].length;
    const v = m[0];
    const group = m.slice(1).findIndex((g) => g !== undefined);
    const link = (
      type: string,
      h: string,
      external: boolean,
      shown = v,
      prefix?: string,
    ) =>
      out.push({ kind: "link", text: shown, href: h, external, type, prefix });
    switch (group) {
      case 0: {
        let url: URL | null = null;
        try {
          url = new URL(v);
        } catch {
          // Stored text is untrusted: an invalid URL stays plain text.
        }
        if (!url) out.push({ kind: "text", text: v });
        else if (url.host === trackerHost && isDebugshareId(url.hash.slice(1)))
          link("issue", url.hash, false);
        else link(url.host.includes("axiom.co") ? "axiom" : "url", v, true);
        break;
      }
      case 1:
        link("amp", ampThread(v), true);
        break;
      case 2:
        link("issue", href.issue(v), false);
        break;
      case 3:
        link("commit", commitUrl(v), true);
        break;
      case 4: {
        const prefix = v.startsWith("trace") ? "trace" : undefined;
        const id = prefix ? v.slice(5) : v;
        link("trace", href.entity("traces", id), false, id, prefix);
        break;
      }
      case 5: {
        const prefix = v.startsWith("span") ? "span" : undefined;
        const id = prefix ? v.slice(4) : v;
        const url = axiom.span(id, around);
        if (url) link("span", url, true, id, prefix);
        else out.push({ kind: "text", text: v });
        break;
      }
      case 6:
        link("user", href.entity("people", v), false);
        break;
      case 7:
        link("channel", href.entity("channels", v), false);
        break;
      default:
        out.push({ kind: "code", text: v.slice(1, -1) });
    }
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}

export const statusOrder = [
  "open",
  "investigating",
  "blocked",
  "resolved",
] as const;
export const statusTone: Record<string, string> = {
  open: "text-sky-300 bg-sky-400/10 ring-sky-400/25",
  investigating: "text-amber-300 bg-amber-400/10 ring-amber-400/25",
  blocked: "text-rose-300 bg-rose-400/10 ring-rose-400/25",
  resolved: "text-emerald-300 bg-emerald-400/10 ring-emerald-400/25",
};
export const statusDot: Record<string, string> = {
  open: "bg-sky-400",
  investigating: "bg-amber-400",
  blocked: "bg-rose-400",
  resolved: "bg-emerald-400",
};
export const statusFill: Record<string, string> = {
  open: "#38bdf8",
  investigating: "#fbbf24",
  blocked: "#fb7185",
  resolved: "#34d399",
};
