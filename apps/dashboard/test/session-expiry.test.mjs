import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createDashboardServer } from "../src/server.mjs";

test("operator sessions expire and login throttling recovers after its bounded window", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  const config = {
    origin: "",
    core: "http://127.0.0.1:1",
    password: "synthetic-operator-secret-for-expiry-1234",
    coreToken: "synthetic-core-token-never-for-browser-1234",
    secure: false,
    port: 0,
  };
  const server = createDashboardServer(config);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  config.origin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const login = (password) =>
    fetch(`${config.origin}/session`, {
      method: "POST",
      headers: { Origin: config.origin, "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
  const accepted = await login(config.password);
  assert.equal(accepted.status, 200);
  const cookie = accepted.headers.get("set-cookie").split(";")[0];
  t.mock.timers.tick(8 * 60 * 60_000);
  const expired = await fetch(`${config.origin}/api/snapshot`, {
    headers: { Cookie: cookie },
  });
  assert.equal(expired.status, 401);
  for (let attempt = 0; attempt < 10; attempt++)
    assert.equal((await login("wrong")).status, 401);
  const throttled = await login(config.password);
  assert.equal(throttled.status, 429);
  assert.equal(throttled.headers.get("set-cookie"), null);
  t.mock.timers.tick(15 * 60_000);
  assert.equal((await login(config.password)).status, 200);
});
