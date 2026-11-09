import { createHmac, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type SlackEnrollment,
  slackCapabilities,
  slackIdentity,
  slackScopeAllowed,
} from "@computah/contracts/slack-identity";
import { startObservability, traceOperation } from "@computah/observability";
import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/chord/context";
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import type { PiProviderConfig } from "@rivet-dev/pi";
import { setupTest } from "rivetkit/test";
import { expect, test } from "vitest";
import {
  type Binding,
  type Ingress,
  SlackAdapter,
  type Transport,
} from "../../slack/src/adapter.js";
import { createCommunity } from "../src/community.js";
import { principalKey, readConfig } from "../src/config.js";
import { createCore, type Scope } from "../src/core.js";
import { closeHttp, createHttpServer } from "../src/http.js";

const owner = { tenantId: "tenant", userId: "owner", agentId: "default" };
const policy: SlackEnrollment = {
  teamId: "TTEST",
  ownerSlackUserId: "UOWNER",
  ownerScope: owner,
  deniedUserIds: [],
  secret: "synthetic-issuer-secret-not-a-real-key",
};

test("enrollment namespace stays reserved while disabled and owner scope must already exist", () => {
  const env = {
    COMPUTAH_MODE: "faux",
    COMPUTAH_CONNECTION_SECRET: "synthetic-connection-key-long-enough",
    COMPUTAH_AUTH_JSON: JSON.stringify([
      {
        ...owner,
        token: "synthetic-owner-bearer-long-enough",
        capabilities: ["task.send", "history.read"],
      },
    ]),
  };
  expect(readConfig(env).slackEnrollment).toBeUndefined();
  expect(() =>
    readConfig({
      ...env,
      COMPUTAH_AUTH_JSON: env.COMPUTAH_AUTH_JSON.replace(
        '"tenant"',
        '"slack:TTEST"',
      ),
    }),
  ).toThrow("reserved");
  expect(() =>
    readConfig({
      ...env,
      COMPUTAH_SLACK_ENROLLMENT_SECRET: policy.secret,
      COMPUTAH_SLACK_ENROLLMENT_JSON: JSON.stringify({
        ...policy,
        ownerScope: { ...owner, userId: "missing" },
      }),
    }),
  ).toThrow("existing owner scope");
});

test("real durable actors, private templates, explicit facts/proposals and HTTP credentials enforce two-user audience isolation", async (context) => {
  const originalFetch = globalThis.fetch;
  const exports: string[] = [];
  globalThis.fetch = async (input, init) => {
    if (
      [
        "https://api.axiom.co/v1/traces",
        "https://api.axiom.co/v1/logs",
      ].includes(String(input))
    ) {
      exports.push(String(init?.body));
      return new Response("{}");
    }
    return originalFetch(input, init);
  };
  process.env.COMPUTAH_AXIOM_INGEST_TOKEN = "synthetic-only";
  process.env.COMPUTAH_AXIOM_LOG_DATASET = "synthetic-logs";
  const telemetry = await startObservability("backend");
  const current = structuredClone(policy);
  const authorize = (scope: Readonly<Scope>, capability: string) =>
    principalKey(scope) === principalKey(owner)
      ? [
          "task.send",
          "history.read",
          "core.maintain",
          "files.write",
          "operator.read",
        ].includes(capability)
      : Boolean(slackScopeAllowed(current, scope)) &&
        slackCapabilities.some((grant) => grant === capability);
  const models = [
    {
      id: "test",
      name: "test",
      reasoning: false,
      input: ["text" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000,
      maxTokens: 4096,
    },
  ];
  const faux = createFauxCore({
    provider: "multiuser",
    api: "multiuser",
    models,
    tokensPerSecond: 0,
  });
  const seen: { command: string; prompt: string; tools: string[] }[] = [];
  const provider: PiProviderConfig = {
    api: "multiuser",
    baseUrl: "http://unused.invalid",
    models,
    streamSimple(model, request, options) {
      const user = request.messages.findLast((entry) => entry.role === "user");
      const command =
        typeof user?.content === "string"
          ? user.content
          : JSON.stringify(user?.content);
      const tools = new Set<string>();
      for (const msg of request.messages)
        if (msg.role === "system") {
          for (const tool of msg.toolsAdded ?? []) tools.add(tool.name);
          for (const tool of msg.toolsRemoved ?? []) tools.delete(tool.name);
        }
      seen.push({
        command,
        prompt: JSON.stringify(request.messages),
        tools: [...tools],
      });
      const last = request.messages.at(-1);
      const response =
        last?.role === "toolResult"
          ? fauxAssistantMessage(
              JSON.stringify({ error: last.isError, content: last.content }),
            )
          : command.startsWith("plugin:")
            ? fauxAssistantMessage(
                fauxToolCall("private_plugin", JSON.parse(command.slice(7))),
                { stopReason: "toolUse" },
              )
            : command.startsWith("file:") && tools.has("Task")
              ? fauxAssistantMessage(
                  fauxToolCall("Task", { worker: "primary", text: command }),
                  { stopReason: "toolUse" },
                )
              : command.startsWith("file:")
                ? fauxAssistantMessage(
                    fauxToolCall(command === "file:write" ? "write" : "read", {
                      path: "/private-note.txt",
                      ...(command === "file:write"
                        ? { content: "WORKER_PRIVATE_CANARY" }
                        : {}),
                    }),
                    { stopReason: "toolUse" },
                  )
                : fauxAssistantMessage(`answer:${command}`);
      faux.setResponses([response]);
      return faux.streamSimple(model, request, options);
    },
  };
  const connectionSecret = randomBytes(32).toString("hex");
  const core = createCore({
    connectionSecret,
    authorize,
    slackEnrollment: current,
    model: "multiuser/test",
    providers: { multiuser: provider },
    apiKeys: { multiuser: "synthetic" },
  });
  let http: ReturnType<typeof createHttpServer> | undefined;
  const directory = mkdtempSync(join(tmpdir(), "computah-multiuser-slack-"));
  let adapter: SlackAdapter | undefined;
  try {
    const { client } = await setupTest(context, core.registry);
    const bind = core.attach(client);
    const aliceScope = slackIdentity(current, "TTEST", "UALICE", "dm")!;
    const alice = bind(aliceScope);
    const bob = bind(slackIdentity(current, "TTEST", "UBOB", "dm")!);
    const aliceChannel = bind(
      slackIdentity(current, "TTEST", "UALICE", "CONE")!,
    );
    const bobChannel = bind(slackIdentity(current, "TTEST", "UBOB", "CONE")!);
    const otherChannel = bind(
      slackIdentity(current, "TTEST", "UALICE", "CTWO")!,
    );
    const ownerChannel = bind(
      slackIdentity(current, "TTEST", "UOWNER", "CONE")!,
    );
    const ownerSession = bind(owner);
    let sequence = 0;
    async function run(session: typeof alice, command: string) {
      const receipt = await session.submit(
        session.interactionId,
        command,
        `turn-${++sequence}`,
      );
      const result = await session.result(
        session.interactionId,
        receipt.submissionId,
        true,
      );
      expect(result.submission.status).toBe("done");
      return JSON.stringify(result.entries);
    }
    const plugin = (action: string, template = "", input = "") =>
      `plugin:${JSON.stringify({ action, name: "note", template, input })}`;
    await run(ownerSession, "OWNER_PRIVATE_CANARY");
    await run(alice, plugin("save", "ALICE_PRIVATE_CANARY {{input}}"));
    await expect(alice.sleep(alice.interactionId)).rejects.toThrow("denied");
    const aliceKey = [
      aliceScope.tenantId,
      aliceScope.userId,
      aliceScope.agentId,
    ];
    await client.interaction
      .getOrCreate(aliceKey, {
        params: {
          token: createHmac("sha256", connectionSecret)
            .update(JSON.stringify(["interaction", ...aliceKey]))
            .digest("hex"),
        },
      })
      .sleep();
    expect(await run(alice, plugin("render", "", "literal $&"))).toContain(
      "ALICE_PRIVATE_CANARY literal $&",
    );
    for (const session of [bob, aliceChannel, ownerChannel]) {
      const output = await run(session, plugin("render", "", "x"));
      expect(output).toContain("unavailable");
      expect(output).not.toContain("ALICE_PRIVATE_CANARY");
      expect(seen.at(-1)?.prompt).not.toContain("OWNER_PRIVATE_CANARY");
      expect(seen.at(-1)?.prompt).not.toContain("ALICE_PRIVATE_CANARY");
      expect(seen.at(-1)?.tools).not.toContain("owner_proposals");
    }
    await expect(bob.history(alice.interactionId)).rejects.toThrow("denied");
    await run(alice, "file:write");
    expect(await run(alice, "file:read")).toContain("WORKER_PRIVATE_CANARY");
    for (const session of [bob, aliceChannel, ownerChannel]) {
      expect(await run(session, "file:read")).not.toContain(
        "WORKER_PRIVATE_CANARY",
      );
      expect(seen.at(-1)?.prompt).not.toContain("WORKER_PRIVATE_CANARY");
    }
    const share = {
      action: "share",
      text: "PUBLIC_EXPLICIT_FACT",
      requestId: "fact1",
      message: "123.456",
    };
    const fact = await aliceChannel.community(share);
    expect(await aliceChannel.community(share)).toEqual(fact);
    expect(
      await bobChannel.community({
        action: "facts",
        text: "",
        requestId: "",
        message: "",
      }),
    ).toEqual(fact);
    expect(
      await otherChannel.community({
        action: "facts",
        text: "",
        requestId: "",
        message: "",
      }),
    ).toEqual([]);
    await expect(alice.community(share)).rejects.toThrow();
    await bobChannel.community({
      action: "retract",
      text: fact[0].id,
      requestId: "remove",
      message: "",
    });
    expect(
      await aliceChannel.community({
        action: "facts",
        text: "",
        requestId: "",
        message: "",
      }),
    ).toEqual(fact);
    await aliceChannel.community({
      action: "retract",
      text: fact[0].id,
      requestId: "remove",
      message: "",
    });
    expect(
      await bobChannel.community({
        action: "facts",
        text: "",
        requestId: "",
        message: "",
      }),
    ).toEqual([]);
    const proposed = await bob.community({
      action: "propose",
      text: "EXPLICIT_PROPOSAL_ONLY",
      requestId: "proposal1",
      message: "124.456",
    });
    await ownerSession.sleep(ownerSession.interactionId);
    expect(await aliceChannel.community(share)).toMatchObject([
      { retracted: true, text: "" },
    ]);
    expect(
      await bobChannel.community({
        action: "facts",
        text: "",
        requestId: "",
        message: "",
      }),
    ).toEqual([]);
    await expect(
      aliceChannel.community({ ...share, message: "124.456" }),
    ).rejects.toThrow("conflict");
    expect(
      await ownerSession.community({
        action: "proposals",
        text: "",
        requestId: "",
        message: "",
      }),
    ).toEqual(proposed);
    await expect(
      alice.community({
        action: "proposals",
        text: "",
        requestId: "",
        message: "",
      }),
    ).rejects.toThrow();
    expect(JSON.stringify(proposed)).not.toContain("OWNER_PRIVATE_CANARY");
    expect(seen.map((entry) => entry.command)).not.toContain(
      "EXPLICIT_PROPOSAL_ONLY",
    );
    for (let i = 0; i < 20; i++)
      await alice.community({
        action: "propose",
        text: "bounded proposal",
        requestId: `capacity-${i}`,
        message: "125.456",
      });
    await expect(
      alice.community({
        action: "propose",
        text: "one too many",
        requestId: "over-capacity",
        message: "125.456",
      }),
    ).rejects.toThrow("conflict");
    // Cancellation fences the caller's read; it does not claim rollback of owner mutations.
    const controller = new AbortController();
    const cancelledRead = createCommunity({
      policy: current,
      authorize: () => true,
      scope: async () => slackIdentity(current, "TTEST", "UALICE", "CONE")!,
      access: async (_scope, _request, _parent, signal) =>
        new Promise((_resolve, reject) => {
          signal!.addEventListener("abort", () => reject(signal!.reason), {
            once: true,
          });
          controller.abort();
        }),
    });
    await traceOperation("synthetic", async () => {
      await expect(
        cancelledRead.extension.tools![0].execute(
          {},
          {} as ToolExecutionApi,
          withAbortSignal(controller.signal, BACKGROUND_CONTEXT),
        ),
      ).rejects.toThrow();
    });
    http = createHttpServer({
      mode: "faux",
      secret: "synthetic-sealing-key-long-enough",
      principals: new Map(),
      slackEnrollment: current,
      bind,
    });
    http.listen(0, "127.0.0.1");
    await once(http, "listening");
    const address = http.address();
    if (!address || typeof address === "string")
      throw new Error("Missing address");
    const base = `http://127.0.0.1:${address.port}`;
    const get = (path: string, token = aliceScope.coreToken) =>
      originalFetch(base + path, {
        headers: { authorization: `Bearer ${token}`, connection: "close" },
      });
    expect((await get("/v1/viewer")).status).toBe(200);
    expect((await get("/v1/operator/snapshot")).status).toBe(403);
    const capacityReply = await originalFetch(base + "/v1/community", {
      method: "POST",
      headers: {
        authorization: `Bearer ${aliceScope.coreToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        action: "propose",
        text: "one too many",
        requestId: "over-capacity",
        message: "125.456",
      }),
    });
    expect(capacityReply.status).toBe(409);
    expect(await capacityReply.json()).toMatchObject({ retryable: false });
    expect(
      (await get("/v1/viewer", aliceScope.coreToken + "forged")).status,
    ).toBe(401);
    const posts: { channel: string; text: string; thread?: string | null }[] =
      [];
    const transport: Transport = {
      async status() {
        return "unsupported";
      },
      async request(binding, path, body) {
        const response = await originalFetch(base + path, {
          method: body ? "POST" : "GET",
          headers: {
            authorization: `Bearer ${binding.coreToken}`,
            "content-type": "application/json",
            connection: "close",
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        if (!response.ok) throw new Error("Synthetic core request failed");
        return response.json();
      },
      async openDm(user) {
        return `D${user}`;
      },
      async post(channel, text, thread) {
        posts.push({ channel, text, thread });
      },
    };
    const ownerBinding: Binding = {
      ...owner,
      teamId: "TTEST",
      slackUserId: "UOWNER",
      coreToken: "synthetic-owner-bearer-long-enough",
      channelIds: [],
    };
    const openAdapter = () =>
      new SlackAdapter(
        join(directory, "slack.sqlite"),
        [ownerBinding],
        "UBOT",
        transport,
        Date.now,
        false,
        0,
        true,
        [],
        current,
      );
    adapter = openAdapter();
    const event: Ingress = {
      team_id: "TTEST",
      event_id: "ECHANNEL",
      event: {
        type: "app_mention",
        user: "UALICE",
        channel: "CONE",
        text: "<@UBOT> CHANNEL_ONLY_REQUEST",
        ts: "100.001",
      },
    };
    expect(adapter.admit(event)).toBe("accepted");
    adapter.close();
    adapter = openAdapter();
    expect(adapter.admit(event)).toBe("duplicate");
    for (let i = 0; i < 100 && !posts.length; i++) {
      await adapter.step();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ channel: "CONE", thread: "100.001" });
    expect(posts[0].text).toContain("hi, i'm computah.");
    expect(posts[0].text).not.toContain("ALICE_PRIVATE_CANARY");
    expect(posts[0].text).not.toContain("OWNER_PRIVATE_CANARY");
    const channelTurn = seen.find((entry) =>
      entry.command.startsWith("CHANNEL_ONLY_REQUEST"),
    );
    expect(channelTurn?.prompt).not.toContain("ALICE_PRIVATE_CANARY");
    expect(channelTurn?.prompt).not.toContain("OWNER_PRIVATE_CANARY");
    expect(
      adapter.admit({
        team_id: "TTEST",
        event_id: "EPROPOSE",
        event: {
          type: "message",
          channel_type: "im",
          channel: "DBOB",
          user: "UBOB",
          ts: "101.001",
          text: "PROPOSE adapter explicit proposal",
        },
      }),
    ).toBe("accepted");
    await adapter.step();
    expect(posts.at(-1)?.text).toContain("no global changes were made");
    // A fresh HTTP server needs no enrollment map to resolve the same durable history.
    await closeHttp(http);
    http = createHttpServer({
      mode: "faux",
      secret: "synthetic-sealing-key-long-enough",
      principals: new Map(),
      slackEnrollment: current,
      bind,
    });
    http.listen(address.port, "127.0.0.1");
    await once(http, "listening");
    expect((await get("/v1/viewer")).status).toBe(200);
    current.deniedUserIds.push("UALICE");
    expect((await get("/v1/viewer")).status).toBe(401);
    await expect(alice.history(alice.interactionId)).rejects.toThrow("denied");
    await expect(
      aliceChannel.community({
        action: "facts",
        text: "",
        requestId: "",
        message: "",
      }),
    ).rejects.toThrow();
    await traceOperation("synthetic", async () => {
      await expect(
        bob.community({
          action: "share",
          text: "private",
          requestId: "bad",
          message: "1.1",
        }),
      ).rejects.toThrow();
    });
  } finally {
    adapter?.close();
    if (http) await closeHttp(http);
    await core.close();
    await telemetry.close();
    globalThis.fetch = originalFetch;
    rmSync(directory, { recursive: true, force: true });
  }
  const encoded = exports.join();
  expect(encoded).toContain("computah.community.access");
  expect(encoded).toContain("computah.community.plugin");
  expect(encoded).toContain("denied");
  type ExportSpan = {
    name: string;
    traceId: string;
    spanId: string;
    parentSpanId?: string;
    attributes: { key: string; value: { stringValue?: string } }[];
  };
  const spans: ExportSpan[] = exports.flatMap((body) => {
    const envelope = JSON.parse(body) as {
      resourceSpans?: { scopeSpans: { spans: ExportSpan[] }[] }[];
    };
    return (
      envelope.resourceSpans?.flatMap((resource) =>
        resource.scopeSpans.flatMap((scope) => scope.spans),
      ) ?? []
    );
  });
  const communitySpans = spans.filter((span) =>
    span.name.startsWith("computah.community."),
  );
  expect(
    communitySpans.flatMap((span) =>
      span.attributes
        .filter((attribute) => attribute.key === "outcome")
        .map((attribute) => attribute.value.stringValue),
    ),
  ).toEqual(expect.arrayContaining(["success", "denied", "cancelled"]));
  const cancelled = communitySpans.find(
    (span) =>
      span.name === "computah.community.read" &&
      span.attributes.some(
        (attribute) =>
          attribute.key === "outcome" &&
          attribute.value.stringValue === "cancelled",
      ),
  );
  expect(cancelled).toBeDefined();
  expect(
    spans.some(
      (parent) =>
        parent.spanId === cancelled?.parentSpanId &&
        parent.traceId === cancelled?.traceId,
    ),
  ).toBe(true);
  expect(
    communitySpans.some(
      (span) =>
        span.name === "computah.community.access" &&
        spans.some(
          (parent) =>
            parent.spanId === span.parentSpanId &&
            parent.traceId === span.traceId,
        ),
    ),
  ).toBe(true);
  for (const canary of [
    "OWNER_PRIVATE_CANARY",
    "ALICE_PRIVATE_CANARY",
    "WORKER_PRIVATE_CANARY",
    "PUBLIC_EXPLICIT_FACT",
    "EXPLICIT_PROPOSAL_ONLY",
    policy.secret,
  ])
    expect(encoded).not.toContain(canary);
});
