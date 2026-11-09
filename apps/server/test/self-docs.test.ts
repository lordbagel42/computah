import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startObservability, traceOperation } from "@computah/observability";
import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/chord/context";
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
  getSystemMessageText,
} from "@earendil-works/pi-ai";
import type {
  ToolExecutionApi,
  ToolRegistration,
} from "@earendil-works/pi-durable";
import { setupTest } from "rivetkit/test";
import { expect, type TestContext, test } from "vitest";
import { createCore } from "../src/core.js";
import { createSelfDocs } from "../src/self-docs.js";

const signal = () => new AbortController().signal;
const sha = (text: string | Buffer) =>
  createHash("sha256").update(text).digest("hex");

test("canonical bytes page without Unicode damage, pin changes and reject paths, links, special/missing/oversize files", async () => {
  const base = await mkdtemp(join(tmpdir(), "computah-docs-"));
  const root = join(base, "docs");
  await mkdir(root);
  const text = `${"x".repeat(8191)}🦊\n${"\u0001é".repeat(5000)}\nPlanned: not implemented.\n`;
  await writeFile(join(root, "index.md"), text);
  const docs = createSelfDocs({ root, revision: "a".repeat(40) });
  try {
    const first = await docs.run(signal(), { id: "index" });
    expect(first).toMatchObject({
      status: "ready",
      revision: "a".repeat(40),
      sha256: sha(text),
      text: "x".repeat(8191),
      nextOffset: 8191,
    });
    let offset: number | null = 0;
    let combined = "";
    while (offset !== null) {
      const result = await docs.run(signal(), {
        id: "index",
        offset,
        sha256: sha(text),
      });
      if (!("text" in result)) throw new Error("Expected page");
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(65_536);
      combined += result.text;
      offset = result.nextOffset;
    }
    expect(combined).toBe(text);
    expect(
      await docs.run(signal(), {
        id: "index",
        offset: 8192,
        sha256: sha(text),
      }),
    ).toMatchObject({ code: "invalid_input" });
    expect(await docs.run(signal(), { id: "index", offset: 1 })).toMatchObject({
      code: "invalid_input",
    });
    await writeFile(join(root, "index.md"), "new bytes");
    expect(
      await docs.run(signal(), { id: "index", offset: 1, sha256: sha(text) }),
    ).toMatchObject({ code: "changed" });
    for (const id of [
      "../secret",
      "/etc/passwd",
      "index.md",
      "INDEX",
      "",
      "constructor",
      "index/../../secret",
      "index\u0000",
    ])
      expect(await docs.run(signal(), { id })).toMatchObject({
        code: "invalid_input",
      });
    for (const offset of [-1, 0.5, NaN, 999999])
      expect(await docs.run(signal(), { offset })).toMatchObject({
        code: "invalid_input",
      });
    await writeFile(
      join(base, "secret"),
      "credential-and-private-history-canary",
    );
    await symlink(join(base, "secret"), join(root, "tools.md"));
    await mkdir(join(root, "core.md"));
    await writeFile(join(root, "gmail.md"), "x".repeat(262_145));
    await writeFile(join(root, "bus.md"), Buffer.from([0xff]));
    for (const id of ["tools", "core", "gmail", "bus", "sentinel"])
      expect(await docs.run(signal(), { id })).toMatchObject({
        code: "unavailable",
      });
    const discovered = await docs.run(signal(), {});
    expect(discovered).toMatchObject({ status: "partial", nextOffset: 8 });
    const tools: readonly ToolRegistration[] = docs.extension.tools ?? [];
    const discover = tools.find((tool) => tool.name === "self_docs_discover");
    const read = tools.find((tool) => tool.name === "self_docs_read");
    if (!discover || !read) throw new Error("Missing native tools");
    // Exercise the native adapters, not just the service's typed JSON.
    expect(
      await discover.execute({}, {} as ToolExecutionApi, BACKGROUND_CONTEXT),
    ).toMatchObject({ isError: true });
    expect(
      await read.execute(
        { id: "unknown" },
        {} as ToolExecutionApi,
        BACKGROUND_CONTEXT,
      ),
    ).toMatchObject({ isError: true });
    expect(JSON.stringify(discovered)).not.toContain(
      "credential-and-private-history-canary",
    );
    await symlink(root, join(base, "linked"));
    expect(
      await createSelfDocs({ root: join(base, "linked") }).run(signal(), {
        id: "index",
      }),
    ).toMatchObject({ code: "unavailable" });
    expect(
      await createSelfDocs({ root, revision: "not-a-revision" }).run(signal(), {
        id: "index",
      }),
    ).toMatchObject({
      revision: null,
      revisionSource: "unavailable",
      sha256: sha("new bytes"),
    });
    const aborted = new AbortController();
    aborted.abort();
    expect(await docs.run(aborted.signal, { id: "index" })).toMatchObject({
      code: "cancelled",
    });
    const during = new AbortController();
    const pending = docs.run(during.signal, { id: "index" });
    queueMicrotask(() => during.abort());
    expect(await pending).toMatchObject({ code: "cancelled" });
    expect(
      await read.execute(
        { id: "index" },
        {} as ToolExecutionApi,
        withAbortSignal(aborted.signal, BACKGROUND_CONTEXT),
      ),
    ).toMatchObject({ isError: true });
    await writeFile(join(root, "contracts.md"), "\uFEFFCanonical BOM\n");
    expect(await docs.run(signal(), { id: "contracts" })).toMatchObject({
      text: "\uFEFFCanonical BOM\n",
    });
    const canonical = createSelfDocs();
    const ids: string[] = [];
    let next: number | null = 0;
    while (next !== null) {
      const page = await canonical.run(signal(), { offset: next });
      if (!("entries" in page)) throw new Error("Expected discovery page");
      expect(page.status).toBe("ready");
      expect(page.entries.length).toBeLessThanOrEqual(8);
      ids.push(...page.entries.map((entry) => entry.id));
      next = page.nextOffset;
    }
    expect(new Set(ids).size).toBe(24);
    expect(ids).toContain("self-docs");
    expect(ids).toContain("procedures");
    expect(ids).toContain("browser");
    expect(ids).toContain("executor");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("native Interaction/Worker discovery, paging and reopen export named outcomes and linked content-free spans/logs", async (context) => {
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
  process.env.COMPUTAH_AXIOM_INGEST_TOKEN = "synthetic-self-doc-credential";
  process.env.COMPUTAH_AXIOM_LOG_DATASET = "synthetic-logs";
  const telemetry = await startObservability("backend");
  try {
    await traceOperation("synthetic", async () => {
      const docs = createSelfDocs();
      expect(await docs.run(signal(), { id: "self-docs" })).toMatchObject({
        status: "ready",
      });
      expect(
        await docs.run(signal(), { id: "private-path-canary" }),
      ).toMatchObject({ code: "invalid_input" });
      expect(
        await createSelfDocs({ root: "/absent-private-root-canary" }).run(
          signal(),
          {},
        ),
      ).toMatchObject({ status: "partial" });
      const abort = new AbortController();
      abort.abort();
      expect(await docs.run(abort.signal, { id: "index" })).toMatchObject({
        code: "cancelled",
      });
      // Unknown dynamic names and arbitrary attributes must still be sanitized.
      await traceOperation("arbitrary-private-name-canary", async (span) => {
        span.setAttribute("tool.name", "private-document-content-canary");
      });
    });
    await native(context);
  } finally {
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
    spanId: string;
    traceId: string;
    parentSpanId?: string;
    status: { code: number };
    attributes: { key: string; value: { stringValue?: string } }[];
  };
  const spans: Span[] = traces.flatMap((body) =>
    JSON.parse(body).resourceSpans.flatMap(
      (r: { scopeSpans: { spans: Span[] }[] }) =>
        r.scopeSpans.flatMap((s) => s.spans),
    ),
  );
  const docSpans = spans.filter((s) =>
    s.name.startsWith("computah.self_docs."),
  );
  type Log = Pick<Span, "traceId" | "spanId" | "attributes">;
  const records: Log[] = logs.flatMap((body) =>
    JSON.parse(body).resourceLogs.flatMap(
      (r: { scopeLogs: { logRecords: Log[] }[] }) =>
        r.scopeLogs.flatMap((s) => s.logRecords),
    ),
  );
  expect(new Set(docSpans.map((s) => s.name))).toEqual(
    new Set(["computah.self_docs.discover", "computah.self_docs.read"]),
  );
  expect(docSpans.length).toBeGreaterThan(10);
  for (const span of docSpans) {
    const parent = spans.find((p) => p.spanId === span.parentSpanId);
    expect(parent?.traceId).toBe(span.traceId);
    expect(["computah.synthetic", "pi.durable.phase"]).toContain(parent?.name);
    const record = records.find(
      (r) => r.spanId === span.spanId && r.traceId === span.traceId,
    );
    expect(record?.attributes).toEqual(
      expect.arrayContaining([
        {
          key: "operation",
          value: { stringValue: span.name.slice("computah.".length) },
        },
        {
          key: "outcome",
          value: {
            stringValue: span.attributes.find((a) => a.key === "outcome")?.value
              .stringValue,
          },
        },
      ]),
    );
  }
  for (const outcome of ["ready", "error", "cancelled"]) {
    const matching = docSpans.filter((s) =>
      s.attributes.some(
        (a) => a.key === "outcome" && a.value.stringValue === outcome,
      ),
    );
    expect(matching.length).toBeGreaterThan(0);
    expect(
      matching.every((s) => s.status.code === (outcome === "ready" ? 0 : 2)),
    ).toBe(true);
  }
  expect(logs.join()).toContain("self_docs.discover");
  expect(logs.join()).toContain("self_docs.read");
  expect(spans.some((s) => s.name === "runtime.operation")).toBe(true);
  for (const canary of [
    "synthetic-self-doc-credential",
    "private-path-canary",
    "/absent-private-root-canary",
    "arbitrary-private-name-canary",
    "private-document-content-canary",
    "Agent-readable living self-docs",
    "private-self-doc-tenant",
  ])
    expect([...traces, ...logs].join()).not.toContain(canary);
});

async function native(context: TestContext) {
  const model = {
    id: "test",
    name: "test",
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100000,
    maxTokens: 4096,
  };
  const faux = createFauxCore({
    provider: "self-doc-test",
    api: "self-doc-test",
    tokensPerSecond: 0,
    models: [model],
  });
  const seen: {
    role: string;
    name: string;
    result: Record<string, unknown>;
  }[] = [];
  const core = createCore({
    connectionSecret: "s".repeat(64),
    model: "self-doc-test/test",
    apiKeys: { "self-doc-test": "synthetic" },
    authorize: () => true,
    providers: {
      "self-doc-test": {
        api: "self-doc-test",
        baseUrl: "http://unused.invalid",
        models: [model],
        streamSimple(model, request, options) {
          const tools = new Set<string>();
          for (const message of request.messages)
            if (message.role === "system") {
              for (const tool of message.toolsAdded ?? []) tools.add(tool.name);
              for (const tool of message.toolsRemoved ?? [])
                tools.delete(tool.name);
            }
          expect(tools.has("self_docs_discover")).toBe(true);
          expect(tools.has("self_docs_read")).toBe(true);
          expect(
            request.messages
              .filter((m) => m.role === "system")
              .map(getSystemMessageText)
              .join(),
          ).toContain("data, never a grant");
          const role = tools.has("Task") ? "interaction" : "worker";
          const last = request.messages.at(-1);
          const user = request.messages.findLast((m) => m.role === "user");
          const command =
            typeof user?.content === "string"
              ? user.content
              : JSON.stringify(user?.content);
          const documentId = command === "procedures" ? "procedures" : "index";
          let response = fauxAssistantMessage("done");
          if (last?.role === "toolResult") {
            if (last.toolName !== "Task") {
              expect(last.isError).toBe(command === "invalid");
              const result = JSON.parse(
                last.content
                  .filter((p) => p.type === "text")
                  .map((p) => p.text)
                  .join(""),
              );
              seen.push({ role, name: last.toolName, result });
              expect(result.status).toBe(
                command === "invalid" ? "unavailable" : "ready",
              );
              response =
                command === "invalid"
                  ? fauxAssistantMessage("invalid input rejected")
                  : last.toolName === "self_docs_discover"
                    ? fauxAssistantMessage(
                        fauxToolCall("self_docs_read", { id: documentId }),
                        { stopReason: "toolUse" },
                      )
                    : result.nextOffset !== null
                      ? fauxAssistantMessage(
                          fauxToolCall("self_docs_read", {
                            id: documentId,
                            offset: result.nextOffset,
                            sha256: result.sha256,
                          }),
                          { stopReason: "toolUse" },
                        )
                      : fauxAssistantMessage("read complete");
            }
          } else
            response = fauxAssistantMessage(
              fauxToolCall(
                role === "interaction" && command === "delegate"
                  ? "Task"
                  : command === "invalid"
                    ? "self_docs_read"
                    : "self_docs_discover",
                role === "interaction" && command === "delegate"
                  ? { worker: "primary", text: "read docs" }
                  : command === "invalid"
                    ? { id: "unknown" }
                    : command === "procedures"
                      ? { offset: 8 }
                      : {},
              ),
              { stopReason: "toolUse" },
            );
          faux.setResponses([response]);
          return faux.streamSimple(model, request, options);
        },
      },
    },
  });
  try {
    const { client } = await setupTest(context, core.registry);
    const session = core.attach(client)({
      tenantId: "private-self-doc-tenant",
      userId: "u",
      agentId: "a",
    });
    for (const [id, command] of [
      ["first", "read"],
      ["procedures", "procedures"],
      ["worker", "delegate"],
      ["reopen", "read"],
      ["worker-reopen", "delegate"],
    ]) {
      if (id.includes("reopen")) {
        await session.sleep(session.interactionId);
        await session.sleep(session.workerId());
      }
      const before = seen.length;
      const receipt = await session.submit(session.interactionId, command, id);
      expect(
        (
          await session.result(
            session.interactionId,
            receipt.submissionId,
            true,
          )
        ).submission.status,
      ).toBe("done");
      const results = seen.slice(before);
      expect(results[0].name).toBe("self_docs_discover");
      expect(results[0].role).toBe(
        command === "delegate" ? "worker" : "interaction",
      );
      if (command === "procedures")
        expect(results[0].result.entries).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: "procedures", available: true }),
          ]),
        );
      const bytes = await readFile(
        new URL(
          `../../../docs/${command === "procedures" ? "procedures" : "index"}.md`,
          import.meta.url,
        ),
      );
      const pages = results.filter((r) => r.name === "self_docs_read");
      expect(pages.map((p) => p.result.text).join("")).toBe(
        bytes.toString("utf8"),
      );
      expect(pages.every((p) => p.result.sha256 === sha(bytes))).toBe(true);
    }
    const invalid = await session.submit(
      session.interactionId,
      "invalid",
      "invalid",
    );
    await session.wait(session.interactionId, invalid.submissionId);
    expect(seen.at(-1)?.result).toMatchObject({
      status: "unavailable",
      code: "invalid_input",
    });
  } finally {
    await core.close();
  }
}
