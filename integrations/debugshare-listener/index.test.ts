import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginAPI } from "@ampcode/plugin";
import { owner } from "./receiver.js";

test("cleanup recovery failure preserves receiver/tool registration and cancelled cleanup cannot act", async () => {
  const root = await mkdtemp(join(tmpdir(), "computah-listener-plugin-"));
  const previousOwner = process.env.AMP_THREAD_ID;
  process.env.AMP_THREAD_ID = owner;
  try {
    // Isolate all plugin persistence, including its capability file. Exercise the
    // real entry point without registering a live webhook or touching its store.
    const moduleRoot = join(root, "integrations/debugshare-listener");
    await cp(new URL(".", import.meta.url), moduleRoot, { recursive: true });
    await mkdir(join(root, "packages/contracts/src"), { recursive: true });
    await cp(
      new URL("../../packages/contracts/src/debugshare.ts", import.meta.url),
      join(root, "packages/contracts/src/debugshare.ts"),
    );
    const id = "computah_bug_0123456789abcdefghijklmn";
    const state = {
      id,
      version: 1,
      phase: "resolved",
      thread: "T-00000000-0000-0000-0000-000000000001",
    };
    const assignments = join(root, ".amp/debugshare-listener/assignments");
    await mkdir(assignments, { recursive: true });
    const file = join(assignments, `${id}-v1.json`);
    await writeFile(file, JSON.stringify(state));
    type Tool = Parameters<PluginAPI["registerTool"]>[0];
    const tools = new Map<string, Tool>();
    let webhooks = 0;
    let effects = 0;
    let onState: ((state: string) => void) | undefined;
    const wakes: string[] = [];
    const { default: install } = await import(join(moduleRoot, "index.ts"));
    await install({
      threads: {
        get: (target: string) =>
          target === owner
            ? {
                async appendUserMessage(message: { content: string }) {
                  wakes.push(message.content);
                },
              }
            : {
                state: {
                  subscribe(callback: (state: string) => void) {
                    onState = callback;
                    return { unsubscribe() {} };
                  },
                  async get() {
                    throw new Error("temporary_state_read_failure");
                  },
                },
              },
      },
      async createWebhook() {
        webhooks++;
        return { url: "https://fixture.invalid/webhook" };
      },
      registerTool(tool: Tool) {
        tools.set(tool.name, tool);
      },
    });
    expect(webhooks).toBe(1);
    expect(tools.has("computah_debugshare_listener_status")).toBe(true);
    const tool = tools.get("computah_bug_workflow");
    expect(tool).toBeDefined();
    const controller = new AbortController();
    controller.abort();
    await expect(
      tool?.execute(
        {
          action: "resolve",
          id,
          commit: "0123456789abcdef0123456789abcdef01234567",
          evidence: "accepted",
          recurrence:
            "verified adoption and finite coordinator schedule receipt",
          pending: [],
        },
        {
          thread: { id: owner },
          signal: controller.signal,
          logger: { log() {} },
          tools: {
            async call() {
              effects++;
              throw new Error("unexpected_remote_effect");
            },
          },
        } as unknown as Parameters<Tool["execute"]>[1],
      ),
    ).rejects.toThrow();
    expect(effects).toBe(0);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(state);
    expect(wakes).toHaveLength(0);
    onState?.("idle");
    await Promise.resolve();
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toContain(`[computah-cleanup:${id}:v1]`);
    onState?.("idle");
    await Promise.resolve();
    expect(wakes).toHaveLength(1);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(state);
  } finally {
    if (previousOwner === undefined) delete process.env.AMP_THREAD_ID;
    else process.env.AMP_THREAD_ID = previousOwner;
    await rm(root, { recursive: true, force: true });
  }
});
