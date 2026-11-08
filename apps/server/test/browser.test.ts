import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startObservability } from "@computah/observability";
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { Effect } from "effect";
import { setupTest } from "rivetkit/test";
import { expect, test } from "vitest";
import { type BrowserResult, createBrowser } from "../src/browser.js";
import { createAgentOSBrowser } from "../src/browser-agentos.js";
import { createCore } from "../src/core.js";

const alice = { tenantId: "browser-test", userId: "alice", agentId: "a" };
const bob = { ...alice, userId: "bob" };
const executable = process.env.COMPUTAH_TEST_AGENT_BROWSER;
const chromium = process.env.COMPUTAH_TEST_CHROMIUM;
const real = Boolean(executable && chromium);
const options = {
  executable: executable ?? "/not-installed/agent-browser",
  chromium: chromium ?? "/not-installed/chrome",
};
const run = (
  client: ReturnType<typeof createBrowser>,
  url: string,
  scope = alice,
) => Effect.runPromise(client.read(scope, url));

test("browser rejects denied bindings and non-web inputs before launch; missing executables are typed failures", async () => {
  const client = createBrowser({
    ...options,
    authorize: (scope) => scope.userId === "alice",
  });
  expect(await run(client, "https://example.org", bob)).toMatchObject({
    code: "denied",
    requestState: "not_sent",
    cleanup: "not_started",
  });
  for (const url of [
    "file:///etc/passwd",
    "javascript:alert(1)",
    "https://name:secret@example.org",
    "data:text/html,test",
    "https://example.org/\u0000",
  ])
    expect(await run(client, url)).toMatchObject({
      code: "invalid_input",
      requestState: "not_sent",
    });
  const missing = createBrowser({
    executable: "/not-installed/agent-browser",
    chromium: options.chromium,
    authorize: () => true,
  });
  expect(await run(missing, "https://example.org")).toMatchObject({
    code: "runtime",
    cleanup: "closed",
    requestState: "not_sent",
    stage: "launch",
  });
  const guest = createAgentOSBrowser(client);
  expect(await run(guest, "https://example.org", bob)).toMatchObject({
    code: "denied",
    requestState: "not_sent",
  });
});

async function fixture() {
  let revoke: (() => void) | undefined;
  let slow: (() => void) | undefined;
  const server = createServer((req, res) => {
    if (req.url === "/slow") {
      slow?.();
      return;
    }
    if (req.url === "/revoke") revoke?.();
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "/page" });
      res.end();
      return;
    }
    res.setHeader("content-type", "text/html");
    res.end(
      `<title>Browser fixture</title><body>Fresh page evidence<script>document.body.prepend(document.cookie || "empty-cookie:");document.body.prepend(localStorage.getItem("owned") || "empty-storage:");document.cookie="owned=session";localStorage.setItem("owned", "session")</script>${req.url === "/long" ? "x".repeat(20_000) : ""}</body>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture");
  return {
    url: `http://127.0.0.1:${address.port}`,
    revoke: (fn: () => void) => {
      revoke = fn;
    },
    slow: (fn: () => void) => {
      slow = fn;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test.skipIf(!real)(
  "real embedded guest CLI owns clean browser sessions, follows redirects, bounds text and joins cancellation/revocation cleanup",
  async () => {
    const site = await fixture();
    const base = await mkdtemp(join(tmpdir(), "browser-launch-test-"));
    const wrapper = join(base, "agent-browser");
    await writeFile(
      wrapper,
      `#!/bin/sh\n[ -z "\${COMPUTAH_SYNTHETIC_BROWSER_SECRET+x}" ] || exit 89\n[ -z "\${AGENT_BROWSER_CDP+x}" ] || exit 90\nexec '${executable}' "$@"\n`,
      { mode: 0o700 },
    );
    const previousSecret = process.env.COMPUTAH_SYNTHETIC_BROWSER_SECRET;
    const previousCdp = process.env.AGENT_BROWSER_CDP;
    process.env.COMPUTAH_SYNTHETIC_BROWSER_SECRET =
      "synthetic-must-not-reach-browser";
    process.env.AGENT_BROWSER_CDP = "http://127.0.0.1:1";
    const before = new Set(
      (await readdir(tmpdir())).filter((name) => name.startsWith("cb-")),
    );
    let granted = true;
    const host = createBrowser({
      ...options,
      executable: wrapper,
      authorize: () => granted,
    });
    const guest = createAgentOSBrowser(host);
    try {
      for (const scope of [alice, bob]) {
        const result = await run(guest, `${site.url}/redirect`, scope);
        expect(result).toMatchObject({
          status: "ready",
          title: "Browser fixture",
          url: `${site.url}/page`,
          cleanup: "closed",
          text: expect.stringContaining("empty-cookie:"),
        });
        if (result.status === "ready")
          expect(result.text).toContain("empty-storage:");
      }
      // Local HTTP is intentionally reachable: this wrapper makes no public-only claim.
      expect(await run(guest, `${site.url}/long`)).toMatchObject({
        status: "ready",
        truncated: true,
      });
      site.revoke(() => {
        granted = false;
      });
      expect(await run(guest, `${site.url}/revoke`)).toMatchObject({
        code: "denied",
        requestState: "possibly_sent",
        cleanup: "closed",
      });
      granted = true;
      let sourceAllowed = true;
      site.revoke(() => {
        sourceAllowed = false;
      });
      const sourceRevoked = async () => {
        if (!sourceAllowed) throw new Error("source denied");
      };
      expect(
        await Effect.runPromise(
          guest.read(alice, `${site.url}/revoke`, sourceRevoked),
        ),
      ).toMatchObject({ code: "denied", cleanup: "closed" });
      granted = true;
      const controller = new AbortController();
      site.slow(() => controller.abort());
      const started = Date.now();
      await expect(
        Effect.runPromise(guest.read(alice, `${site.url}/slow`), {
          signal: controller.signal,
        }),
      ).rejects.toBeDefined();
      expect(Date.now() - started).toBeLessThan(10_000);
      const short = createAgentOSBrowser(
        createBrowser({ ...options, timeoutMs: 1500, authorize: () => true }),
      );
      site.slow(() => {});
      expect(await run(short, `${site.url}/slow`)).toMatchObject({
        code: "timeout",
        cleanup: "closed",
        stage: "navigate",
      });
      const after = (await readdir(tmpdir())).filter(
        (name) => name.startsWith("cb-") && !before.has(name),
      );
      expect(after).toEqual([]);
    } finally {
      if (previousSecret === undefined)
        delete process.env.COMPUTAH_SYNTHETIC_BROWSER_SECRET;
      else process.env.COMPUTAH_SYNTHETIC_BROWSER_SECRET = previousSecret;
      if (previousCdp === undefined) delete process.env.AGENT_BROWSER_CDP;
      else process.env.AGENT_BROWSER_CDP = previousCdp;
      await site.close();
      await rm(base, { recursive: true, force: true });
    }
  },
);

test.skipIf(!real)(
  "native launch failure joins helpers after their process-group leader exits",
  async () => {
    const base = await mkdtemp(join(tmpdir(), "browser-orphan-test-"));
    const chrome = join(base, "chrome");
    const pidFile = join(base, "child");
    let child: number | undefined;
    try {
      await writeFile(
        chrome,
        `#!${process.execPath}
const {spawn} = require('node:child_process');
const {writeFileSync} = require('node:fs');
const profile = process.argv.find(arg => arg.startsWith('--user-data-dir='));
setTimeout(() => {
  const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', profile], {stdio: 'ignore'});
  writeFileSync(${JSON.stringify(pidFile)}, String(helper.pid));
  process.exit(0);
}, 100);
`,
        { mode: 0o700 },
      );
      const browser = createBrowser({
        ...options,
        chromium: chrome,
        timeoutMs: 2000,
        authorize: () => true,
      });
      expect(await run(browser, "https://example.org")).toMatchObject({
        status: "unavailable",
        cleanup: "closed",
        requestState: "not_sent",
      });
      child = Number(await readFile(pidFile, "utf8"));
      let state = "gone";
      try {
        const stat = await readFile(`/proc/${child}/stat`, "utf8");
        state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      expect(["gone", "Z"]).toContain(state);
    } finally {
      if (child) {
        try {
          process.kill(child, "SIGKILL");
        } catch {
          /* Already joined. */
        }
      }
      await rm(base, { recursive: true, force: true });
    }
  },
);

test("native Rivet Task discovers Worker browser only under a current grant and exports actual guest/host outcomes", async (context) => {
  const originalFetch = globalThis.fetch;
  const previousToken = process.env.COMPUTAH_AXIOM_INGEST_TOKEN;
  const previousDataset = process.env.COMPUTAH_AXIOM_LOG_DATASET;
  const traces: string[] = [];
  const logs: string[] = [];
  globalThis.fetch = async (input, init) => {
    if (
      [
        "https://api.axiom.co/v1/traces",
        "https://api.axiom.co/v1/logs",
      ].includes(String(input))
    ) {
      (String(input).endsWith("traces") ? traces : logs).push(
        String(init?.body),
      );
      return new Response("{}", { status: 200 });
    }
    return originalFetch(input, init);
  };
  process.env.COMPUTAH_AXIOM_INGEST_TOKEN = "synthetic-only";
  process.env.COMPUTAH_AXIOM_LOG_DATASET = "synthetic-logs";
  const telemetry = await startObservability("backend");
  const site = await fixture();
  let granted = true;
  let revokeAfterDiscovery = false;
  const results: BrowserResult[] = [];
  const model = {
    id: "test",
    name: "test",
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 4096,
  };
  const faux = createFauxCore({
    provider: "browser-test",
    api: "browser-test",
    models: [model],
    tokensPerSecond: 0,
  });
  const core = createCore({
    connectionSecret: "browser-test-secret-".repeat(4),
    model: "browser-test/test",
    apiKeys: { "browser-test": "synthetic" },
    browser: options,
    authorize: (scope, capability) =>
      capability !== "browser.read" || (granted && scope.userId === "alice"),
    providers: {
      "browser-test": {
        api: "browser-test",
        baseUrl: "http://unused.invalid",
        models: [model],
        streamSimple(model, request, config) {
          const tools = new Set<string>();
          for (const message of request.messages)
            if (message.role === "system") {
              for (const tool of message.toolsAdded ?? []) tools.add(tool.name);
              for (const tool of message.toolsRemoved ?? [])
                tools.delete(tool.name);
            }
          const interaction = tools.has("Task");
          const last = request.messages.at(-1);
          let response = fauxAssistantMessage("done");
          if (interaction) {
            expect(tools.has("browser_read")).toBe(false);
            if (last?.role !== "toolResult")
              response = fauxAssistantMessage(
                fauxToolCall("Task", { worker: "primary", text: "read" }),
                { stopReason: "toolUse" },
              );
          } else if (last?.role === "toolResult") {
            expect(last.isError).toBe(!real || revokeAfterDiscovery);
            results.push(
              JSON.parse(
                last.content
                  .filter((part) => part.type === "text")
                  .map((part) => part.text)
                  .join(""),
              ),
            );
          } else if (tools.has("browser_read")) {
            if (revokeAfterDiscovery) granted = false;
            response = fauxAssistantMessage(
              fauxToolCall("browser_read", { url: `${site.url}/page` }),
              { stopReason: "toolUse" },
            );
          }
          faux.setResponses([response]);
          return faux.streamSimple(model, request, config);
        },
      },
    },
  });
  try {
    const { client } = await setupTest(context, core.registry);
    const bind = core.attach(client);
    for (const [index, scope] of [alice, bob, alice].entries()) {
      const session = bind(scope);
      if (index === 2) {
        revokeAfterDiscovery = true;
        await session.sleep(session.workerId());
      }
      const before = results.length;
      const receipt = await session.submit(
        session.interactionId,
        "delegate",
        `browser-${index}`,
      );
      expect(
        (
          await session.result(
            session.interactionId,
            receipt.submissionId,
            true,
          )
        ).submission.status,
      ).toBe("done");
      if (index === 1) expect(results.length).toBe(before);
      else
        expect(results.at(-1)).toMatchObject(
          index === 2
            ? { code: "denied", requestState: "not_sent" }
            : real
              ? { status: "ready", cleanup: "closed" }
              : { code: "runtime", cleanup: "closed" },
        );
    }
    const missing = createAgentOSBrowser(
      createBrowser({
        ...options,
        executable: "/not-installed/agent-browser",
        authorize: () => true,
      }),
    );
    expect(await run(missing, site.url)).toMatchObject({
      code: "runtime",
      cleanup: "closed",
    });
    if (real) {
      const browser = createAgentOSBrowser(
        createBrowser({ ...options, timeoutMs: 1500, authorize: () => true }),
      );
      expect(await run(browser, `${site.url}/slow`)).toMatchObject({
        code: "timeout",
        cleanup: "closed",
      });
      const controller = new AbortController();
      site.slow(() => controller.abort());
      await expect(
        Effect.runPromise(browser.read(alice, `${site.url}/slow`), {
          signal: controller.signal,
        }),
      ).rejects.toBeDefined();
    }
  } finally {
    await core.close();
    await site.close();
    await telemetry.close();
    globalThis.fetch = originalFetch;
    if (previousToken === undefined)
      delete process.env.COMPUTAH_AXIOM_INGEST_TOKEN;
    else process.env.COMPUTAH_AXIOM_INGEST_TOKEN = previousToken;
    if (previousDataset === undefined)
      delete process.env.COMPUTAH_AXIOM_LOG_DATASET;
    else process.env.COMPUTAH_AXIOM_LOG_DATASET = previousDataset;
  }
  type Span = {
    name: string;
    traceId: string;
    spanId: string;
    parentSpanId?: string;
    attributes: { key: string; value: { stringValue?: string } }[];
  };
  const spans: Span[] = traces.flatMap((body) =>
    JSON.parse(body).resourceSpans.flatMap(
      (r: { scopeSpans: { spans: Span[] }[] }) =>
        r.scopeSpans.flatMap((s) => s.spans),
    ),
  );
  const agentos = spans.find(
    (span) => span.name === "computah.browser.agentos",
  );
  const read = spans.find(
    (span) =>
      span.name === "computah.browser.read" &&
      span.parentSpanId === agentos?.spanId,
  );
  const cleanup = spans.find(
    (span) =>
      span.name === "computah.browser.cleanup" &&
      span.parentSpanId === read?.spanId,
  );
  expect(agentos).toBeDefined();
  expect(read).toBeDefined();
  expect(cleanup).toBeDefined();
  expect(
    spans.find((span) => span.spanId === agentos?.parentSpanId)?.name,
  ).toBe("pi.durable.phase");
  expect(read?.traceId).toBe(agentos?.traceId);
  expect(cleanup?.traceId).toBe(agentos?.traceId);
  expect(logs.join()).toContain("browser.read");
  const browserSpans = spans.filter((span) =>
    span.name.startsWith("computah.browser."),
  );
  for (const span of browserSpans) expect(logs.join()).toContain(span.spanId);
  const outcomes = browserSpans.flatMap((span) =>
    span.attributes
      .filter((entry) => entry.key === "outcome")
      .map((entry) => entry.value.stringValue),
  );
  expect(outcomes).toEqual(
    expect.arrayContaining(
      real
        ? ["ready", "denied", "error", "timeout", "cancelled"]
        : ["denied", "error"],
    ),
  );
  for (const canary of [
    site.url,
    "Fresh page evidence",
    "browser-test-secret",
    "synthetic-must-not-reach-browser",
    "Browser fixture",
  ])
    expect([...traces, ...logs].join()).not.toContain(canary);
});
