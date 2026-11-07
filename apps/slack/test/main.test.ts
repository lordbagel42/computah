import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Exercise the executable boundary without Slack credentials or network calls.
const preload = `
import { registerHooks } from 'node:module';
const modules = {
  '@slack/socket-mode': \`import {EventEmitter} from 'node:events';
    export class SocketModeClient extends EventEmitter {
      start(){setInterval(()=>console.log('synthetic.late_connection'),10000);
        console.log('synthetic.socket.starting');return new Promise(()=>{});}
      async disconnect(){console.log('synthetic.socket.disconnected');}
    }\`,
  '@slack/web-api': \`export const LogLevel={ERROR:'error'};
    export class WebClient {auth={test:async()=>JSON.parse(process.env.TEST_AUTH)};}\`,
};
registerHooks({resolve(specifier,context,next){
  if(modules[specifier])return {url:'data:text/javascript,'+encodeURIComponent(modules[specifier]),shortCircuit:true};
  return next(specifier,context);
}});
globalThis.fetch=async()=>new Response(JSON.stringify({viewer:{tenantId:'synthetic',userId:'owner',agentId:'computah',capabilities:['task.send','history.read']}}));
`;

async function run(
  auth: Record<string, unknown>,
  enterpriseId?: string,
  signal?: "SIGTERM" | "SIGINT",
) {
  const dir = await mkdtemp(join(tmpdir(), "computah-slack-startup-"));
  try {
    await writeFile(join(dir, "preload.mjs"), preload);
    await writeFile(
      join(dir, "bindings.json"),
      JSON.stringify([
        {
          teamId: "TTEST",
          enterpriseId,
          slackUserId: "UOWNER",
          tenantId: "synthetic",
          userId: "owner",
          agentId: "computah",
          coreToken: "synthetic-token-not-a-real-credential",
          channelIds: [],
        },
      ]),
      { mode: 0o600 },
    );
    const child = spawn(
      process.execPath,
      ["--import", join(dir, "preload.mjs"), "--import", "tsx", "src/main.ts"],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: {
          ...process.env,
          TEST_AUTH: JSON.stringify(auth),
          SLACK_APP_TOKEN: "synthetic",
          SLACK_BOT_TOKEN: "synthetic",
          COMPUTAH_CORE_URL: "http://127.0.0.1:1",
          COMPUTAH_SLACK_DB: join(dir, "inbox.sqlite"),
          COMPUTAH_SLACK_BINDINGS_FILE: join(dir, "bindings.json"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    let sent = false;
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once("exit", resolve);
      child.once("error", reject);
    });
    const collect = (chunk: Buffer) => {
      output += chunk.toString();
      if (signal && !sent && output.includes("synthetic.socket.starting")) {
        sent = true;
        child.kill(signal);
      }
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const deadline = setTimeout(() => child.kill("SIGKILL"), 5_000);
    try {
      const code = await exited;
      assert.doesNotMatch(output, /synthetic-token-not-a-real-credential/);
      return { code, output, sent };
    } finally {
      clearTimeout(deadline);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("workspace and explicit enterprise installations shut down during pending socket startup", async () => {
  for (const [auth, enterpriseId, signal] of [
    [{ user_id: "UBOT", team_id: "TTEST" }, undefined, "SIGTERM"],
    [
      {
        user_id: "UBOT",
        team_id: "EORG",
        enterprise_id: "EORG",
        is_enterprise_install: true,
      },
      "EORG",
      "SIGINT",
    ],
  ] as const) {
    const result = await run(auth, enterpriseId, signal);
    assert.equal(result.code, 0, result.output);
    assert.ok(result.sent);
    assert.match(result.output, /synthetic.socket.disconnected/);
    assert.match(result.output, /computah.slack.stopped/);
    assert.doesNotMatch(
      result.output,
      /computah.slack.ready|synthetic.late_connection/,
    );
  }
});

test("installation mismatch cannot reach Socket Mode startup", async () => {
  for (const [auth, enterpriseId] of [
    [{ user_id: "UBOT", team_id: "TOTHER" }, undefined],
    [{ user_id: "UOWNER", team_id: "TTEST" }, undefined],
    [
      { user_id: "UBOT", enterprise_id: "EORG", is_enterprise_install: true },
      undefined,
    ],
    [
      { user_id: "UBOT", enterprise_id: "EOTHER", is_enterprise_install: true },
      "EORG",
    ],
    [{ user_id: "UBOT", is_enterprise_install: true }, "EORG"],
  ] as const) {
    const result = await run(auth, enterpriseId);
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /computah.slack.start_failed/);
    assert.doesNotMatch(result.output, /synthetic.socket.starting/);
  }
});
