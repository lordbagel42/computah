import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "vitest";

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test.each(["SIGTERM", "SIGINT", "startup_stop", "engine_loss"] as const)(
  "backend lifecycle preserves normal stop and exits failed after %s",
  async (mode) => {
    const home = await mkdtemp(join(tmpdir(), "computah-main-"));
    const port = await freePort();
    const enginePort = await freePort();
    let output = "";
    const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
      cwd: new URL("..", import.meta.url),
      env: {
        PATH: process.env.PATH,
        HOME: home,
        PORT: String(port),
        RIVET_RUN_ENGINE_PORT: String(enginePort),
        RIVET_RUN_SERVICES: "0",
        COMPUTAH_MODE: "faux",
        COMPUTAH_CONNECTION_SECRET:
          "synthetic-main-secret-over-thirty-two-bytes",
        COMPUTAH_AUTH_JSON: JSON.stringify([
          {
            tenantId: "test",
            userId: "test",
            agentId: "default",
            token: "synthetic-main-token-over-thirty-two-bytes",
            capabilities: ["task.send", "history.read"],
          },
        ]),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (data) => (output += data));
    child.stderr.on("data", (data) => (output += data));
    const exited = once(child, "exit");
    try {
      const url = `http://127.0.0.1:${port}/healthz`;
      if (mode === "startup_stop") {
        await expect
          .poll(() => output, { timeout: 15_000 })
          .toContain("computah.lifecycle phase=registry outcome=started");
        child.kill("SIGTERM");
      } else {
        await expect
          .poll(
            async () => {
              try {
                return (await fetch(url)).status;
              } catch {
                if (child.exitCode !== null) throw new Error(output);
                return 0;
              }
            },
            { timeout: 60_000, interval: 100 },
          )
          .toBe(200);
        expect(await (await fetch(url)).json()).toMatchObject({ ready: true });
        if (mode === "engine_loss") {
          // Select only this isolated backend's actual native engine child.
          const rows = execFileSync("ps", ["-eo", "pid=,ppid=,args="], {
            encoding: "utf8",
          }).split("\n");
          const engines = rows.filter((row) => {
            const [, parent, ...args] = row.trim().split(/\s+/);
            return (
              Number(parent) === child.pid &&
              args.join(" ").includes("/rivet-engine --config ")
            );
          });
          expect(engines).toHaveLength(1);
          process.kill(Number(engines[0]?.trim().split(/\s+/)[0]), "SIGTERM");
          await expect
            .poll(
              async () => {
                try {
                  return (await fetch(url)).status;
                } catch {
                  return 503;
                }
              },
              { timeout: 5000, interval: 50 },
            )
            .toBe(503);
        } else child.kill(mode);
      }
      const timeout = new AbortController();
      const result = await Promise.race([
        exited,
        delay(50_000, null, { signal: timeout.signal }),
      ]);
      timeout.abort();
      expect(result, output).not.toBeNull();
      expect(result?.[0], output).toBe(mode === "engine_loss" ? 1 : 0);
      expect(result?.[1]).toBeNull();
      expect(output).toContain("computah.lifecycle phase=registry_drain");
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await exited;
      }
      await rm(home, { recursive: true, force: true });
    }
  },
  120_000,
);
