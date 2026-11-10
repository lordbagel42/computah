import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReceiver, owner } from "./receiver.js";
import { createWorkflow } from "./workflow.js";

const id = "computah_bug_0123456789abcdefghijklmn";
const thread = "T-00000000-0000-0000-0000-000000000001";
const commit = "0123456789abcdef0123456789abcdef01234567";
const signal = () => new AbortController().signal;
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "computah-bug-workflow-"));
  roots.push(root);
  const children: { thread: string; messages: string[] }[] = [];
  let notificationCount = 0;
  let archived = false;
  let idle = true;
  let validMain = true;
  const effects = {
    async create() {
      children.push({ thread, messages: [] });
      return thread;
    },
    async start(target: string, prompt: string) {
      children.find((child) => child.thread === target)?.messages.push(prompt);
    },
  };
  const completion = {
    recurrence:
      "coordinator ledger: verified adoption, finite checkpoint schedule",
    async verify() {
      if (!validMain) throw new Error("foreign_or_unlinked_commit");
    },
    async notify() {
      notificationCount++;
    },
    async archived() {
      return archived;
    },
    async idle() {
      return idle;
    },
    async archive() {
      archived = true;
    },
  };
  return {
    root,
    effects,
    completion,
    children,
    notifications: () => notificationCount,
    setIdle: (value: boolean) => {
      idle = value;
    },
    setMain: (value: boolean) => {
      validMain = value;
    },
  };
}

test("duplicate notices/reload reuse one durable owner and preserve existing triage assignment", async () => {
  const f = await fixture();
  const workflow = await createWorkflow(f.root, f.effects);
  expect(
    await Promise.all([
      workflow.dispatch(id, signal()),
      workflow.dispatch(id, signal()),
    ]),
  ).toEqual([thread, thread]);
  const reloaded = await createWorkflow(f.root, f.effects);
  expect(await reloaded.dispatch(id, signal())).toBe(thread);
  expect(f.children).toHaveLength(1);
  expect(f.children[0]?.messages).toHaveLength(1);
  expect(f.children[0]?.messages[0]).toContain(id);
  expect(
    await reloaded.dispatch("computah_bug_81ffn2n910pi2cnhh4ztry2n", signal()),
  ).toBe("T-01a1c4f7-d2f6-778f-a972-a15d19f45617");
  expect(f.children).toHaveLength(1);
  expect((await stat(`${f.root}/${id}-v1.json`)).mode & 0o777).toBe(0o600);
});

test("ambiguous create or initial prompt never creates/re-prompts a competing owner", async () => {
  for (const boundary of ["create", "start"] as const) {
    const f = await fixture();
    const effects = {
      ...f.effects,
      [boundary]: async () => {
        throw new Error("remote_outcome_unknown");
      },
    };
    const workflow = await createWorkflow(f.root, effects);
    await expect(workflow.dispatch(id, signal())).rejects.toThrow(
      "remote_outcome_unknown",
    );
    const state = await workflow.inspect(id);
    expect(state?.phase).toBe(boundary === "create" ? "creating" : "starting");
    const retry = await createWorkflow(f.root, f.effects);
    await expect(retry.dispatch(id, signal())).rejects.toThrow(
      boundary === "create" ? "bug_creation_uncertain" : "bug_start_uncertain",
    );
    expect(f.children).toHaveLength(boundary === "create" ? 0 : 1);
  }
});

test("late creation result survives cancellation without starting work, then retry starts same owner", async () => {
  const f = await fixture();
  const controller = new AbortController();
  let release!: (thread: string) => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const workflow = await createWorkflow(f.root, {
    ...f.effects,
    create: () =>
      new Promise<string>((resolve) => {
        release = resolve;
        entered();
      }),
  });
  const dispatch = workflow.dispatch(id, controller.signal);
  await started;
  controller.abort();
  release(thread);
  await expect(dispatch).rejects.toThrow();
  expect(await workflow.inspect(id)).toMatchObject({
    phase: "created",
    thread,
  });
  let prompts = 0;
  const reloaded = await createWorkflow(f.root, {
    ...f.effects,
    async start() {
      prompts++;
    },
  });
  expect(await reloaded.dispatch(id, signal())).toBe(thread);
  expect(prompts).toBe(1);
  expect(f.children).toHaveLength(0);
});

test("cancellation at the durable start boundary does not append the assignment", async () => {
  const f = await fixture();
  const workflow = await createWorkflow(f.root, f.effects);
  const controller = new AbortController();
  const check = controller.signal.throwIfAborted.bind(controller.signal);
  const assignment = `${f.root}/${id}-v1.json`;
  controller.signal.throwIfAborted = () => {
    if (
      existsSync(assignment) &&
      JSON.parse(readFileSync(assignment, "utf8")).phase === "starting"
    )
      controller.abort();
    check();
  };
  await expect(workflow.dispatch(id, controller.signal)).rejects.toThrow();
  expect(f.children).toHaveLength(1);
  expect(f.children[0]?.messages).toHaveLength(0);
  expect(await workflow.inspect(id)).toMatchObject({
    thread,
    phase: "starting",
  });
  await expect(workflow.dispatch(id, signal())).rejects.toThrow(
    "bug_start_uncertain",
  );
});

test("verified landing deduplicates Space notice; unresolved or running work is never archived", async () => {
  const f = await fixture();
  const workflow = await createWorkflow(f.root, f.effects);
  await workflow.dispatch(id, signal());
  f.setMain(false);
  await expect(
    workflow.landed(id, commit, "fix", f.completion),
  ).rejects.toThrow("foreign_or_unlinked_commit");
  expect(f.notifications()).toBe(0);
  f.setMain(true);
  await workflow.landed(
    id,
    commit,
    "user-visible fix; runtime pending",
    f.completion,
  );
  await workflow.landed(id, commit, "retry", f.completion);
  expect(f.notifications()).toBe(1);
  await expect(
    workflow.resolve(
      id,
      commit,
      "accepted",
      ["human acceptance"],
      f.completion,
    ),
  ).rejects.toThrow("bug_acceptance_incomplete");
  await expect(
    workflow.resolve(id, commit, "", [], f.completion),
  ).rejects.toThrow("bug_acceptance_incomplete");
  await expect(
    workflow.resolve(id, commit, "accepted", [], {
      ...f.completion,
      recurrence: "",
    }),
  ).rejects.toThrow("bug_acceptance_incomplete");
  expect(await f.completion.archived()).toBe(false);
  f.setIdle(false);
  const pending = await workflow.resolve(
    id,
    commit,
    "authenticated acceptance evidence",
    [],
    f.completion,
  );
  expect(pending.phase).toBe("resolved");
  expect(await f.completion.archived()).toBe(false);
  const reloaded = await createWorkflow(f.root, f.effects);
  expect(
    (await reloaded.unresolvedCleanup()).map((record) => record.id),
  ).toEqual([id]);
  f.setIdle(true);
  expect(
    (
      await reloaded.resolve(
        id,
        commit,
        "authenticated acceptance evidence",
        [],
        f.completion,
      )
    ).phase,
  ).toBe("archived");
  expect(await f.completion.archived()).toBe(true);
  expect(await reloaded.dispatch(id, signal())).toBe(thread);
  expect(f.children).toHaveLength(1);
});

test("ambiguous archive reconciles actual metadata; notification ambiguity remains explicit", async () => {
  const f = await fixture();
  const workflow = await createWorkflow(f.root, f.effects);
  await workflow.dispatch(id, signal());
  await workflow.landed(id, commit, "fix", f.completion);
  await expect(
    workflow.resolve(id, commit, "accepted", [], {
      ...f.completion,
      async archive() {
        await f.completion.archive();
        throw new Error("lost_archive_response");
      },
    }),
  ).rejects.toThrow("lost_archive_response");
  const reloaded = await createWorkflow(f.root, f.effects);
  expect(
    (await reloaded.resolve(id, commit, "accepted", [], f.completion)).phase,
  ).toBe("archived");
  const other = "computah_bug_abcdefghijklmn0123456789";
  await workflow.dispatch(other, signal());
  await expect(
    workflow.landed(other, commit, "fix", {
      ...f.completion,
      async notify() {
        throw new Error("lost_send_response");
      },
    }),
  ).rejects.toThrow("lost_send_response");
  await expect(
    reloaded.landed(other, commit, "retry", f.completion),
  ).rejects.toThrow("bug_landing_notification_uncertain");
  const secondCommit = "abcdef0123456789abcdef0123456789abcdef01";
  await reloaded.landed(other, secondCommit, "second fix", f.completion);
  await expect(
    reloaded.resolve(other, secondCommit, "accepted", [], f.completion),
  ).rejects.toThrow("bug_landing_notification_uncertain");
  expect((await reloaded.inspect(other))?.phase).toBe("active");
});

test("corrupt persisted state fails closed instead of recreating a worker", async () => {
  const f = await fixture();
  const workflow = await createWorkflow(f.root, f.effects);
  await workflow.dispatch(id, signal());
  const file = `${f.root}/${id}-v1.json`;
  const value = JSON.parse(await readFile(file, "utf8"));
  await writeFile(file, JSON.stringify({ ...value, id: "other-report" }));
  await expect(workflow.dispatch(id, signal())).rejects.toThrow(
    "bug_state_invalid",
  );
  expect(f.children).toHaveLength(1);
});

test("authenticated notice to durable child to coordinator append to ACK survives delivery retry", async () => {
  const f = await fixture();
  const workflow = await createWorkflow(f.root, f.effects);
  let acknowledged = "";
  const messages: {
    role: string;
    content: { type: string; text: string }[];
  }[] = [];
  const intents = new Set<string>();
  const tracker = {
    token: async () => "isolated-notice-token",
    fetch: (async (_url, init) => {
      if (init?.method === "POST") {
        expect((await workflow.inspect(id))?.thread).toBe(thread);
        expect(messages).toHaveLength(1);
        acknowledged = "2026-11-10T00:00:00Z";
      }
      return Response.json({ issue: id, version: 1, acknowledged });
    }) as typeof fetch,
    assigned: async () => Boolean((await workflow.inspect(id))?.thread),
    dispatch: workflow.dispatch,
    begin: async (value: string) => {
      const first = !intents.has(value);
      intents.add(value);
      return first;
    },
    clear: async (value: string) => {
      intents.delete(value);
    },
  };
  const context = {
    signal: signal(),
    logger: { log() {} },
    thread: {
      id: owner,
      async messages() {
        return messages;
      },
      async appendUserMessage(message: { content: string }) {
        expect((await workflow.inspect(id))?.phase).toBe("active");
        messages.push({
          role: "user",
          content: [{ type: "text", text: message.content }],
        });
      },
    },
  };
  const event = {
    body: new TextEncoder().encode(JSON.stringify({ id, version: 1 })),
  };
  await createReceiver(tracker).handle(event, context);
  await createReceiver(tracker).handle(event, context);
  expect(acknowledged).not.toBe("");
  expect(f.children).toHaveLength(1);
  expect(messages).toHaveLength(1);
  expect(await workflow.inspect(id)).toMatchObject({
    id,
    thread,
    phase: "active",
  });
});
