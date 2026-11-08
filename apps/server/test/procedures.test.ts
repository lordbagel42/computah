import { randomBytes } from "node:crypto";
import { startObservability } from "@computah/observability";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { setupTest } from "rivetkit/test";
import { expect, test, vi } from "vitest";
import { createCore } from "../src/core.js";
import type { DraftRequest } from "../src/procedures.js";

const scope = {
  tenantId: "procedure-private-tenant",
  userId: "alice",
  agentId: "default",
};
const create: DraftRequest = {
  action: "create",
  operationId: "mail-one",
  requestId: "create-one",
  expectedVersion: "0",
  recipients: "synthetic@example.invalid",
  subject: "PRIVATE-SUBJECT",
  body: "PRIVATE-DRAFT-ORIGINAL",
};
function request(
  action: string,
  expectedVersion: string,
  requestId = `${action}-${expectedVersion}`,
): DraftRequest {
  return {
    action,
    expectedVersion,
    requestId,
    operationId: create.operationId,
    recipients: "",
    subject: "",
    body: "",
  };
}
function value(result: { output: { text: string }[] }) {
  return JSON.parse(result.output[0].text);
}

test("native Task/Worker drafts persist, enforce exact versioned holds and isolate current source authority", async (context) => {
  const originalFetch = globalThis.fetch;
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
  const oldToken = process.env.COMPUTAH_AXIOM_INGEST_TOKEN;
  const oldDataset = process.env.COMPUTAH_AXIOM_LOG_DATASET;
  process.env.COMPUTAH_AXIOM_INGEST_TOKEN = "synthetic-only";
  process.env.COMPUTAH_AXIOM_LOG_DATASET = "synthetic-logs";
  const telemetry = await startObservability("backend");
  let sourceAllowed = true;
  let toolAllowed = true;
  let sourceBarrier: { remaining: number; enter(): Promise<void> } | undefined;
  let toolBarrier: (() => Promise<void>) | undefined;
  let armCancellation = false;
  const faux = fauxProvider({
    provider: "procedures-test",
    models: [{ id: "test" }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("Task", { worker: "mail", text: "Prepare a local reply" }),
      { stopReason: "toolUse" },
    ),
    (input) => {
      expect(JSON.stringify(input.messages)).toContain("procedure_draft");
      return fauxAssistantMessage(fauxToolCall("procedure_draft", create), {
        stopReason: "toolUse",
      });
    },
    (input) => {
      expect(JSON.stringify(input.messages.at(-1))).toContain(
        "UNSENT LOCAL DRAFT",
      );
      return fauxAssistantMessage("Local draft prepared, no email sent");
    },
    fauxAssistantMessage("Unsent local reply ready for review"),
    () => {
      toolAllowed = false;
      return fauxAssistantMessage(
        fauxToolCall("procedure_draft", request("read", "")),
        { stopReason: "toolUse" },
      );
    },
    (input) => {
      expect(JSON.stringify(input.messages.at(-1))).toContain(
        "Local draft denied",
      );
      return fauxAssistantMessage("Draft access denied");
    },
    () => {
      armCancellation = true;
      return fauxAssistantMessage(
        fauxToolCall("procedure_draft", {
          ...create,
          operationId: "abort-before-commit",
          requestId: "abort-create",
        }),
        { stopReason: "toolUse" },
      );
    },
  ]);
  const options = {
    connectionSecret: randomBytes(32).toString("hex"),
    authorize: async (_scope: unknown, capability: string) => {
      if (capability === "history.read" && armCancellation && toolBarrier) {
        armCancellation = false;
        await toolBarrier();
      }
      return capability !== "task.send" || toolAllowed;
    },
    model: "procedures-test/test",
    models,
    sources: {
      available: () => true,
      check: async () => {
        if (!sourceAllowed) throw new Error("revoked");
        if (sourceBarrier && --sourceBarrier.remaining === 0) {
          const barrier = sourceBarrier;
          sourceBarrier = undefined;
          await barrier.enter();
        }
      },
      preload: async () => null,
    },
    settings: { retry: { enabled: false } },
  };
  let core = createCore(options);
  const clock = vi.spyOn(Date, "now");
  try {
    const { client } = await setupTest(context, core.registry);
    let session = core.attach(client)(scope);
    const admission = await session.submitSource(
      "Prepare a local reply",
      "mail-receipt",
      { handle: "private-account", version: "one" },
      "PRIVATE-SOURCE",
    );
    expect(
      (
        await session.result(
          session.interactionId,
          admission.submissionId,
          true,
        )
      ).submission.status,
    ).toBe("done");
    const worker = session.workerId("mail");
    const read = async () =>
      value(await session.procedureDraft(worker, request("read", "")));
    const first = await read();
    expect(first).toMatchObject({
      version: 1,
      state: "held",
      holdMs: 120000,
      policyVersion: 1,
      localEligible: false,
      externalSendEnabled: false,
    });
    expect(first.notBefore - first.createdAt).toBe(120000);
    expect(first.creatorTaskId).not.toBe("trusted-host");
    clock.mockReturnValue(first.createdAt + 119999);
    expect((await read()).localEligible).toBe(false);
    await expect(
      session.procedureDraft(worker, request("claim", "1")),
    ).rejects.toMatchObject({ code: "held" });
    const edited = {
      ...create,
      action: "edit",
      requestId: "edit-one",
      expectedVersion: "1",
      body: "PRIVATE-DRAFT-EDITED",
    };
    const revision = value(await session.procedureDraft(worker, edited));
    expect(revision).toMatchObject({
      version: 2,
      notBefore: first.createdAt + 239999,
      body: edited.body,
    });
    expect(value(await session.procedureDraft(worker, edited)).version).toBe(2);
    await expect(
      session.procedureDraft(worker, { ...edited, body: "conflicting" }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      session.procedureDraft(worker, { ...create, requestId: "other-create" }),
    ).rejects.toMatchObject({ code: "conflict" });
    clock.mockReturnValue(first.notBefore);
    expect((await read()).localEligible).toBe(false);
    await session.sleep(worker);
    expect((await read()).body).toBe(edited.body);
    clock.mockReturnValue(revision.notBefore - 1);
    await expect(
      session.procedureDraft(worker, request("claim", "2", "early")),
    ).rejects.toThrow();
    clock.mockReturnValue(revision.notBefore);
    expect((await read()).localEligible).toBe(true);
    // Same-version edit/cancel is serialized: precisely one transition wins.
    const races = await Promise.allSettled([
      session.procedureDraft(worker, {
        ...edited,
        requestId: "race-edit",
        expectedVersion: "2",
      }),
      session.procedureDraft(worker, request("cancel", "2", "race-cancel")),
    ]);
    expect(races.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const raced = await read();
    expect(raced.version).toBe(3);
    if (raced.state === "held") {
      expect(raced.notBefore).toBe(revision.notBefore + 120000);
      await session.procedureDraft(
        worker,
        request("cancel", "3", "final-cancel"),
      );
    }
    expect(await read()).toMatchObject({
      state: "cancelled",
      localEligible: false,
    });
    // A late retry cannot resurrect a cancelled version or report stale eligibility.
    expect(value(await session.procedureDraft(worker, create))).toMatchObject({
      state: "cancelled",
      localEligible: false,
    });
    const second = {
      ...create,
      operationId: "mail-two",
      requestId: "create-two",
    };
    const held = value(await session.procedureDraft(worker, second));
    clock.mockReturnValue(held.notBefore);
    const claim = {
      ...request("claim", "1", "claim-two"),
      operationId: second.operationId,
    };
    const dueRace = await Promise.allSettled([
      session.procedureDraft(worker, claim),
      session.procedureDraft(worker, {
        ...claim,
        action: "cancel",
        requestId: "cancel-two",
      }),
    ]);
    expect(dueRace.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const due = value(
      await session.procedureDraft(worker, {
        ...request("read", ""),
        operationId: second.operationId,
      }),
    );
    expect(["local-eligible", "cancelled"]).toContain(due.state);
    expect(due.delivery).toBe("UNSENT LOCAL DRAFT");
    const claimable = value(
      await session.procedureDraft(worker, {
        ...create,
        operationId: "exact-claim",
        requestId: "create-exact",
      }),
    );
    const exactClaim = {
      ...request("claim", "1", "exact-claim"),
      operationId: "exact-claim",
    };
    clock.mockReturnValue(claimable.notBefore - 1);
    await expect(session.procedureDraft(worker, exactClaim)).rejects.toThrow();
    clock.mockReturnValue(claimable.notBefore);
    expect(
      value(await session.procedureDraft(worker, exactClaim)),
    ).toMatchObject({
      state: "local-eligible",
      localEligible: true,
      version: 2,
      externalSendEnabled: false,
    });
    expect(
      value(await session.procedureDraft(worker, exactClaim)).version,
    ).toBe(2);
    await expect(
      session.procedureDraft(worker, {
        ...exactClaim,
        action: "cancel",
        requestId: "too-late",
        expectedVersion: "2",
      }),
    ).rejects.toThrow();
    const snapshotRequest = {
      ...create,
      operationId: "snapshot",
      requestId: "create-snapshot",
    };
    const snapshot = value(
      await session.procedureDraft(worker, snapshotRequest),
    );
    clock.mockReturnValue(snapshot.notBefore - 1);
    let entered!: () => void;
    let release!: () => void;
    const paused = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    sourceBarrier = {
      remaining: 2,
      enter: async () => {
        entered();
        await released;
      },
    };
    const oldRead = session.procedureDraft(worker, {
      ...request("read", ""),
      operationId: "snapshot",
    });
    await paused;
    clock.mockReturnValue(snapshot.notBefore);
    await session.procedureDraft(worker, {
      ...snapshotRequest,
      action: "edit",
      expectedVersion: "1",
      requestId: "edit-snapshot",
    });
    release();
    expect(value(await oldRead)).toMatchObject({
      version: 1,
      observedAt: snapshot.notBefore - 1,
      localEligible: false,
    });
    expect(
      value(
        await session.procedureDraft(worker, {
          ...request("read", ""),
          operationId: "snapshot",
        }),
      ),
    ).toMatchObject({ version: 2, localEligible: false });
    await expect(
      core
        .attach(client)({ ...scope, userId: "bob" })
        .procedureDraft(worker, request("read", "")),
    ).rejects.toThrow("denied");
    await expect(
      core
        .attach(client)({ ...scope, userId: "bob" })
        .procedureDraft(session.workerId("bob-mail"), request("read", "")),
    ).rejects.toThrow();
    sourceAllowed = false;
    for (const action of ["read", "edit", "claim", "cancel"])
      await expect(
        session.procedureDraft(
          worker,
          request(action, "3", `revoked-${action}`),
        ),
      ).rejects.toThrow();
    sourceAllowed = true;
    const revoke = await session.submit(
      worker,
      "Revoke tool grant during model call",
      "revoke-native",
    );
    expect(
      (await session.result(worker, revoke.submissionId, true)).submission
        .status,
    ).toBe("done");
    toolAllowed = true;
    let toolEntered!: () => void;
    let releaseTool!: () => void;
    const toolPaused = new Promise<void>((resolve) => {
      toolEntered = resolve;
    });
    const toolReleased = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });
    toolBarrier = async () => {
      toolEntered();
      await toolReleased;
    };
    const abort = await session.submit(
      worker,
      "Cancel before local commit",
      "abort-native",
    );
    await toolPaused;
    const stopping = session.cancel(worker, abort.submissionId);
    expect(await stopping).toBe("aborted");
    releaseTool();
    await expect(
      session.procedureDraft(worker, {
        ...request("read", ""),
        operationId: "abort-before-commit",
      }),
    ).rejects.toMatchObject({ code: "unavailable" });
    await core.close();
    core = createCore(options);
    const reopened = await setupTest(context, core.registry);
    session = core.attach(reopened.client)(scope);
    expect(await read()).toMatchObject({
      state: "cancelled",
      body: edited.body,
    });
    expect(value(await session.procedureDraft(worker, create))).toMatchObject({
      state: "cancelled",
    });
  } finally {
    clock.mockRestore();
    await core.close();
    await telemetry.close();
    globalThis.fetch = originalFetch;
    if (oldToken === undefined) delete process.env.COMPUTAH_AXIOM_INGEST_TOKEN;
    else process.env.COMPUTAH_AXIOM_INGEST_TOKEN = oldToken;
    if (oldDataset === undefined) delete process.env.COMPUTAH_AXIOM_LOG_DATASET;
    else process.env.COMPUTAH_AXIOM_LOG_DATASET = oldDataset;
  }
  type Span = {
    name: string;
    spanId: string;
    traceId: string;
    parentSpanId?: string;
    attributes: { key: string; value: { stringValue?: string } }[];
  };
  const spans: Span[] = traces.flatMap((body) =>
    JSON.parse(body).resourceSpans.flatMap(
      (r: { scopeSpans: { spans: Span[] }[] }) =>
        r.scopeSpans.flatMap((s) => s.spans),
    ),
  );
  const draftSpans = spans.filter(
    (s) => s.name === "computah.procedures.draft",
  );
  expect(draftSpans.length).toBeGreaterThan(15);
  const native = draftSpans.filter(
    (s) =>
      spans.find((p) => p.spanId === s.parentSpanId)?.name ===
      "pi.durable.phase",
  );
  expect(native).toHaveLength(3);
  const host = draftSpans.filter((s) =>
    draftSpans.some((p) => p.spanId === s.parentSpanId),
  );
  expect(host.length).toBeGreaterThan(15);
  for (const span of [...native, ...host])
    expect(spans.find((p) => p.spanId === span.parentSpanId)?.traceId).toBe(
      span.traceId,
    );
  type Log = {
    spanId: string;
    traceId: string;
    attributes: Span["attributes"];
  };
  const records: Log[] = logs.flatMap((body) =>
    JSON.parse(body).resourceLogs.flatMap(
      (r: { scopeLogs: { logRecords: Log[] }[] }) =>
        r.scopeLogs.flatMap((s) => s.logRecords),
    ),
  );
  for (const span of [...native, ...host]) {
    const record = records.find((r) => r.spanId === span.spanId);
    expect(record?.traceId).toBe(span.traceId);
    expect(
      record?.attributes.find((a) => a.key === "operation")?.value.stringValue,
    ).toBe("procedures.draft");
    expect(
      record?.attributes.find((a) => a.key === "outcome")?.value.stringValue,
    ).toBe(span.attributes.find((a) => a.key === "outcome")?.value.stringValue);
  }
  expect(
    draftSpans.map(
      (s) => s.attributes.find((a) => a.key === "outcome")?.value.stringValue,
    ),
  ).toEqual(
    expect.arrayContaining(["success", "error", "denied", "cancelled"]),
  );
  for (const secret of [
    create.recipients,
    create.subject,
    create.body,
    "PRIVATE-DRAFT-EDITED",
    "PRIVATE-SOURCE",
    scope.tenantId,
    "private-account",
  ])
    expect([...traces, ...logs].join()).not.toContain(secret);
});
