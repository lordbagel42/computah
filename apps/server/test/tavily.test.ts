import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  createRegistry,
  Harness,
  MemoryStorage,
} from "@earendil-works/pi-durable";
import { Effect } from "effect";
import { expect, test, vi } from "vitest";
import { createTavily, createTavilyExtension } from "../src/tavily.js";

const alice = { tenantId: "tenant", userId: "alice", agentId: "default" };
const bob = { ...alice, userId: "bob" };
const apiKey = "synthetic-key-not-a-credential";
const evidence = {
  results: [
    {
      title: "Example",
      url: "https://example.com/article",
      content: "Observed evidence",
    },
  ],
};
const allow = () => true;

test("search sends only the public query and returns bounded attributable evidence", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    expect(JSON.parse(String(init?.body))).toEqual({
      query: "public research",
      topic: "general",
      search_depth: "basic",
      auto_parameters: false,
      max_results: 5,
      chunks_per_source: 2,
      include_answer: false,
      include_raw_content: false,
      include_images: false,
    });
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      `Bearer ${apiKey}`,
    );
    return Response.json({
      ...evidence,
      query: "do not project",
      answer: apiKey,
      results: [
        ...evidence.results,
        { title: "bad", url: "http://127.0.0.1/private", content: "private" },
        {
          title: "duplicate",
          url: evidence.results[0].url,
          content: "duplicate",
        },
        {
          title: "Long",
          url: "https://example.org/",
          content: "x".repeat(1700),
        },
      ],
    });
  });
  const client = createTavily({ apiKey, authorize: allow, fetch });
  const result = await Effect.runPromise(
    client.run(alice, { query: " public research " }),
  );
  expect(result).toMatchObject({
    status: "ready",
    provider: "tavily",
    untrusted: true,
    failedUrls: [],
    sources: [
      {
        title: "Example",
        url: "https://example.com/article",
        content: "Observed evidence",
        truncated: false,
      },
      {
        title: "Long",
        url: "https://example.org/",
        content: "x".repeat(1500),
        truncated: true,
      },
    ],
  });
  expect(JSON.stringify(result)).not.toContain(apiKey);
  expect(fetch).toHaveBeenCalledTimes(1);
});

test("discovery and dispatch use current exact principal grants; revocation withholds output", async () => {
  let granted = true;
  const fetch = vi.fn<typeof globalThis.fetch>(async () => {
    granted = false;
    return Response.json(evidence);
  });
  const client = createTavily({
    apiKey,
    fetch,
    authorize: (scope, capability) =>
      granted && scope.userId === alice.userId && capability === "web.search",
  });
  expect(await client.capabilities(alice)).toEqual(["web.search"]);
  expect(await client.capabilities(bob)).toEqual([]);
  for (const scope of [bob, { ...alice, tenantId: "other" }]) {
    // All identity fields are the host callback's responsibility, as in core.
    const scoped = createTavily({
      apiKey,
      fetch,
      authorize: (s) => JSON.stringify(s) === JSON.stringify(alice),
    });
    expect(
      await Effect.runPromise(scoped.run(scope, { query: "public" })),
    ).toMatchObject({ code: "denied", requestState: "not_sent" });
  }
  expect(
    await Effect.runPromise(
      client.run(alice, { urls: ["https://example.com/"] }),
    ),
  ).toMatchObject({ code: "denied", requestState: "not_sent" });
  expect(fetch).not.toHaveBeenCalled();
  expect(
    await Effect.runPromise(client.run(alice, { query: "public" })),
  ).toMatchObject({ code: "denied", requestState: "possibly_sent" });
  expect(await client.capabilities(alice)).toEqual([]);
});

test("missing configuration and invalid public input never dispatch", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const missing = createTavily({ authorize: allow, fetch });
  expect(await missing.capabilities(alice)).toEqual([]);
  expect(
    await Effect.runPromise(missing.run(alice, { query: "public" })),
  ).toMatchObject({ code: "not_configured", requestState: "not_sent" });
  const client = createTavily({ apiKey, authorize: allow, fetch });
  for (const input of [
    { query: " " },
    { query: "x".repeat(501) },
    { query: "private\ncontext" },
    { urls: [] },
    {
      urls: ["https://example.com/"].concat(
        Array(5).fill("https://example.org/"),
      ),
    },
    { urls: ["http://localhost/secret"] },
    { urls: ["https://user:secret@example.com/"] },
    { urls: ["file:///etc/passwd"] },
  ])
    expect(await Effect.runPromise(client.run(alice, input))).toMatchObject({
      code: "invalid_input",
      requestState: "not_sent",
    });
  expect(fetch).not.toHaveBeenCalled();
});

test("extract preserves URL attribution and reports partial and total failure without raw error bodies", async () => {
  const urls = ["https://example.com/a", "https://example.org/b"];
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    expect(JSON.parse(String(init?.body))).toEqual({
      urls,
      extract_depth: "basic",
      format: "text",
      include_images: false,
      timeout: 10,
    });
    return Response.json({
      results: [
        { url: urls[1], raw_content: "b".repeat(6001) },
        { url: "https://unrequested.com/", raw_content: "ignore" },
      ],
      failed_results: [{ url: urls[0], error: apiKey }],
    });
  });
  const client = createTavily({ apiKey, authorize: allow, fetch });
  expect(await Effect.runPromise(client.run(alice, { urls }))).toEqual({
    status: "ready",
    provider: "tavily",
    untrusted: true,
    sources: [
      {
        title: urls[1],
        url: urls[1],
        content: "b".repeat(6000),
        truncated: true,
      },
    ],
    failedUrls: [urls[0]],
  });
  fetch.mockResolvedValue(
    Response.json({
      results: [],
      failed_results: urls.map((url) => ({ url, error: apiKey })),
    }),
  );
  expect(await Effect.runPromise(client.run(alice, { urls }))).toMatchObject({
    sources: [],
    failedUrls: urls,
  });
});

test.each([
  [401, "authorization_required"],
  [403, "authorization_required"],
  [429, "rate_limited"],
  [432, "quota_exceeded"],
  [433, "quota_exceeded"],
  [434, "capacity"],
  [500, "http"],
] as const)(
  "maps HTTP %s without exposing provider diagnostics or retrying",
  async (status, code) => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(apiKey, { status, headers: { "retry-after": "37" } }),
    );
    const client = createTavily({ apiKey, authorize: allow, fetch });
    expect(
      await Effect.runPromise(client.run(alice, { query: "public" })),
    ).toEqual({
      status: "unavailable",
      code,
      requestState: "possibly_sent",
      ...(status === 429 ? { retryAfterSeconds: 37 } : {}),
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);

test("bounds decoded response bytes and rejects malformed successful payloads", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const client = createTavily({ apiKey, authorize: allow, fetch });
  for (const body of [apiKey, JSON.stringify({ results: [{}] })]) {
    fetch.mockResolvedValueOnce(new Response(body));
    expect(
      await Effect.runPromise(client.run(alice, { query: "public" })),
    ).toMatchObject({ code: "invalid_response" });
  }
  fetch.mockResolvedValueOnce(new Response("x".repeat(131073)));
  expect(
    await Effect.runPromise(client.run(alice, { query: "public" })),
  ).toMatchObject({ code: "response_too_large" });
});

test("known service key cannot be exported in inputs or reflected source text", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    Response.json({
      results: [{ ...evidence.results[0], content: apiKey }],
    }),
  );
  const client = createTavily({ apiKey, authorize: allow, fetch });
  expect(
    await Effect.runPromise(client.run(alice, { query: apiKey })),
  ).toMatchObject({ code: "invalid_input", requestState: "not_sent" });
  expect(fetch).not.toHaveBeenCalled();
  expect(
    await Effect.runPromise(client.run(alice, { query: "public" })),
  ).toMatchObject({ code: "invalid_response", requestState: "possibly_sent" });
});

test("deadline covers a stalled response body and awaits its cancellation", async () => {
  let cleaned = false;
  const fetch = vi.fn<typeof globalThis.fetch>(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"results":['));
          },
          async cancel() {
            await new Promise((resolve) => setTimeout(resolve, 10));
            cleaned = true;
          },
        }),
      ),
  );
  const client = createTavily({
    apiKey,
    authorize: allow,
    fetch,
    timeoutMs: 5,
  });
  expect(
    await Effect.runPromise(client.run(alice, { query: "public" })),
  ).toMatchObject({ code: "timeout", requestState: "possibly_sent" });
  expect(cleaned).toBe(true);
});

test("timeout aborts the request and cancellation joins fetch cleanup", async () => {
  let entered!: () => void;
  const admitted = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let cleaned = false;
  const fetch = vi.fn<typeof globalThis.fetch>(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            setTimeout(() => {
              cleaned = true;
              reject(new Error(apiKey));
            }, 10);
          },
          { once: true },
        );
        entered();
      }),
  );
  const timeout = createTavily({
    apiKey,
    authorize: allow,
    fetch,
    timeoutMs: 5,
  });
  expect(
    await Effect.runPromise(timeout.run(alice, { query: "public" })),
  ).toMatchObject({ code: "timeout", requestState: "possibly_sent" });
  expect(cleaned).toBe(true);
  cleaned = false;
  const client = createTavily({ apiKey, authorize: allow, fetch });
  const controller = new AbortController();
  const result = Effect.runPromiseExit(client.run(alice, { query: "public" }), {
    signal: controller.signal,
  });
  await admitted;
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  controller.abort();
  await result;
  expect(cleaned).toBe(true);
});

test("installed Pi extension executes typed tool calls and returns citations to the model", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    Response.json(evidence),
  );
  const client = createTavily({ apiKey, authorize: allow, fetch });
  const registry = createRegistry();
  registry.install(createTavilyExtension({ client, scope: async () => alice }));
  const faux = fauxProvider({ tokensPerSecond: 0 });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("web_search", { query: "public research" }),
      { stopReason: "toolUse" },
    ),
    (context) => {
      const result = context.messages.at(-1);
      expect(result?.role).toBe("toolResult");
      expect(JSON.stringify(result)).toContain("https://example.com/article");
      expect(JSON.stringify(result)).not.toContain(apiKey);
      return fauxAssistantMessage(
        "Found evidence: https://example.com/article",
      );
    },
  ]);
  const harness = await Harness.open(
    new MemoryStorage(),
    { registry, models },
    BACKGROUND_CONTEXT,
  );
  try {
    const root = await harness.root(BACKGROUND_CONTEXT, {
      agent: {
        model: { provider: faux.provider.id, modelId: faux.getModel().id },
      },
    });
    const submission = await root.submit(
      { type: "input", content: "Research public evidence" },
      BACKGROUND_CONTEXT,
    );
    expect((await submission.wait(BACKGROUND_CONTEXT)).status).toBe("done");
    const entries = await root.entries({}, 100, undefined, BACKGROUND_CONTEXT);
    expect(JSON.stringify(entries)).toContain("Found evidence:");
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
});
