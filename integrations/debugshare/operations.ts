import type { Schema } from "apps";

export interface Sql {
  exec<T extends Record<string, unknown>>(
    statement: string,
    ...bindings: (string | number | null)[]
  ): { toArray(): T[]; one(): T };
  transaction<T>(body: () => T): T;
}
export interface Context {
  sql: Sql;
  fetch: typeof fetch;
  signal: AbortSignal;
  traceToken?: string;
}

/** Renderer-neutral operations: authorization belongs to the Worker, not input JSON. */
export function operation<I, O>(
  options: { description: string; input: Schema<I>; output: Schema<O> },
  run: (context: Context, input: I) => Promise<O>,
) {
  return {
    async invoke(context: Context, input: unknown): Promise<O> {
      return options.output.parse(
        await run(context, options.input.parse(input)),
      );
    },
  };
}
