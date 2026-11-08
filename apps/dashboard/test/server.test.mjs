import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { createDashboardServer, readDashboardConfig } from "../src/server.mjs";

const password = "synthetic-operator-password-not-real-123";
const coreToken = "synthetic-server-only-core-token-456789";

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

test("operator session gates only fixed read routes, hides credentials and clears on logout", async (t) => {
  const seen = [];
  const core = createServer((req, res) => {
    seen.push({
      method: req.method,
      url: req.url,
      auth: req.headers.authorization,
    });
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ version: 1, evidence: "synthetic-projection" }));
  });
  const coreUrl = await listen(core);
  const config = {
    origin: "",
    core: coreUrl,
    password,
    coreToken,
    secure: false,
    port: 0,
  };
  const dashboard = createDashboardServer(config);
  const origin = await listen(dashboard);
  config.origin = origin;
  t.after(() => {
    dashboard.closeAllConnections();
    dashboard.close();
    core.closeAllConnections();
    core.close();
  });
  const read = (path, cookie) =>
    fetch(`${origin}${path}`, { headers: cookie ? { Cookie: cookie } : {} });
  const post = (path, value, cookie, from = origin) =>
    fetch(`${origin}${path}`, {
      method: "POST",
      headers: {
        Origin: from,
        "Content-Type": "application/json",
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: JSON.stringify(value),
    });
  assert.equal((await read("/api/snapshot")).status, 401);
  assert.equal(seen.length, 0);
  assert.equal(
    (await post("/session", { password }, undefined, "https://other.invalid"))
      .status,
    403,
  );
  assert.equal((await post("/session", { password: "wrong" })).status, 401);
  const login = await post("/session", { password });
  assert.equal(login.status, 200);
  const setCookie = login.headers.get("set-cookie");
  assert.match(setCookie, /HttpOnly; SameSite=Strict; Max-Age=28800/);
  assert.ok(!setCookie.includes(password) && !setCookie.includes(coreToken));
  const cookie = setCookie.split(";")[0];
  const snapshot = await read("/api/snapshot?cursor=opaque%2Bvalue", cookie);
  assert.equal(snapshot.status, 200);
  assert.deepEqual(await snapshot.json(), {
    version: 1,
    evidence: "synthetic-projection",
  });
  assert.deepEqual(seen, [
    {
      method: "GET",
      url: "/v1/operator/snapshot?cursor=opaque%2Bvalue",
      auth: `Bearer ${coreToken}`,
    },
  ]);
  assert.equal((await read("/api/history?cursor=signed", cookie)).status, 200);
  assert.equal(seen[1].url, "/v1/operator/history?cursor=signed");
  for (const path of [
    "/api/snapshot?url=http://other.invalid",
    "/api/snapshot?cursor=a&cursor=b",
    `/api/snapshot?cursor=${"a".repeat(4097)}`,
  ])
    assert.equal((await read(path, cookie)).status, 400);
  assert.equal((await post("/api/snapshot", {}, cookie)).status, 404);
  assert.equal((await read("/v1/submissions", cookie)).status, 404);
  assert.equal((await read("/src/server.mjs", cookie)).status, 404);
  const script = await read("/app.js");
  const text = await script.text();
  assert.ok(!text.includes(coreToken) && !text.includes(password));
  assert.match(
    script.headers.get("content-security-policy"),
    /frame-ancestors 'none'/,
  );
  assert.equal(script.headers.get("cache-control"), "no-store");
  assert.equal((await post("/logout", {}, cookie)).status, 200);
  assert.equal((await read("/api/snapshot", cookie)).status, 401);
  assert.equal(seen.length, 2);
});

test("production requires TLS and issues secure host-only cookie; no raw upstream errors escape", async (t) => {
  assert.throws(() =>
    readDashboardConfig({
      COMPUTAH_DASHBOARD_ORIGIN: "https://operator.example.invalid",
      COMPUTAH_DASHBOARD_CORE_URL: "http://remote-core.example.invalid",
      COMPUTAH_DASHBOARD_PASSWORD: password,
      COMPUTAH_DASHBOARD_CORE_TOKEN: coreToken,
    }),
  );
  assert.throws(() =>
    readDashboardConfig({
      COMPUTAH_DASHBOARD_ORIGIN: "http://100.104.199.211:8790",
      COMPUTAH_DASHBOARD_CORE_URL: "http://127.0.0.1:8787",
      COMPUTAH_DASHBOARD_PASSWORD: password,
      COMPUTAH_DASHBOARD_CORE_TOKEN: coreToken,
    }),
  );
  const config = readDashboardConfig({
    COMPUTAH_DASHBOARD_ORIGIN: "https://operator.example.invalid",
    COMPUTAH_DASHBOARD_CORE_URL: "http://127.0.0.1:1",
    COMPUTAH_DASHBOARD_PASSWORD: password,
    COMPUTAH_DASHBOARD_CORE_TOKEN: coreToken,
  });
  const dashboard = createDashboardServer(config);
  const local = await listen(dashboard);
  t.after(() => {
    dashboard.closeAllConnections();
    dashboard.close();
  });
  assert.equal((await fetch(local)).status, 403);
  // Simulate a TLS terminator preserving the public Host on its HTTP upstream.
  config.origin = `https://${new URL(local).host}`;
  const login = await fetch(`${local}/session`, {
    method: "POST",
    headers: {
      Origin: config.origin,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ password }),
  });
  assert.equal(login.status, 200);
  assert.match(
    login.headers.get("set-cookie"),
    /^__Host-computah_operator=.*; Secure$/,
  );
  const response = await fetch(`${local}/api/snapshot`, {
    headers: {
      Cookie: login.headers.get("set-cookie").split(";")[0],
    },
  });
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: "dashboard-unavailable" });
});
