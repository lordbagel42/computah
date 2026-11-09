import type { Infer } from "apps";
import type { Explore, IndexRow, Inspection, SearchResult } from "../schema.js";
export type Row = Infer<typeof IndexRow>;
export type ExploreData = Infer<typeof Explore>;
export type InspectionData = Infer<typeof Inspection>;
export type SearchData = Infer<typeof SearchResult>;
export type Filters = {
  text: string;
  author: string;
  channel: string;
  submission: string;
  trace: string;
  actor: string;
};
export const noFilter: Filters = {
  text: "",
  author: "",
  channel: "",
  submission: "",
  trace: "",
  actor: "",
};

export async function request<T>(
  path: string,
  input?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    method: input === undefined ? "GET" : "POST",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    signal,
    ...(input === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        }),
  });
  if (response.status === 401 && path.startsWith("/api/tools/"))
    window.dispatchEvent(new Event("session-expired"));
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: unknown;
      message?: unknown;
    } | null;
    throw new Error(
      typeof body?.error === "string"
        ? body.error
        : typeof body?.message === "string"
          ? body.message
          : `Request failed (${response.status}). Please retry.`,
    );
  }
  return response.status === 204 ? (undefined as T) : response.json();
}

export const tool = <T>(name: string, input: unknown, signal?: AbortSignal) =>
  request<T>(`/api/tools/${encodeURIComponent(name)}`, input, signal);
