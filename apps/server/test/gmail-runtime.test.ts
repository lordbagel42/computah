import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startObservability } from "@computah/observability";
import { expect, test, vi } from "vitest";
import { type Principal, tokenHash } from "../src/config.js";
import type { CoreSession } from "../src/core.js";
import { GMAIL_FULL_MAIL, type GmailProvider } from "../src/gmail.js";
import { createGmailRuntime, gmailConfig } from "../src/gmail-runtime.js";

const scope = { tenantId: "one", userId: "alice", agentId: "default" };
const principal: Principal = {
  ...scope,
  displayName: "Alice",
  tokenHash: tokenHash("synthetic-token"),
  capabilities: ["history.read", "task.send"],
};

test("protected account config rejects unknown principals and public authority fields", () => {
  const input = {
    scope,
    owner: "owner",
    account: "account",
    authConfigId: "config",
    path: "/private/gmail.sqlite",
    approvedManagedFullMail: true,
  };
  const env = (value: unknown) => ({
    COMPUTAH_GMAIL_JSON: JSON.stringify(value),
    COMPUTAH_COMPOSIO_API_KEY: "synthetic-project-key",
  });
  expect(gmailConfig(env(input), [principal])?.scope).toEqual(scope);
  expect(() =>
    gmailConfig(env({ ...input, grantVersion: "forged" }), [principal]),
  ).toThrow("protected binding");
  expect(() =>
    gmailConfig(env({ ...input, scope: { ...scope, userId: "bob" } }), [
      principal,
    ]),
  ).toThrow("protected binding");
  expect(() =>
    gmailConfig(env(input), [{ ...principal, capabilities: ["history.read"] }]),
  ).toThrow("protected binding");
});

test("runtime restores canonical binding, indexes history without model turns and denies cross-user retrieval", async () => {
  const dir = mkdtempSync(join(tmpdir(), "computah-gmail-runtime-"));
  let authorized = true;
  const provider: GmailProvider = {
    link: async () => {
      throw new Error("OAuth must not be redone");
    },
    complete: async () => {
      throw new Error("OAuth must not be redone");
    },
    verify: async (owner, id) => ({
      id,
      owner,
      authConfigId: "config",
      mailbox: "mailbox@example.invalid",
      requestedScopes: [GMAIL_FULL_MAIL],
      readAccessVerified: true,
    }),
    list: async () => ({ ids: ["a1"], next: null }),
    message: async () => ({
      id: "a1",
      threadId: "f1",
      internalDate: Date.now() - 10_000,
      labels: ["INBOX"],
      subject: "Invoice",
      from: "sender@example.invalid",
      text: "Original invoice evidence",
    }),
    checkpoint: async () => "10",
    history: async () => ({
      historyId: "20",
      added: [],
      deleted: [],
      changed: [],
      next: null,
    }),
    revoke: async () => {
      throw new Error("No upstream mutations");
    },
  };
  const config = gmailConfig(
    {
      COMPUTAH_GMAIL_JSON: JSON.stringify({
        scope,
        owner: "owner",
        account: "account",
        authConfigId: "config",
        path: join(dir, "gmail.sqlite"),
        approvedManagedFullMail: true,
      }),
      COMPUTAH_COMPOSIO_API_KEY: "synthetic-key",
    },
    [principal],
  );
  if (!config) throw new Error("Missing test config");
  const open = () =>
    createGmailRuntime({
      config,
      authorize: () => authorized,
      provider,
      bind: () => {
        throw new Error("Historical indexing must not dispatch models");
      },
    });
  let runtime = open();
  try {
    await runtime.initialize();
    runtime.start();
    await expect
      .poll(async () => (await runtime.status(scope)).indexed)
      .toBe(1);
    const original = await runtime.sources.preload(scope, "invoice");
    expect(original?.text).toContain("Original invoice evidence");
    expect(
      await runtime.sources.preload({ ...scope, userId: "bob" }, "invoice"),
    ).toBeNull();
    await expect(
      runtime.status({ ...scope, tenantId: "other" }),
    ).rejects.toThrow("denied");
    await runtime.close();
    runtime = open();
    await runtime.initialize();
    expect((await runtime.sources.preload(scope, "invoice"))?.grants).toEqual(
      original?.grants,
    );
    expect((await runtime.status(scope)).indexed).toBe(1);
    authorized = false;
    if (!original?.grants[0]) throw new Error("Missing original grant");
    await expect(
      runtime.sources.check(scope, original.grants[0]),
    ).rejects.toThrow("denied");
  } finally {
    await runtime.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runtime terminal unanswered result fails once, exports failure and lets historical indexing resume after restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "computah-gmail-terminal-"));
  const exported: string[] = [];
  const logs: string[] = [];
  const fetch = globalThis.fetch;
  vi.stubEnv("COMPUTAH_AXIOM_INGEST_TOKEN", "synthetic-token");
  vi.stubEnv("COMPUTAH_AXIOM_LOG_DATASET", "synthetic-gmail-logs");
  vi.stubGlobal(
    "fetch",
    async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      if (String(input) === "https://api.axiom.co/v1/traces") {
        exported.push(String(init?.body));
        return Response.json({});
      }
      if (String(input) === "https://api.axiom.co/v1/logs") {
        logs.push(String(init?.body));
        return Response.json({});
      }
      return fetch(input, init);
    },
  );
  const telemetry = await startObservability("backend");
  let historyReads = 0;
  const provider: GmailProvider = {
    link: async () => {
      throw new Error("No OAuth");
    },
    complete: async () => {
      throw new Error("No OAuth");
    },
    verify: async (owner, id) => ({
      id,
      owner,
      authConfigId: "config",
      mailbox: "private-mailbox-canary",
      requestedScopes: [GMAIL_FULL_MAIL],
      readAccessVerified: true,
    }),
    list: async () => ({ ids: ["b2"], next: null }),
    message: async (_owner, _account, id) => ({
      id,
      threadId: "f1",
      internalDate: Date.now() - 10_000,
      labels: ["INBOX"],
      subject: "Question",
      from: "private-sender-canary",
      text: "private-email-canary",
    }),
    checkpoint: async () => "10",
    history: async () => {
      historyReads++;
      return {
        historyId: "20",
        added: ["a1"],
        deleted: [],
        changed: [],
        next: null,
      };
    },
    revoke: async () => {
      throw new Error("No mutations");
    },
  };
  const admitted: string[] = [];
  const config = {
    scope,
    owner: "private-owner-canary",
    account: "private-account-canary",
    authConfigId: "config",
    path: join(dir, "gmail.sqlite"),
    approvedManagedFullMail: true,
    apiKey: "private-key-canary",
  };
  const open = () =>
    createGmailRuntime({
      config,
      provider,
      authorize: () => true,
      bind: () =>
        ({
          interactionId: "synthetic-interaction",
          submitSource: async (_description: string, receipt: string) => {
            admitted.push(receipt);
            return { submissionId: "synthetic-terminal-submission" };
          },
          result: async () => ({
            submission: { status: "unanswered" },
            entries: [],
          }),
        }) as unknown as CoreSession,
    });
  let runtime = open();
  try {
    await runtime.initialize();
    runtime.start();
    await expect.poll(async () => (await runtime.status(scope)).failed).toBe(1);
    await runtime.close();
    runtime = open();
    await runtime.initialize();
    const before = historyReads;
    runtime.start();
    await expect
      .poll(async () => (await runtime.status(scope)).pending)
      .toBe(0);
    expect(historyReads).toBeGreaterThan(before);
    expect(await runtime.status(scope)).toMatchObject({
      indexed: 2,
      failed: 1,
    });
    expect(await runtime.drafts(scope)).toEqual([]);
    expect(admitted).toHaveLength(1);
  } finally {
    await runtime.close();
    await telemetry.close();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  }
  const spans: {
    name: string;
    traceId: string;
    spanId: string;
    parentSpanId?: string;
    links: unknown[];
    status: { code: number };
    attributes: { key: string; value: { stringValue?: string } }[];
  }[] = exported.flatMap((body) =>
    JSON.parse(body).resourceSpans.flatMap(
      (resource: { scopeSpans: { spans: unknown[] }[] }) =>
        resource.scopeSpans.flatMap((scope) => scope.spans),
    ),
  );
  const failure = spans.find(
    (span) => span.name === "computah.gmail.drain" && span.status.code === 2,
  );
  expect(failure?.traceId).toMatch(/^[a-f0-9]{32}$/);
  expect(failure?.parentSpanId).toMatch(/^[a-f0-9]{16}$/);
  expect(failure?.links.length).toBeGreaterThan(0);
  const records = logs.flatMap((body) =>
    JSON.parse(body).resourceLogs.flatMap(
      (resource: { scopeLogs: { logRecords: unknown[] }[] }) =>
        resource.scopeLogs.flatMap((scope) => scope.logRecords),
    ),
  );
  expect(records).toContainEqual(
    expect.objectContaining({
      body: { stringValue: "operation.completed" },
      traceId: failure?.traceId,
      spanId: failure?.spanId,
      attributes: expect.arrayContaining([
        { key: "operation", value: { stringValue: "gmail.drain" } },
        { key: "outcome", value: { stringValue: "error" } },
      ]),
    }),
  );
  for (const value of [
    "private-email-canary",
    "private-owner-canary",
    "private-account-canary",
    "private-key-canary",
    "private-mailbox-canary",
    ...admitted,
  ])
    expect(exported.join() + logs.join()).not.toContain(value);
});
