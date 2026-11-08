import type { Infer } from "apps";
import {
  createAppClient,
  mutationReference,
  queryReference,
} from "apps/client";
import { useAppQuery } from "apps/react";
import { useMemo } from "react";
import type { explore, inspectIssue, search, updateIssue } from "../index.js";
import { Explore, type IndexRow, Inspection, SearchResult } from "../schema.js";

export const client = createAppClient();
export const exploreAtom = client.queryAtom(
  queryReference<typeof explore>("explore"),
  {},
  Explore,
);
export const updateRef = mutationReference<typeof updateIssue>("updateIssue");
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

export const useExplore = () => useAppQuery(exploreAtom);
export function useInspection(id: string) {
  const atom = useMemo(
    () =>
      client.queryAtom(
        queryReference<typeof inspectIssue>("inspectIssue"),
        { id },
        Inspection,
      ),
    [id],
  );
  return useAppQuery(atom);
}
export function useSearch(filters: Filters) {
  const key = JSON.stringify(filters);
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by value
  const atom = useMemo(
    () =>
      client.queryAtom(
        queryReference<typeof search>("search"),
        filters,
        SearchResult,
      ),
    [key],
  );
  return useAppQuery(atom);
}
