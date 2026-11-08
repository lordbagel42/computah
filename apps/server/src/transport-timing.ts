import { readFileSync, statSync } from "node:fs";
import { request } from "node:http";
import { isAbsolute } from "node:path";
import { currentTraceHeaders, traceOperation } from "@computah/observability";
import type { Capability, Scope } from "./core.js";

export type TransportTimingResult =
  | { status: "unavailable"; code: string }
  | {
      status: "ready";
      source: "Slack durable receipts";
      units: "ms";
      timing: {
        traceparent: string | null;
        receivedAt: number | null;
        senderTs: string | null;
        admittedAt: number | null;
        firstDequeuedAt: number | null;
        state: string;
        receipts: {
          receivedAt: number | null;
          senderTs: string | null;
          admittedAt: number | null;
        }[];
        phases: {
          phase: string;
          attempt: number;
          started: number;
          completed: number | null;
          outcome: string | null;
        }[];
      };
      truncated: boolean;
    };

/** Host-only callback: requestId is resolved from the durable Interaction receipt. */
export type TransportTiming = (
  scope: Readonly<Scope>,
  requestId: string,
  signal: AbortSignal,
  parent?: Record<string, string>,
) => Promise<TransportTimingResult>;

function project(
  value: unknown,
): Extract<TransportTimingResult, { status: "ready" }> {
  const object = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid timing response");
    return value as Record<string, unknown>;
  };
  const clock = (value: unknown): number => {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
      throw new Error("Invalid timing clock");
    return value;
  };
  const nullableClock = (value: unknown) =>
    value === null ? null : clock(value);
  const category = (value: unknown): string => {
    if (typeof value !== "string" || !/^[a-z][a-z0-9_.-]{0,63}$/.test(value))
      throw new Error("Invalid timing category");
    return value;
  };
  const sender = (value: unknown): string | null => {
    if (value === null) return null;
    if (typeof value !== "string" || !/^\d{1,16}\.\d{6}$/.test(value))
      throw new Error("Invalid sender timestamp");
    return value;
  };
  const timing = object(object(value).timing);
  if (
    !Array.isArray(timing.receipts) ||
    timing.receipts.length > 2048 ||
    !Array.isArray(timing.phases) ||
    timing.phases.length > 2048
  )
    throw new Error("Invalid timing arrays");
  const carrier = timing.traceparent;
  if (
    carrier !== null &&
    (typeof carrier !== "string" ||
      !/^00-(?!0{32})[a-f0-9]{32}-(?!0{16})[a-f0-9]{16}-0[01]$/.test(carrier))
  )
    throw new Error("Invalid timing correlation");
  return {
    status: "ready",
    source: "Slack durable receipts",
    units: "ms",
    truncated: false,
    timing: {
      traceparent: carrier as string | null,
      receivedAt: nullableClock(timing.receivedAt),
      senderTs: sender(timing.senderTs),
      admittedAt: nullableClock(timing.admittedAt),
      firstDequeuedAt: nullableClock(timing.firstDequeuedAt),
      state: category(timing.state),
      receipts: timing.receipts.map((item) => {
        const receipt = object(item);
        return {
          receivedAt: nullableClock(receipt.receivedAt),
          senderTs: sender(receipt.senderTs),
          admittedAt: nullableClock(receipt.admittedAt),
        };
      }),
      phases: timing.phases.map((item) => {
        const phase = object(item);
        const started = clock(phase.started),
          completed = nullableClock(phase.completed);
        if (completed !== null && completed < started)
          throw new Error("Invalid timing interval");
        return {
          phase: category(phase.phase),
          attempt: clock(phase.attempt),
          started,
          completed,
          outcome: phase.outcome === null ? null : category(phase.outcome),
        };
      }),
    },
  };
}

export function createTransportTiming(options: {
  socketPath: string;
  token: string;
  authorize(
    scope: Readonly<Scope>,
    capability: Capability,
  ): boolean | Promise<boolean>;
}): TransportTiming {
  if (
    !isAbsolute(options.socketPath) ||
    options.token.length < 32 ||
    /[\r\n]/.test(options.token)
  )
    throw new Error("Invalid COMPUTAH_SLACK_TIMING configuration");
  return (inputScope, requestId, signal, parent) =>
    traceOperation(
      "slack.timing",
      async (span) => {
        const fail = (code: string): TransportTimingResult => {
          span.setAttribute(
            "outcome",
            code === "denied"
              ? "denied"
              : code === "cancelled"
                ? "cancelled"
                : code === "timeout"
                  ? "timeout"
                  : "error",
          );
          span.setStatus({ code: 2 });
          return { status: "unavailable", code };
        };
        const scope = Object.freeze({ ...inputScope });
        const allowed = async () => {
          try {
            return Boolean(await options.authorize(scope, "operations.read"));
          } catch {
            return false;
          }
        };
        if (!(await allowed())) return fail("denied");
        if (!/^input:slack:[a-f0-9]{64}$/.test(requestId))
          return fail("not_slack_receipt");
        if (signal.aborted) return fail("cancelled");
        const body = JSON.stringify({ requestId, scope });
        if (Buffer.byteLength(body) > 2048) return fail("invalid_scope");
        const deadline = AbortSignal.timeout(2000);
        const abort = AbortSignal.any([signal, deadline]);
        const result = await new Promise<TransportTimingResult>((resolve) => {
          let settled = false;
          const finish = (result: TransportTimingResult) => {
            if (settled) return;
            settled = true;
            resolve(result);
          };
          const reject = (code: string) => {
            if (!settled) finish(fail(code));
          };
          const req = request(
            {
              socketPath: options.socketPath,
              path: "/v1/timing",
              method: "POST",
              agent: false,
              signal: abort,
              headers: {
                ...currentTraceHeaders(),
                authorization: `Bearer ${options.token}`,
                "content-type": "application/json",
                "content-length": Buffer.byteLength(body),
              },
            },
            (response) => {
              if (response.statusCode !== 200) {
                reject(
                  response.statusCode === 401 || response.statusCode === 403
                    ? "authorization_required"
                    : response.statusCode === 404
                      ? "receipt_unavailable"
                      : response.statusCode === 429
                        ? "rate_limited"
                        : "broker_unavailable",
                );
                response.destroy();
                return;
              }
              const chunks: Buffer[] = [];
              let bytes = 0;
              response.on("data", (chunk: Buffer) => {
                bytes += chunk.length;
                if (bytes > 262_144) {
                  reject("response_too_large");
                  response.destroy();
                } else chunks.push(chunk);
              });
              response.on("error", () =>
                reject(
                  signal.aborted
                    ? "cancelled"
                    : deadline.aborted
                      ? "timeout"
                      : "transport",
                ),
              );
              response.on("end", () => {
                try {
                  const text = Buffer.concat(chunks).toString("utf8");
                  if (text.includes(options.token))
                    throw new Error("Credential in response");
                  finish(project(JSON.parse(text)));
                } catch {
                  reject("invalid_response");
                }
              });
            },
          );
          req.on("error", () =>
            reject(
              signal.aborted
                ? "cancelled"
                : deadline.aborted
                  ? "timeout"
                  : "transport",
            ),
          );
          req.end(body);
        });
        if (!(await allowed())) return fail("denied");
        if (signal.aborted) return fail("cancelled");
        if (result.status === "ready") span.setAttribute("outcome", "ready");
        return result;
      },
      parent,
    );
}

/** Same protected file/socket configuration as the broker; never mount the Slack DB. */
export function readTransportTimingConfig(env: NodeJS.ProcessEnv) {
  const socketPath = env.COMPUTAH_SLACK_TIMING_SOCKET,
    file = env.COMPUTAH_SLACK_TIMING_TOKEN_FILE;
  if (!socketPath && !file) return undefined;
  if (
    !socketPath ||
    !file ||
    !isAbsolute(socketPath) ||
    !isAbsolute(file) ||
    !statSync(file).isFile() ||
    (statSync(file).mode & 0o077) !== 0
  )
    throw new Error("Invalid COMPUTAH_SLACK_TIMING configuration");
  const token = readFileSync(file, "utf8").trim();
  if (token.length < 32 || /[\r\n]/.test(token))
    throw new Error("Invalid COMPUTAH_SLACK_TIMING credential");
  return { socketPath, token };
}
