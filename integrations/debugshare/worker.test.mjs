import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";
import { createTestHarness } from "wrangler";

const origin = "http://localhost";
const secrets = Object.fromEntries(
  [
    "BETTER_AUTH_SECRET",
    "BOOTSTRAP_TOKEN",
    "CAPTURE_SIGNING_SECRET",
    "NOTICE_TOKEN",
    "MIGRATION_TOKEN",
    "AGENT_MCP_TOKEN",
  ].map((key) => [
    key,
    createHash("sha256").update(`isolated-test:${key}`).digest("hex"),
  ]),
);
Object.assign(secrets, {
  AXIOM_TRACE_READ_TOKEN: "",
  AXIOM_TELEMETRY_TOKEN: "",
  NOTICE_CALLBACK_URL: "",
  CAPTURE_POLICY: JSON.stringify({
    team: "TTEST",
    tenantId: "test",
    userId: "owner",
    agentId: "core",
    enrollment: { ownerSlackUserId: "UTEST", deniedUserIds: ["UDENIED"] },
  }),
});
const fixture = (id = "computah_bug_aaaaaaaaaaaaaaaaaaaaaaaa") => ({
  id,
  requestedAt: "2026-11-09T00:00:00.000Z",
  requestedBy: "UTEST",
  source: { team: "TTEST", channel: "DTEST", message: "1.0", thread: null },
  scope: { tenantId: "test", userId: "owner", agentId: "core" },
  messages: [
    {
      author: "UTEST",
      ts: "1.0",
      text: "SYNTHETIC isolated migration acceptance",
    },
  ],
  participants: ["UTEST"],
  submissions: [],
  activity: [],
  limitations: ["SYNTHETIC: no real conversation"],
});

test("Worker authentication, immutable migration, capture and MCP authority", {
  timeout: 120_000,
}, async (t) => {
  const harness = createTestHarness({
    workers: [
      {
        configPath: "./wrangler.jsonc",
        secrets,
        vars: { CAPTURE_ENABLED: "true", NOTICE_DELIVERY_ENABLED: "false" },
      },
    ],
  });
  t.after(() => harness.close());
  await harness.listen();
  const worker = harness.getWorker();
  await worker.applyD1Migrations("AUTH_DB");
  const call = (path, method = "GET", body, token, extra = {}) =>
    harness.fetch(`${origin}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...extra,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const rpc = async (method, params, token = secrets.AGENT_MCP_TOKEN) => {
    const response = await call(
      "/mcp",
      "POST",
      { jsonrpc: "2.0", id: 1, method, params },
      token,
      { accept: "application/json, text/event-stream" },
    );
    assert.equal(response.status, 200);
    return response.json();
  };
  for (const token of [
    undefined,
    secrets.NOTICE_TOKEN,
    secrets.CAPTURE_SIGNING_SECRET,
    secrets.MIGRATION_TOKEN,
  ]) {
    assert.equal(
      (await call("/api/tools/explore", "POST", {}, token)).status,
      401,
    );
    assert.equal((await call("/mcp", "POST", {}, token)).status, 401);
  }
  const denied = await call("/api/tools/explore", "POST", {}, undefined, {
    "x-debug-operator": "authorized",
  });
  assert.equal(denied.status, 401);
  assert.equal(denied.headers.get("cache-control"), "no-store");
  assert.equal(
    (
      await call("/api/auth/sign-in/email", "POST", {
        email: "nobody@example.invalid",
        password: "12345678",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await call(
        "/api/auth/sign-up/email",
        "POST",
        {
          email: "nobody@example.invalid",
          password: "12345678",
          name: "not owner",
        },
        undefined,
        { origin },
      )
    ).status,
    403,
  );
  const owner = {
    email: "synthetic@example.invalid",
    password: "1234567",
    name: "SYNTHETIC owner",
  };
  assert.equal(
    (
      await call("/api/bootstrap", "POST", owner, secrets.BOOTSTRAP_TOKEN, {
        origin,
      })
    ).status,
    400,
  );
  owner.password = "12345678";
  assert.equal(
    (
      await call("/api/bootstrap", "POST", owner, secrets.BOOTSTRAP_TOKEN, {
        origin,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await call("/api/bootstrap", "POST", owner, secrets.BOOTSTRAP_TOKEN, {
        origin,
      })
    ).status,
    409,
  );
  const login = await call(
    "/api/auth/sign-in/email",
    "POST",
    owner,
    undefined,
    { origin: "https://debug.raygen.dev" },
  );
  assert.equal(login.status, 200);
  const cookie = login.headers
    .getSetCookie()
    .find((value) => value.startsWith("__Secure-debugshare.session_token="));
  assert.ok(
    cookie?.includes("HttpOnly") &&
      cookie.includes("Secure") &&
      cookie.includes("SameSite=Strict") &&
      !cookie.includes("Domain="),
  );
  const sessionCookie = cookie.split(";")[0];
  assert.equal(
    (
      await call("/api/tools/explore", "POST", {}, undefined, {
        origin,
        cookie: sessionCookie,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await call("/api/tools/explore", "POST", {}, undefined, {
        origin: "https://attacker.invalid",
        cookie: sessionCookie,
      })
    ).status,
    403,
  );
  const authEnv = await worker.getEnv();
  const credential = await authEnv.AUTH_DB.prepare(
    "SELECT password FROM account WHERE providerId='credential'",
  ).first();
  assert.notEqual(credential.password, owner.password);
  assert.ok(credential.password.length > 64);
  const report = fixture();
  const rawReport = JSON.stringify(report);
  const original = {
    issue: {
      id: report.id,
      title: "SYNTHETIC migration",
      status: "blocked",
      assignee: "synthetic",
      revision: 7,
      created: report.requestedAt,
      updated: report.requestedAt,
    },
    report,
    rawReport,
    snapshot: {
      bytes: Buffer.byteLength(rawReport),
      sha256: createHash("sha256").update(rawReport).digest("hex"),
    },
    events: [
      {
        id: "test-event-original",
        status: "blocked",
        actor: "synthetic",
        note: "SYNTHETIC original evidence",
        created: report.requestedAt,
      },
    ],
  };
  for (let i = 0; i < 2; i++)
    assert.equal(
      (
        await call(
          "/api/migration/import",
          "POST",
          { issues: [original] },
          secrets.MIGRATION_TOKEN,
        )
      ).status,
      200,
    );
  assert.equal(
    (
      await call(
        "/api/issue-notices/" + report.id,
        "GET",
        undefined,
        secrets.NOTICE_TOKEN,
      )
    ).status,
    404,
  );
  const conflict = structuredClone(original);
  conflict.events[0].note = "must not overwrite";
  const wrongIssueEvent = structuredClone(original);
  wrongIssueEvent.events[0].issue = "computah_bug_bbbbbbbbbbbbbbbbbbbbbbbb";
  assert.equal(
    (
      await call(
        "/api/migration/import",
        "POST",
        { issues: [wrongIssueEvent] },
        secrets.MIGRATION_TOKEN,
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await call(
        "/api/migration/import",
        "POST",
        { issues: [conflict] },
        secrets.MIGRATION_TOKEN,
      )
    ).status,
    409,
  );
  const backup = await (
    await call(
      "/api/migration/export",
      "GET",
      undefined,
      secrets.MIGRATION_TOKEN,
    )
  ).json();
  assert.deepEqual(backup.issues, [original]);
  const capture = async (value, timestamp = String(Date.now()), signature) => {
    const body = JSON.stringify(value);
    return harness.fetch(`${origin}/api/capture`, {
      method: "POST",
      headers: {
        "x-computah-timestamp": timestamp,
        "x-computah-signature":
          signature ??
          createHmac("sha256", secrets.CAPTURE_SIGNING_SECRET)
            .update(`${timestamp}.${body}`)
            .digest("hex"),
      },
      body,
    });
  };
  assert.equal((await capture(report)).status, 200);
  assert.equal(
    (
      await call(
        "/api/issue-notices/" + report.id,
        "GET",
        undefined,
        secrets.NOTICE_TOKEN,
      )
    ).status,
    404,
  );
  const fresh = fixture("computah_bug_bbbbbbbbbbbbbbbbbbbbbbbb");
  assert.equal(
    (await capture(fresh, String(Date.now() - 600_000))).status,
    401,
  );
  assert.equal(
    (await capture(fresh, String(Date.now()), "0".repeat(64))).status,
    401,
  );
  const wrong = structuredClone(fresh);
  wrong.requestedBy = "UDENIED";
  assert.equal((await capture(wrong)).status, 403);
  assert.equal((await capture(fresh)).status, 200);
  assert.equal((await capture(fresh)).status, 200);
  const noticePath = `/api/issue-notices/${fresh.id}`;
  assert.deepEqual(
    await (
      await call(noticePath, "GET", undefined, secrets.NOTICE_TOKEN)
    ).json(),
    { issue: fresh.id, version: 1, acknowledged: "" },
  );
  const ack = await (
    await call(`${noticePath}/ack`, "POST", {}, secrets.NOTICE_TOKEN)
  ).json();
  assert.ok(Number.isFinite(Date.parse(ack.acknowledged)));
  assert.deepEqual(
    await (
      await call(`${noticePath}/ack`, "POST", {}, secrets.NOTICE_TOKEN)
    ).json(),
    ack,
  );
  const listed = await rpc("tools/list", {});
  assert.ok(listed.result.tools.some((tool) => tool.name === "issue_history"));
  const detail = await rpc("tools/call", {
    name: "inspect_issue",
    arguments: { id: report.id },
  });
  assert.equal(
    JSON.parse(detail.result.content[0].text).snapshot.sha256,
    original.snapshot.sha256,
  );
  const input = {
    id: report.id,
    expectedRevision: 7,
    status: "investigating",
    assignee: "synthetic",
    actor: "SYNTHETIC test",
    note: "SYNTHETIC CAS proof",
  };
  assert.notEqual(
    (await rpc("tools/call", { name: "update_issue", arguments: input })).result
      .isError,
    true,
  );
  assert.equal(
    (await rpc("tools/call", { name: "update_issue", arguments: input })).result
      .isError,
    true,
  );
  await worker.evictDurableObject("IssueTracker", {
    name: "operator-tracker-v1",
  });
  assert.deepEqual(
    await (
      await call(noticePath, "GET", undefined, secrets.NOTICE_TOKEN)
    ).json(),
    ack,
  );
});
