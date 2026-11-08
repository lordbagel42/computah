import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
  withTelemetry,
} from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai";
import {
  createRegistry,
  Harness,
  MemoryStorage,
  type StorageWrite,
  type SubmissionId,
} from "@earendil-works/pi-durable";
import {
  InMemoryTelemetryContext,
  type TelemetryContext,
} from "@earendil-works/pi-telemetry";
import { expect, test, vi } from "vitest";

const background = BACKGROUND_CONTEXT;

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function runtime() {
  const faux = fauxProvider({ tokensPerSecond: 0 });
  const models = createModels();
  models.setProvider(faux.provider);
  return {
    faux,
    options: { registry: createRegistry(), models },
    agent: {
      model: { provider: faux.provider.id, modelId: faux.getModel().id },
    },
  };
}

test("installed admission honors explicit parents in both forms, preserves default roots, rollback and idempotent carriers, and fails open without usable propagation", async () => {
  const telemetry = new InMemoryTelemetryContext();
  const { faux, options, agent } = runtime();
  faux.setResponses(
    Array.from({ length: 8 }, () => fauxAssistantMessage("ok")),
  );
  const harness = await Harness.open(
    new MemoryStorage(),
    { ...options, telemetry },
    background,
  );
  try {
    const root = await harness.root(background, { agent });
    await telemetry.startSpan({ name: "caller" }, async (caller) => {
      const context = withTelemetry(caller, background);
      const carrier = telemetry.inject(caller);
      expect(carrier).toBeDefined();
      const direct = await root.submit(
        { type: "input", content: "direct", trace: carrier, requestId: "same" },
        background,
      );
      expect((await direct.wait(background)).status).toBe("done");
      const admission = telemetry
        .getSpans()
        .find((span) => span.attributes["submission.id"] === direct.id);
      expect(admission?.parentContext).toEqual(carrier);
      expect(admission?.links).toEqual([]);
      const original = await direct.status(background);
      expect(original.trace).toEqual(admission?.context);

      await telemetry.startSpan({ name: "different-caller" }, async (other) => {
        const duplicate = await root.submit(
          {
            type: "input",
            content: "direct",
            requestId: "same",
            trace: telemetry.inject(other),
          },
          withTelemetry(other, background),
        );
        expect(duplicate.id).toBe(direct.id);
        expect((await duplicate.status(background)).trace).toEqual(
          original.trace,
        );
      });

      const transactionalId = await root.commit(
        (tx) =>
          root.submit(tx, { type: "input", content: "tx", trace: carrier }),
        background,
      );
      const transactional = await harness.submission(
        transactionalId,
        background,
      );
      expect((await transactional?.wait(background))?.status).toBe("done");
      expect(
        telemetry
          .getSpans()
          .find((span) => span.attributes["submission.id"] === transactionalId)
          ?.parentContext,
      ).toEqual(carrier);

      let rolledBack: SubmissionId | undefined;
      await expect(
        root.commit(async (tx) => {
          rolledBack = await root.submit(tx, {
            type: "input",
            content: "must not execute",
            trace: carrier,
          });
          throw new Error("rollback after admission");
        }, context),
      ).rejects.toThrow("rollback after admission");
      expect(rolledBack).toBeDefined();
      if (rolledBack !== undefined)
        expect(
          await harness.submission(rolledBack, background),
        ).toBeUndefined();

      const implicit = await root.submit(
        { type: "input", content: "independent" },
        context,
      );
      expect((await implicit.wait(background)).status).toBe("done");
      const independent = telemetry
        .getSpans()
        .find((span) => span.attributes["submission.id"] === implicit.id);
      expect(independent?.parentContext).toBeNull();
      expect(independent?.links.map((link) => link.context)).toEqual([carrier]);

      const malformed = await root.submit(
        {
          type: "input",
          content: "unknown carrier",
          trace: { unknown: "value" },
        },
        context,
      );
      expect((await malformed.wait(background)).status).toBe("done");
      expect(
        telemetry
          .getSpans()
          .find((span) => span.attributes["submission.id"] === malformed.id)
          ?.parentContext,
      ).toBeNull();
    });
    expect(faux.state.callCount).toBe(4);
  } finally {
    await harness.close(background);
  }

  // Propagation is optional: recording still works, but explicit carriers cannot parent it.
  const recorder = new InMemoryTelemetryContext();
  const noPropagation: TelemetryContext = {
    startSpan: recorder.startSpan.bind(recorder),
  };
  const plain = await Harness.open(
    new MemoryStorage(),
    { ...options, telemetry: noPropagation },
    background,
  );
  try {
    const root = await plain.root(background, { agent });
    const submission = await root.submit(
      {
        type: "input",
        content: "optional adapter",
        trace: { unknown: "value" },
      },
      background,
    );
    expect((await submission.wait(background)).status).toBe("done");
    expect(
      recorder
        .getSpans()
        .find((span) => span.attributes["submission.id"] === submission.id)
        ?.parentContext,
    ).toBeNull();
  } finally {
    await plain.close(background);
  }
});

// Snapshot by replaying detached, successfully committed public StorageWrite batches.
// MemoryStorage exposes no snapshot constructor; this does not access private state.
class JournalStorage extends MemoryStorage {
  readonly batches: StorageWrite[][] = [];

  override async commit(...args: Parameters<MemoryStorage["commit"]>) {
    const batches = structuredClone(args[0]);
    const result = await super.commit(...args);
    this.batches.push(...batches.map((batch) => [...batch]));
    return result;
  }
}

test("queued follow-ups, cancelled waiters and recovered tasks retain their own persisted causal carrier", async () => {
  const telemetry = new InMemoryTelemetryContext();
  const { faux, options, agent } = runtime();
  const releaseA = latch();
  const enteredA = latch();
  faux.setResponses([
    async () => {
      enteredA.resolve();
      await releaseA.promise;
      return fauxAssistantMessage("A finished");
    },
    fauxAssistantMessage("B finished"),
  ]);
  const storage = new JournalStorage();
  const harness = await Harness.open(
    storage,
    { ...options, telemetry },
    background,
  );
  try {
    const root = await harness.root(background, { agent });
    const a = await telemetry.startSpan({ name: "caller-A" }, (span) =>
      root.submit(
        { type: "input", content: "A", trace: telemetry.inject(span) },
        withTelemetry(span, background),
      ),
    );
    await enteredA.promise;
    const b = await telemetry.startSpan({ name: "caller-B" }, (span) =>
      root.submit(
        {
          type: "input",
          content: "B",
          whenBusy: "followUp",
          trace: telemetry.inject(span),
        },
        withTelemetry(span, background),
      ),
    );
    expect((await b.status(background)).status).toBe("queued");
    const aTrace = (await a.status(background)).trace;
    const bTrace = (await b.status(background)).trace;
    expect(aTrace).toBeDefined();
    expect(bTrace).toBeDefined();
    expect(bTrace).not.toEqual(aTrace);

    const controller = new AbortController();
    const cancelledWait = expect(
      b.wait(withAbortSignal(controller.signal, background)),
    ).rejects.toBeDefined();
    controller.abort();
    await cancelledWait;
    expect((await b.status(background)).status).toBe("queued");
    const withdrawn = await root.submit(
      { type: "input", content: "withdraw", whenBusy: "followUp" },
      background,
    );
    expect(await withdrawn.abort(background)).toBe("aborted");
    expect(await withdrawn.wait(background)).toMatchObject({
      status: "unanswered",
      reason: "aborted",
    });

    releaseA.resolve();
    expect((await a.wait(background)).status).toBe("done");
    expect((await b.wait(background)).status).toBe("done");
    await root.waitForIdle(background);
    const tasks = await storage.scanTasks({}, 100, undefined, background);
    expect(tasks.items.map((task) => task.trace)).toEqual([aTrace, bTrace]);
    // Idle is a durable state; phase callbacks may still be unwinding telemetry.
    await vi.waitFor(() => {
      for (const carrier of [aTrace, bTrace]) {
        const phases = telemetry
          .getSpans()
          .filter(
            (span) =>
              span.name === "pi.durable.phase" &&
              JSON.stringify(span.parentContext) === JSON.stringify(carrier),
          );
        expect(phases.length).toBeGreaterThan(0);
        expect(phases.every((span) => span.settled)).toBe(true);
      }
    });
    expect(faux.state.callCount).toBe(2);

    // Capture an actual running task before shutdown; reopening this detached commit
    // history exercises recovery, not merely a second handle to the same live storage.
    const enteredRecovery = latch();
    faux.setResponses([
      async (_context, streamOptions) => {
        enteredRecovery.resolve();
        await new Promise<void>((resolve) => {
          if (streamOptions?.signal?.aborted) resolve();
          else
            streamOptions?.signal?.addEventListener("abort", () => resolve(), {
              once: true,
            });
        });
        return fauxAssistantMessage("shutdown");
      },
    ]);
    const recovering = await telemetry.startSpan(
      { name: "caller-recovery" },
      (span) =>
        root.submit(
          { type: "input", content: "recover", trace: telemetry.inject(span) },
          background,
        ),
    );
    await enteredRecovery.promise;
    const recoveryTrace = (await recovering.status(background)).trace;
    const snapshot = structuredClone(storage.batches);
    await harness.close(background);
    const restored = new MemoryStorage();
    await restored.commit(snapshot, () => {}, background);
    const freshTelemetry = new InMemoryTelemetryContext();
    faux.setResponses([fauxAssistantMessage("recovered")]);
    const reopened = await Harness.open(
      restored,
      { ...options, telemetry: freshTelemetry },
      background,
    );
    try {
      const submission = await reopened.submission(recovering.id, background);
      expect((await submission?.wait(background))?.status).toBe("done");
      await reopened.waitForIdle(background);
      expect((await submission?.status(background))?.trace).toEqual(
        recoveryTrace,
      );
      expect(
        freshTelemetry
          .getSpans()
          .some(
            (span) =>
              span.name === "pi.durable.phase" &&
              JSON.stringify(span.parentContext) ===
                JSON.stringify(recoveryTrace),
          ),
      ).toBe(true);
    } finally {
      await reopened.close(background);
    }
  } finally {
    releaseA.resolve();
    await harness.close(background);
  }
});
