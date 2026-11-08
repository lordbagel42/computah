import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startObservability } from "@computah/observability";
import { expect, test } from "vitest";
import { createAxiomMcp } from "../src/axiom-mcp.js";

const scope = { tenantId: "synthetic", userId: "operator", agentId: "default" };
const signal = () => new AbortController().signal;
const initial = {
  serverUrl: "https://mcp.axiom.co/mcp",
  clientInformation: { client_id: "synthetic-public-client" },
  tokens: {
    access_token: "expired-canary",
    refresh_token: "refresh-canary",
    token_type: "Bearer",
  },
};
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "computah-oauth-"));
  const path = join(dir, "state.json");
  await writeFile(path, JSON.stringify(initial), { mode: 0o600 });
  return { path, close: () => rm(dir, { recursive: true, force: true }) };
}
function upstream(refresh: typeof fetch, echo = false): typeof fetch {
  return async (input, init) => {
    if (String(input) === "https://authorization.axiom.co/oauth2/token")
      return refresh(input, init);
    expect(String(input)).toBe(initial.serverUrl);
    const token = new Headers(init?.headers).get("authorization");
    if (token === "Bearer expired-canary")
      return new Response(null, { status: 401 });
    expect(token).toBe("Bearer rotated-canary");
    const message = JSON.parse(String(init?.body));
    if (!message.id) return new Response(null, { status: 202 });
    const result =
      message.method === "initialize"
        ? {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "synthetic", version: "1" },
          }
        : message.method === "tools/list"
          ? {
              tools: [
                { name: "queryDataset", inputSchema: { type: "object" } },
              ],
            }
          : {
              content: [
                {
                  type: "text",
                  text: echo
                    ? "rotated-refresh-canary"
                    : "bounded-query-evidence",
                },
              ],
            };
    return Response.json({ jsonrpc: "2.0", id: message.id, result });
  };
}

test("OAuth refresh is single-flight, persists rotation and survives reopen without PAT fallback", async () => {
  const f = await fixture();
  try {
    let refreshes = 0;
    const fetch = upstream(async (_input, init) => {
      refreshes++;
      expect(new URLSearchParams(String(init?.body)).get("refresh_token")).toBe(
        "refresh-canary",
      );
      expect(init?.redirect).toBe("error");
      await new Promise((resolve) => setTimeout(resolve, 10));
      return Response.json({
        access_token: "rotated-canary",
        refresh_token: "rotated-refresh-canary",
        token_type: "Bearer",
        expires_in: 60,
      });
    });
    const options = {
      oauthFile: f.path,
      pat: "must-not-be-used",
      authorize: () => true,
      fetch,
    };
    const client = createAxiomMcp(options);
    const results = await Promise.all([
      client.run(scope, signal()),
      client.run(scope, signal()),
    ]);
    expect(results.every((result) => result.status === "ready")).toBe(true);
    expect(refreshes).toBe(1);
    const saved = JSON.parse(await readFile(f.path, "utf8"));
    expect(saved.tokens.refresh_token).toBe("rotated-refresh-canary");
    expect(saved.tokensExpireAt).toBeGreaterThan(Date.now());
    expect((await stat(f.path)).mode & 0o777).toBe(0o600);
    expect(
      await createAxiomMcp(options).run(scope, signal(), {
        name: "queryDataset",
        argumentsJson: "{}",
      }),
    ).toMatchObject({
      status: "ready",
      result: { content: [{ text: "bounded-query-evidence" }] },
    });
    expect(refreshes).toBe(1);
    expect(
      await createAxiomMcp({ ...options, fetch: upstream(fetch, true) }).run(
        scope,
        signal(),
        { name: "queryDataset", argumentsJson: "{}" },
      ),
    ).toMatchObject({ code: "invalid_response" });
  } finally {
    await f.close();
  }
});

test("expired OAuth grants refresh before dispatch even when MCP does not issue HTTP challenges", async () => {
  const f = await fixture();
  try {
    await writeFile(
      f.path,
      JSON.stringify({ ...initial, tokensExpireAt: Date.now() - 1 }),
    );
    let refreshes = 0;
    const accepted = upstream(async () => {
      refreshes++;
      return Response.json({
        access_token: "rotated-canary",
        token_type: "Bearer",
        expires_in: 300,
      });
    });
    const client = createAxiomMcp({
      oauthFile: f.path,
      authorize: () => true,
      fetch: async (input, init) => {
        if (String(input) === initial.serverUrl)
          expect(new Headers(init?.headers).get("authorization")).toBe(
            "Bearer rotated-canary",
          );
        return accepted(input, init);
      },
    });
    expect(
      await client.run(scope, signal(), {
        name: "queryDataset",
        argumentsJson: "{}",
      }),
    ).toMatchObject({ status: "ready" });
    expect(refreshes).toBe(1);
    expect(
      JSON.parse(await readFile(f.path, "utf8")).tokensExpireAt,
    ).toBeGreaterThan(Date.now());
  } finally {
    await f.close();
  }
});

test("rotated OAuth state recovers a failed save without refreshing again", async () => {
  const f = await fixture();
  try {
    let refreshes = 0;
    const client = createAxiomMcp({
      oauthFile: f.path,
      authorize: () => true,
      fetch: upstream(async () => {
        refreshes++;
        await rm(f.path);
        await mkdir(f.path);
        return Response.json({
          access_token: "rotated-canary",
          refresh_token: "rotated-refresh-canary",
          token_type: "Bearer",
        });
      }),
    });
    expect(await client.run(scope, signal())).toMatchObject({
      code: "authorization_required",
    });
    await rm(f.path, { recursive: true });
    expect(await client.run(scope, signal())).toMatchObject({
      status: "ready",
    });
    expect(
      JSON.parse(await readFile(f.path, "utf8")).tokens.refresh_token,
    ).toBe("rotated-refresh-canary");
    expect(refreshes).toBe(1);
  } finally {
    await f.close();
  }
});

test("a cancelled OAuth waiter settles while the initiating refresh remains active", async () => {
  const f = await fixture();
  try {
    let release = () => {};
    let started = () => {};
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = createAxiomMcp({
      oauthFile: f.path,
      authorize: () => true,
      fetch: upstream(async () => {
        started();
        await held;
        return Response.json({
          access_token: "rotated-canary",
          token_type: "Bearer",
        });
      }),
    });
    const first = client.run(scope, signal());
    await entered;
    const abort = new AbortController();
    const waiter = client.run(scope, abort.signal);
    await new Promise((resolve) => setTimeout(resolve, 5));
    abort.abort();
    try {
      expect(
        await Promise.race([
          waiter,
          new Promise((resolve) =>
            setTimeout(() => resolve("still waiting"), 100),
          ),
        ]),
      ).toMatchObject({ code: "cancelled" });
    } finally {
      release();
    }
    expect(await first).toMatchObject({ status: "ready" });
  } finally {
    await f.close();
  }
});

test("OAuth missing, unsafe and mismatched state are unavailable; denied operators make no auth requests", async () => {
  const f = await fixture();
  try {
    const fetch: typeof globalThis.fetch = async () => {
      throw new Error("must not dispatch");
    };
    expect(
      await createAxiomMcp({
        oauthFile: f.path,
        authorize: () => false,
        fetch,
      }).run(scope, signal()),
    ).toMatchObject({ code: "denied" });
    for (const state of [
      { ...initial, serverUrl: "https://other.invalid" },
      { ...initial, tokens: { access_token: "malformed" } },
      {
        ...initial,
        clientInformation: {
          client_id: "confidential",
          client_secret: "must-not-use",
        },
      },
    ]) {
      await writeFile(f.path, JSON.stringify(state));
      expect(
        await createAxiomMcp({
          oauthFile: f.path,
          authorize: () => true,
          fetch,
        }).run(scope, signal()),
      ).toMatchObject({ code: "authorization_required" });
    }
    await writeFile(f.path, JSON.stringify(initial));
    await chmod(f.path, 0o644);
    expect(
      await createAxiomMcp({
        oauthFile: f.path,
        authorize: () => true,
        fetch,
      }).run(scope, signal()),
    ).toMatchObject({ code: "authorization_required" });
    await chmod(f.path, 0o600);
    await writeFile(f.path, "x".repeat(65_537));
    expect(
      await createAxiomMcp({
        oauthFile: f.path,
        authorize: () => true,
        fetch,
      }).run(scope, signal()),
    ).toMatchObject({ code: "authorization_required" });
    await rm(f.path);
    const target = `${f.path}.target`;
    await writeFile(target, JSON.stringify(initial), { mode: 0o600 });
    await symlink(target, f.path);
    expect(
      await createAxiomMcp({
        oauthFile: f.path,
        authorize: () => true,
        fetch,
      }).run(scope, signal()),
    ).toMatchObject({ code: "authorization_required" });
    await rm(f.path);
    expect(
      await createAxiomMcp({
        oauthFile: f.path,
        authorize: () => true,
        fetch,
      }).run(scope, signal()),
    ).toMatchObject({ code: "authorization_required" });
  } finally {
    await f.close();
  }
});

test("OAuth refresh failure and cancellation export sanitized child spans without credentials", async () => {
  const f = await fixture();
  const originalFetch = globalThis.fetch;
  const exported: string[] = [];
  globalThis.fetch = async (_input, init) => {
    exported.push(String(init?.body));
    return Response.json({});
  };
  process.env.COMPUTAH_AXIOM_INGEST_TOKEN = "synthetic-only";
  const telemetry = await startObservability("backend");
  try {
    const failed = createAxiomMcp({
      oauthFile: f.path,
      authorize: () => true,
      fetch: upstream(
        async () => new Response("refresh-canary", { status: 401 }),
      ),
    });
    expect(await failed.run(scope, signal())).toMatchObject({
      code: "authorization_required",
    });
    const abort = new AbortController();
    const cancelled = createAxiomMcp({
      oauthFile: f.path,
      authorize: () => true,
      fetch: upstream(
        async (_input, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(init.signal?.reason),
              { once: true },
            );
            abort.abort();
          }),
      ),
    });
    expect(await cancelled.run(scope, abort.signal)).toMatchObject({
      code: "cancelled",
    });
    const ready = createAxiomMcp({
      oauthFile: f.path,
      authorize: () => true,
      fetch: upstream(async () =>
        Response.json({ access_token: "rotated-canary", token_type: "Bearer" }),
      ),
    });
    expect(await ready.run(scope, signal())).toMatchObject({ status: "ready" });
    expect(
      JSON.parse(await readFile(f.path, "utf8")).tokens.refresh_token,
    ).toBe("refresh-canary");
  } finally {
    await telemetry.close();
    globalThis.fetch = originalFetch;
    delete process.env.COMPUTAH_AXIOM_INGEST_TOKEN;
    await f.close();
  }
  const text = exported.join("");
  expect(text).not.toContain("refresh-canary");
  expect(text).not.toContain("expired-canary");
  expect(text).not.toContain("rotated-canary");
  expect(text).not.toContain("rotated-refresh-canary");
  const spans: {
    name: string;
    spanId: string;
    parentSpanId: string;
    attributes: { key: string; value: { stringValue: string } }[];
  }[] = exported.flatMap((body) =>
    JSON.parse(body).resourceSpans.flatMap(
      (r: {
        scopeSpans: {
          spans: {
            name: string;
            spanId: string;
            parentSpanId: string;
            attributes: { key: string; value: { stringValue: string } }[];
          }[];
        }[];
      }) => r.scopeSpans.flatMap((s) => s.spans),
    ),
  );
  const refreshes = spans.filter((s) => s.name === "computah.axiom.refresh");
  expect(refreshes).toHaveLength(3);
  for (const span of refreshes)
    expect(
      spans.some(
        (parent) =>
          parent.spanId === span.parentSpanId &&
          parent.name === "computah.axiom.discover",
      ),
    ).toBe(true);
  expect(
    refreshes.map(
      (s) => s.attributes.find((a) => a.key === "outcome")?.value.stringValue,
    ),
  ).toEqual(["error", "cancelled", "ready"]);
});
