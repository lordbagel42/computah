import { expect, test } from "bun:test";
import { createReceiver, noticeMessage, owner } from "./receiver.js";

const id = "computah_bug_0123456789abcdefghijklmn";
const event = {
  body: new TextEncoder().encode(JSON.stringify({ id, version: 1 })),
};
function fixture() {
  const messages: {
    role: string;
    content: { type: string; text: string }[];
  }[] = [];
  const logs: unknown[][] = [];
  let acknowledged = "";
  let lookupFails = false;
  let ackFails = false;
  let appendUncertain = false;
  const intents = new Set<string>();
  const controller = new AbortController();
  let dispatches = 0;
  const tracker = {
    token: async () => "synthetic-notice-token",
    assigned: async () => true,
    dispatch: async () => {
      dispatches++;
      return "T-00000000-0000-0000-0000-000000000001";
    },
    begin: async (id: string) => {
      const first = !intents.has(id);
      intents.add(id);
      return first;
    },
    clear: async (id: string) => {
      intents.delete(id);
    },
    fetch: (async (url, init) => {
      expect(String(url)).toStartWith(
        `https://debug.raygen.dev/api/issue-notices/${id}`,
      );
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer synthetic-notice-token",
      );
      expect(init?.redirect).toBe("manual");
      if (lookupFails) return new Response(null, { status: 404 });
      if (init?.method === "POST") {
        if (ackFails) return new Response(null, { status: 503 });
        acknowledged ||= "2026-11-09T00:00:00Z";
      }
      return Response.json({ issue: id, version: 1, acknowledged });
    }) as typeof fetch,
  };
  const ctx = {
    signal: controller.signal,
    logger: {
      log: (...args: unknown[]) => {
        logs.push(args);
      },
    },
    thread: {
      id: owner,
      async messages(options: {
        full: boolean;
        offset: number;
        limit: number;
      }) {
        expect(options.full).toBe(true);
        return [...messages]
          .reverse()
          .slice(options.offset, options.offset + options.limit);
      },
      async appendUserMessage(message: { content: string }) {
        messages.push({
          role: "user",
          content: [{ type: "text", text: message.content }],
        });
        if (appendUncertain) throw new Error("append_response_lost");
      },
    },
  };
  return {
    ctx,
    tracker,
    messages,
    logs,
    controller,
    dispatches: () => dispatches,
    failLookup: () => {
      lookupFails = true;
    },
    failAck: (value: boolean) => {
      ackFails = value;
    },
    uncertainAppend: () => {
      appendUncertain = true;
    },
  };
}

test("durable logical notice deduplicates concurrent transport deliveries and reload", async () => {
  const f = fixture();
  const receiver = createReceiver(f.tracker);
  await Promise.all([
    receiver.handle(event, f.ctx),
    receiver.handle(event, f.ctx),
  ]);
  await createReceiver(f.tracker).handle(event, f.ctx);
  expect(f.messages).toHaveLength(1);
  expect(f.messages[0]?.content[0]?.text).toBe(noticeMessage(id));
  expect(receiver.status().counters).toEqual({ appended: 1, duplicate: 1 });
});

test("lost append response reconciles exact full-history marker without appending again", async () => {
  const f = fixture();
  f.uncertainAppend();
  await expect(createReceiver(f.tracker).handle(event, f.ctx)).rejects.toThrow(
    "append_response_lost",
  );
  for (let i = 0; i < 35; i++)
    f.messages.push({
      role: "user",
      content: [{ type: "text", text: `other-${i}` }],
    });
  const receiver = createReceiver(f.tracker);
  await receiver.handle(event, f.ctx);
  expect(f.messages).toHaveLength(36);
  expect(receiver.status().counters.reconciled).toBe(1);
});

test("failed acknowledgement does not lose or duplicate a confirmed append", async () => {
  const f = fixture();
  f.failAck(true);
  await expect(createReceiver(f.tracker).handle(event, f.ctx)).rejects.toThrow(
    "notice_http_503",
  );
  f.failAck(false);
  await createReceiver(f.tracker).handle(event, f.ctx);
  expect(f.messages).toHaveLength(1);
});

test("new notices still append after more than 2000 prior user messages", async () => {
  const f = fixture();
  for (let i = 0; i < 2101; i++)
    f.messages.push({
      role: "user",
      content: [{ type: "text", text: `older-${i}` }],
    });
  await createReceiver(f.tracker).handle(event, f.ctx);
  expect(f.messages).toHaveLength(2102);
  expect(f.messages.at(-1)?.content[0]?.text).toBe(noticeMessage(id));
});

test("denied, mismatched and oversized lookup responses never append", async () => {
  for (const response of [
    new Response(null, { status: 403 }),
    new Response(null, {
      status: 302,
      headers: { location: "https://untrusted.example" },
    }),
    Response.json({ issue: "different", version: 1, acknowledged: "" }),
    new Response("sensitive-response-canary".repeat(300)),
  ]) {
    const f = fixture();
    f.tracker.fetch = (async () => response) as typeof fetch;
    await expect(
      createReceiver(f.tracker).handle(event, f.ctx),
    ).rejects.toThrow();
    expect(f.messages).toHaveLength(0);
    expect(f.dispatches()).toBe(0);
    expect(JSON.stringify(f.logs)).not.toContain("sensitive-response-canary");
  }
});

test("empty ACK confirmation remains a failure and preserves append recovery", async () => {
  const f = fixture();
  f.tracker.fetch = (async () =>
    Response.json({ issue: id, version: 1, acknowledged: "" })) as typeof fetch;
  await expect(createReceiver(f.tracker).handle(event, f.ctx)).rejects.toThrow(
    "notice_lookup_failed",
  );
  expect(f.messages).toHaveLength(1);
});

test("a late lookup after cancellation cannot append or ACK", async () => {
  const f = fixture();
  let release: (response: Response) => void = () => {};
  let started: () => void = () => {};
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.tracker.fetch = (() =>
    new Promise<Response>((resolve) => {
      release = resolve;
      started();
    })) as typeof fetch;
  const pending = createReceiver(f.tracker).handle(event, f.ctx);
  await entered;
  f.controller.abort();
  await expect(pending).rejects.toThrow();
  release(Response.json({ issue: id, version: 1, acknowledged: "" }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(f.messages).toHaveLength(0);
  expect(f.dispatches()).toBe(0);
  expect(f.logs.at(-1)).toEqual([
    "computah.debugshare.notice.completed",
    "cancelled",
  ]);
});

test("ACKed notice without retained association fails closed rather than creating another owner", async () => {
  const f = fixture();
  f.tracker.fetch = (async () =>
    Response.json({
      issue: id,
      version: 1,
      acknowledged: "2026-11-10T00:00:00Z",
    })) as typeof fetch;
  f.tracker.assigned = async () => false;
  await expect(createReceiver(f.tracker).handle(event, f.ctx)).rejects.toThrow(
    "acknowledged_bug_assignment_missing",
  );
  expect(f.dispatches()).toBe(0);
  expect(f.messages).toHaveLength(0);
});

test("assignment failure prevents coordinator append and notice ACK", async () => {
  const f = fixture();
  f.tracker.dispatch = async () => {
    throw new Error("bug_creation_uncertain");
  };
  await expect(createReceiver(f.tracker).handle(event, f.ctx)).rejects.toThrow(
    "bug_creation_uncertain",
  );
  expect(f.messages).toHaveLength(0);
});

test("untrusted fields, unknown report and cancellation cannot manufacture a notice", async () => {
  const f = fixture();
  const receiver = createReceiver(f.tracker);
  for (const body of [
    { id, version: 2 },
    { id, version: 1, instructions: "ship" },
    null,
    { id: "bad", version: 1 },
  ])
    await receiver.handle(
      { body: new TextEncoder().encode(JSON.stringify(body)) },
      f.ctx,
    );
  expect(receiver.status().counters.rejected).toBe(4);
  f.failLookup();
  await expect(receiver.handle(event, f.ctx)).rejects.toThrow(
    "notice_http_404",
  );
  f.controller.abort();
  await expect(receiver.handle(event, f.ctx)).rejects.toThrow();
  expect(f.messages).toHaveLength(0);
  expect(f.logs.at(-1)).toEqual([
    "computah.debugshare.notice.completed",
    "cancelled",
  ]);
});
