import { createHmac, randomBytes } from "node:crypto";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { setupTest } from "rivetkit/test";
import { expect, test } from "vitest";
import { createCore, type SourceGrant } from "../src/core.js";
import { createSentinel } from "../src/sentinel.js";
import { sourceModels } from "../src/source-models.js";

const alice = {
  tenantId: "source-preload-tests",
  userId: "alice",
  agentId: "default",
};
const bob = { ...alice, userId: "bob" };
const grant: SourceGrant = {
  handle: "opaque-account",
  version: "generation-one",
};

test("installed Codex transport rechecks source authority on retry for generation and Sentinel", async () => {
  const credentials = new InMemoryCredentialStore();
  const access = `synthetic.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" } })).toString("base64url")}.signature`;
  await credentials.modify("openai-codex", async () => ({
    type: "oauth",
    access,
    refresh: "synthetic-refresh",
    expires: Date.now() + 3_600_000,
  }));
  const native = await ModelRuntime.create({ credentials, modelsPath: null });
  const model = native.getModel("openai-codex", "gpt-6.1-terra");
  if (!model) throw new Error("Pinned model unavailable");
  const original = globalThis.fetch;
  try {
    for (const revoke of [false, true]) {
      let allowed = true;
      let posts = 0;
      const current = async () => {
        if (!allowed) throw new Error("revoked");
      };
      const fetch: typeof globalThis.fetch = async (_url, input) => {
        expect(input?.method).toBe("POST");
        posts++;
        if (revoke) allowed = false;
        return new Response("synthetic retryable failure", {
          status: 503,
          headers: { "retry-after": "0" },
        });
      };
      const boundary = sourceModels(native);
      const signal = new AbortController().signal;
      boundary.register(signal, current);
      const result = await boundary.models.completeSimple(
        model,
        {
          messages: [
            {
              role: "user",
              content: "private synthetic evidence",
              timestamp: 0,
            },
          ],
        },
        { signal, fetch, maxRetries: 1 },
      );
      expect(result.stopReason).not.toBe("stop");
      expect(posts).toBe(revoke ? 1 : 2);
    }
    let allowed = true;
    let posts = 0;
    globalThis.fetch = async () => {
      posts++;
      allowed = false;
      return new Response("synthetic retryable failure", {
        status: 503,
        headers: { "retry-after": "0" },
      });
    };
    const reviewer = createSentinel({
      models: native,
      model: "openai-codex/gpt-6.1-terra",
    });
    const decision = await reviewer.review(
      {
        reviewId: "synthetic-review",
        stage: "tool-intent",
        policy: "risky-effect",
        principal: "owner",
        evidence: [
          {
            id: "task",
            source: "assistant",
            text: "private synthetic evidence",
          },
        ],
      },
      async () => {
        if (!allowed) throw new Error("revoked");
      },
    );
    expect(posts).toBe(1);
    expect(decision.reason).toBe("review-unavailable");
    const boundary = sourceModels(native);
    expect(
      (await boundary.models.streamDeferred(model, {} as never).result())
        .stopReason,
    ).toBe("error");
    await expect(
      boundary.models.fetchDeferred(model, {} as never),
    ).rejects.toThrow("Source access denied");
    expect(posts).toBe(1);
  } finally {
    globalThis.fetch = original;
  }
});

test("private preloads and source lineage follow native Task, deny revoked history and queued retries", async (context) => {
  let allowed = true;
  const calls: string[] = [];
  const faux = fauxProvider({
    provider: "sources-test",
    models: [{ id: "test" }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(
    Array.from({ length: 8 }, () => (input) => {
      const text = JSON.stringify(input.messages);
      calls.push(text);
      const tools = new Set(
        input.messages.flatMap((m) =>
          m.role === "system" ? (m.toolsAdded ?? []).map((t) => t.name) : [],
        ),
      );
      if (
        tools.has("Task") &&
        input.messages.at(-1)?.role !== "toolResult" &&
        !text.includes("Worker replied")
      )
        return fauxAssistantMessage(
          fauxToolCall("Task", {
            worker: "mail",
            text: "Inspect invoice evidence",
          }),
          { stopReason: "toolUse" },
        );
      return fauxAssistantMessage(
        tools.has("Task")
          ? "UNSENT LOCAL DRAFT: ready for review"
          : "Worker replied: invoice checked",
      );
    }),
  );
  const core = createCore({
    connectionSecret: randomBytes(32).toString("hex"),
    authorize: () => true,
    model: "sources-test/test",
    models,
    sources: {
      available: (scope) => scope.userId === alice.userId,
      check: async (scope, ref) => {
        if (
          !allowed ||
          scope.userId !== alice.userId ||
          ref.handle !== grant.handle ||
          ref.version !== grant.version
        )
          throw new Error("denied");
      },
      preload: async (scope) =>
        scope.userId === alice.userId
          ? {
              grants: [grant],
              text: "PRIVATE-INVOICE-EVIDENCE: account source original",
            }
          : null,
    },
    settings: { retry: { enabled: false } },
  });
  try {
    const { client } = await setupTest(context, core.registry);
    const bind = core.attach(client);
    const session = bind(alice);
    const privateMail = JSON.stringify({
      accountHandle: grant.handle,
      messageId: "a1b2",
      mail: "PRIVATE-LIVE-MAIL",
    });
    const admitted = await session.submitSource(
      "Prepare an invoice reply",
      "receipt-one",
      grant,
      privateMail,
    );
    const result = await session.result(
      session.interactionId,
      admitted.submissionId,
      true,
    );
    expect(result.submission.status).toBe("done");
    expect(
      calls.some((text) => text.includes("PRIVATE-INVOICE-EVIDENCE")),
    ).toBe(true);
    expect(calls.some((text) => text.includes("PRIVATE-LIVE-MAIL"))).toBe(true);
    expect(calls.some((text) => text.includes("gmail_read"))).toBe(true);
    expect(
      JSON.stringify((await session.history(session.interactionId)).items),
    ).not.toContain("PRIVATE-INVOICE-EVIDENCE");
    expect(
      JSON.stringify((await session.history(session.interactionId)).items),
    ).not.toContain("PRIVATE-LIVE-MAIL");
    expect(
      JSON.stringify((await session.history(session.interactionId)).items),
    ).not.toContain(grant.handle);
    expect(
      JSON.stringify((await session.history(session.workerId("mail"))).items),
    ).toContain("Worker replied");
    expect(
      await session.submitSource(
        "Prepare an invoice reply",
        "receipt-one",
        grant,
        privateMail,
      ),
    ).toEqual(admitted);
    await expect(
      bind(bob).submitSource("forged", "other", grant),
    ).rejects.toThrow();
    await session.sleep(session.workerId("mail"));
    allowed = false;
    await expect(session.history(session.workerId("mail"))).rejects.toThrow();
    await expect(
      session.result(session.interactionId, admitted.submissionId),
    ).rejects.toThrow();
    await expect(
      session.submitSource("another", "receipt-two", grant),
    ).rejects.toThrow();
  } finally {
    await core.close();
  }
});

test("Worker-only source retrieval taints the parent Interaction before derived output release", async (context) => {
  const alice = {
    tenantId: "source-upward-tests",
    userId: "alice",
    agentId: "default",
  };
  let allowed = true;
  const faux = fauxProvider({
    provider: "sources-upward",
    models: [{ id: "test" }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("Task", { worker: "mail", text: "invoice-specific-query" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Derived private invoice answer"),
    fauxAssistantMessage("Final derived answer"),
  ]);
  const core = createCore({
    connectionSecret: randomBytes(32).toString("hex"),
    authorize: () => true,
    model: "sources-upward/test",
    models,
    sources: {
      available: () => true,
      check: async () => {
        if (!allowed) throw new Error("denied");
      },
      preload: async (_scope, query) =>
        query === "invoice-specific-query"
          ? { grants: [grant], text: "Worker-only private source" }
          : null,
    },
  });
  try {
    const { client } = await setupTest(context, core.registry);
    const session = core.attach(client)(alice);
    const admitted = await session.submit(
      session.interactionId,
      "Find the right context",
      "normal-source-less-input",
    );
    expect(
      (await session.result(session.interactionId, admitted.submissionId, true))
        .submission.status,
    ).toBe("done");
    allowed = false;
    await expect(session.history(session.interactionId)).rejects.toThrow();
    await expect(
      session.operatorHistory(session.interactionId),
    ).rejects.toThrow();
    await expect(
      session.result(session.interactionId, admitted.submissionId),
    ).rejects.toThrow();
    await expect(
      session.submit(session.interactionId, "Follow up", "follow-up"),
    ).rejects.toThrow();
  } finally {
    await core.close();
  }
});

test("revocation after durable queue admission prevents the next model request even when hook errors are swallowed", async (context) => {
  const alice = {
    tenantId: "source-queue-tests",
    userId: "alice",
    agentId: "default",
  };
  let allowed = true;
  let started!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const faux = fauxProvider({
    provider: "sources-queue",
    models: [{ id: "test" }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    async () => {
      started();
      await released;
      return fauxAssistantMessage("first result");
    },
    fauxAssistantMessage("MUST NOT RUN"),
  ]);
  const connectionSecret = randomBytes(32).toString("hex");
  const core = createCore({
    connectionSecret,
    authorize: () => true,
    model: "sources-queue/test",
    models,
    settings: { retry: { enabled: false } },
    sources: {
      available: () => true,
      preload: async () => null,
      check: async () => {
        if (!allowed) throw new Error("denied");
      },
    },
  });
  try {
    const { client } = await setupTest(context, core.registry);
    const session = core.attach(client)(alice);
    await session.submitSource("first source", "first", grant);
    await firstStarted;
    const queued = await session.submitSource("queued source", "queued", grant);
    allowed = false;
    release();
    await expect(
      session.result(session.interactionId, queued.submissionId, true),
    ).rejects.toThrow();
    // Wait for the actor to finish trying the queued submission, independently
    // of the gateway denial above. No additional provider request is permitted.
    const key = [alice.tenantId, alice.userId, alice.agentId];
    const token = createHmac("sha256", connectionSecret)
      .update(JSON.stringify(["interaction", ...key]))
      .digest("hex");
    await client.interaction
      .getOrCreate(key, { params: { token } })
      .harness.waitForIdle();
    expect(faux.state.callCount).toBe(1);
  } finally {
    release();
    await core.close();
  }
});
