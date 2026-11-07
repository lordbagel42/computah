import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type {
  CancelResult,
  Message,
  Outcome,
  Submission,
  Viewer,
  WireError,
} from "@computah/contracts";
import type {
  Cursor,
  EntryRecord,
  SubmissionId,
  SubmissionRecord,
} from "@earendil-works/pi-durable";
import { type Principal, principalKey, tokenHash } from "./config.js";
import { CoreError, type CoreSession, type Scope } from "./core.js";

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: WireError["code"],
  ) {
    super(code);
  }
}

/** Only original user text and final assistant text cross the public boundary. */
export function projectMessages(
  entries: readonly EntryRecord[],
  submissionId: string | null = null,
): Message[] {
  return entries.flatMap((entry) =>
    (entry.model ?? []).flatMap((message) => {
      if (
        (entry.kind !== "pi.user" || message.role !== "user") &&
        (entry.kind !== "pi.assistant" ||
          message.role !== "assistant" ||
          (message.stopReason !== "stop" && message.stopReason !== "length"))
      )
        return [];
      const text =
        typeof message.content === "string"
          ? message.content
          : message.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("");
      return [
        {
          id: `message-${entry.id}`,
          submissionId,
          role: message.role as "user" | "assistant",
          createdAt: new Date(message.timestamp).toISOString(),
          revision: 1,
          blocks: [{ id: `text-${entry.id}`, kind: "text" as const, text }],
        },
      ];
    }),
  );
}

function outcome(record: SubmissionRecord): Outcome {
  if (record.status === "done") return "completed";
  if (record.status === "unanswered")
    return record.reason === "aborted" || record.reason === "withdrawn"
      ? "cancelled"
      : "failed";
  return record.status === "placed" ? "streaming" : "accepted";
}

async function body(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  if (!request.headers["content-type"]?.startsWith("application/json"))
    throw new HttpError(415, "invalid-request");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 110_000) throw new HttpError(413, "invalid-request");
    chunks.push(Buffer.from(chunk));
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid-request");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HttpError(400, "invalid-request");
  return value as Record<string, unknown>;
}

export function createHttpServer(options: {
  mode: "real" | "faux";
  secret: string;
  principals: Map<string, Principal>;
  bind(scope: Scope): CoreSession;
}) {
  const sign = (principal: Principal, purpose: string, data: string) =>
    createHmac("sha256", options.secret)
      .update(JSON.stringify([principalKey(principal), purpose, data]))
      .digest("base64url");
  const seal = (principal: Principal, purpose: string, value: unknown) => {
    const data = Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${data}.${sign(principal, purpose, data)}`;
  };
  const open = (
    principal: Principal,
    purpose: string,
    token: string,
  ): unknown => {
    if (token.length > 4096) throw new HttpError(400, "invalid-request");
    const [data, signature, extra] = token.split(".");
    if (!data || !signature || extra !== undefined)
      throw new HttpError(403, "forbidden");
    const expected = Buffer.from(sign(principal, purpose, data));
    const actual = Buffer.from(signature);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      throw new HttpError(403, "forbidden");
    try {
      return JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
    } catch {
      throw new HttpError(400, "invalid-request");
    }
  };
  return createServer(async (request, response) => {
    const reply = (status: number, value: unknown) => {
      if (response.destroyed) return;
      response.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      response.end(JSON.stringify(value));
    };
    try {
      const url = new URL(request.url ?? "/", "http://computah.internal");
      if (request.method === "GET" && url.pathname === "/healthz") {
        reply(200, { ready: true, mode: options.mode });
        return;
      }
      const bearer = /^Bearer (\S+)$/i.exec(
        request.headers.authorization ?? "",
      )?.[1];
      const principal = bearer
        ? options.principals.get(tokenHash(bearer))
        : undefined;
      if (!principal) throw new HttpError(401, "unauthenticated");
      const session = options.bind({
        tenantId: principal.tenantId,
        userId: principal.userId,
        agentId: principal.agentId,
      });
      const permit = (capability: Principal["capabilities"][number]) => {
        if (!principal.capabilities.includes(capability))
          throw new HttpError(403, "forbidden");
      };
      const signedSubmission = (id: SubmissionId) =>
        seal(principal, "submission", id);
      const submission = (record: SubmissionRecord): Submission => ({
        id: signedSubmission(record.id),
        clientMutationId: record.requestId?.replace(/^input:/, "") ?? "unknown",
        outcome: outcome(record),
      });
      if (request.method === "GET" && url.pathname === "/v1/viewer") {
        const viewer: Viewer = {
          tenantId: principal.tenantId,
          userId: principal.userId,
          agentId: principal.agentId,
          displayName: principal.displayName,
          capabilities: [...principal.capabilities],
        };
        reply(200, { version: 1, conversationId: "primary", viewer });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/submissions") {
        permit("task.send");
        const input = await body(request);
        if (
          Object.keys(input).some(
            (key) => key !== "text" && key !== "clientMutationId",
          ) ||
          typeof input.text !== "string" ||
          !input.text.trim() ||
          input.text.length > 100_000 ||
          typeof input.clientMutationId !== "string" ||
          !input.clientMutationId ||
          input.clientMutationId.length > 200
        )
          throw new HttpError(400, "invalid-request");
        const admitted = await session.submit(
          session.interactionId,
          input.text,
          input.clientMutationId,
        );
        reply(202, {
          version: 1,
          id: signedSubmission(admitted.submissionId),
          clientMutationId: input.clientMutationId,
          outcome: "accepted",
        } satisfies Submission & { version: 1 });
        return;
      }
      const match = /^\/v1\/submissions\/([^/]+)(\/cancel)?$/.exec(
        url.pathname,
      );
      if (match) {
        const value = open(principal, "submission", match[1]);
        if (
          typeof value !== "number" ||
          !Number.isSafeInteger(value) ||
          value <= 0
        )
          throw new HttpError(400, "invalid-request");
        const id = value as SubmissionId;
        if (request.method === "POST" && match[2]) {
          permit("task.control");
          const result = await session.cancel(session.interactionId, id);
          const cancelled: CancelResult = {
            submissionId: signedSubmission(id),
            status:
              result === "aborted"
                ? "cancelled"
                : result === "settled"
                  ? "too-late"
                  : "unknown",
          };
          reply(200, cancelled);
          return;
        }
        if (request.method === "GET" && !match[2]) {
          permit("history.read");
          const controller = new AbortController();
          const disconnected = () => controller.abort();
          response.once("close", disconnected);
          const timer = setTimeout(() => controller.abort(), 25_000);
          let result: Awaited<ReturnType<CoreSession["result"]>>;
          try {
            result = await session.result(
              session.interactionId,
              id,
              url.searchParams.get("wait") === "true",
              controller.signal,
            );
          } catch (error) {
            if (!controller.signal.aborted || response.destroyed) throw error;
            result = await session.result(session.interactionId, id);
          } finally {
            clearTimeout(timer);
            response.removeListener("close", disconnected);
          }
          const mapped = submission(result.submission);
          reply(
            mapped.outcome === "accepted" || mapped.outcome === "streaming"
              ? 202
              : 200,
            {
              version: 1,
              submission: mapped,
              messages: projectMessages(result.entries, mapped.id),
            },
          );
          return;
        }
      }
      if (request.method === "GET" && url.pathname === "/v1/history") {
        permit("history.read");
        const token = url.searchParams.get("cursor");
        const cursor = token ? open(principal, "history", token) : undefined;
        if (
          cursor !== undefined &&
          (!cursor || typeof cursor !== "object" || Array.isArray(cursor))
        )
          throw new HttpError(400, "invalid-request");
        const page = await session.history(
          session.interactionId,
          cursor as Cursor | undefined,
        );
        reply(200, {
          version: 1,
          conversationId: "primary",
          messages: projectMessages(page.items),
          nextCursor: page.next ? seal(principal, "history", page.next) : null,
        });
        return;
      }
      throw new HttpError(404, "not-found");
    } catch (error) {
      const status =
        error instanceof HttpError
          ? error.status
          : error instanceof CoreError
            ? (
                {
                  denied: 403,
                  invalid: 400,
                  conflict: 409,
                  runtime: 503,
                } as const
              )[error.code]
            : 503;
      const code =
        error instanceof HttpError
          ? error.code
          : error instanceof CoreError
            ? (
                {
                  denied: "forbidden",
                  invalid: "invalid-request",
                  conflict: "conflict",
                  runtime: "unavailable",
                } as const
              )[error.code]
            : "unavailable";
      const safe: WireError = {
        code,
        message: code,
        correlationId: randomUUID(),
        retryable: status === 503,
      };
      reply(status, safe);
    }
  });
}

export async function closeHttp(
  server: ReturnType<typeof createServer>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    // Leave time for native actor draining even if a client never finishes a body.
    const deadline = setTimeout(() => server.closeAllConnections(), 5_000);
    server.close((error) => {
      clearTimeout(deadline);
      if (error) reject(error);
      else resolve();
    });
    server.closeIdleConnections();
  });
}
