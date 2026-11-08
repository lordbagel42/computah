import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { type Principal, tokenHash } from "../src/config.js";
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
