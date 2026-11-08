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
      start(){if(process.env.TEST_CONTEXT){
        setTimeout(()=>this.emit('slack_event',{body:{team_id:'TTEST',event_id:'EvContext',event:{type:'app_mention',user:'UOWNER',channel:'CALLOWED',ts:'105.001',thread_ts:'100.001',text:'<@UBOT> current request'}},ack:async()=>console.log('synthetic.acked')}),10);
        return Promise.resolve();}
        setInterval(()=>console.log('synthetic.late_connection'),10000);
        console.log('synthetic.socket.starting');return new Promise(()=>{});}
      async disconnect(){console.log('synthetic.socket.disconnected');}
    }\`,
  '@slack/web-api': \`export const LogLevel={ERROR:'error'};
    export class WebClient {auth={test:async()=>JSON.parse(process.env.TEST_AUTH)};
      chat={postMessage:async(payload)=>{if(payload.channel!=='CALLOWED'||payload.thread_ts!=='100.001')throw new Error('Wrong destination');
        console.log('synthetic.delivered');process.kill(process.pid,'SIGTERM');return {ok:true};}};
    }\`,
};
registerHooks({resolve(specifier,context,next){
  if(modules[specifier])return {url:'data:text/javascript,'+encodeURIComponent(modules[specifier]),shortCircuit:true};
  return next(specifier,context);
}});
globalThis.fetch=async(_url,options)=>{
  const url=new URL(_url);
  if(url.hostname==='api.axiom.co'){
    if(url.pathname==='/v1/traces'&&JSON.parse(options.body).resourceSpans.some(r=>r.scopeSpans.some(s=>s.spans.some(span=>span.name==='computah.start.failed'))))console.log('synthetic.start_failed.flushed');
    return new Response('{}');
  }
  if(url.hostname==='slack.com'){
    if(options.headers.traceparent)throw new Error('External trace propagation');
    if(process.env.TEST_CONTEXT!=='granted'||url.pathname!=='/api/conversations.replies'||url.searchParams.get('channel')!=='CALLOWED'||url.searchParams.get('ts')!=='100.001'||url.searchParams.get('latest')!=='105.001'||url.searchParams.get('limit')!=='15'||url.searchParams.get('inclusive')!=='false'||url.searchParams.has('cursor'))throw new Error('Unexpected context access');
    console.log('synthetic.context.lookup');
    return new Response(JSON.stringify({ok:true,messages:[{user:'UPEER',ts:'100.001',text:'synthetic thread root'}],has_more:true,response_metadata:{next_cursor:'must-not-follow'}}));
  }
  if(process.env.TEST_CONTEXT&&!/^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/.test(options.headers.traceparent??''))throw new Error('Missing core trace propagation');
  if(url.pathname==='/v1/submissions'){
    const body=JSON.parse(options.body);
    const correct=options.headers.authorization.endsWith('shared')&&Object.keys(body).sort().join(',')==='clientMutationId,text'&&body.clientMutationId.startsWith('slack:')&&
      body.text.includes('[Slack reply protocol: host-offered destinations]')&&
      (process.env.TEST_CONTEXT==='granted'?body.text.includes('"author":"UPEER"')&&body.text.includes('synthetic thread root')&&body.text.includes('[Current request]\\ncurrent request'):body.text.startsWith('current request\\n\\n[Slack reply protocol:'));
    if(!correct)throw new Error('Wrong core request');
    console.log('synthetic.core.correct');return new Response(JSON.stringify({id:'synthetic-signed-handle'}));
  }
  if(url.pathname.startsWith('/v1/submissions/'))return new Response(JSON.stringify({submission:{outcome:'completed'},messages:[{role:'assistant',blocks:[{kind:'text',text:'synthetic answer'}]}]}));
  return new Response(JSON.stringify({viewer:{tenantId:'synthetic',userId:'owner',agentId:options.headers.authorization.endsWith('shared')?process.env.TEST_CHANNEL_VIEWER:'computah',capabilities:['task.send','history.read']}}));
};
`;

async function run(
  auth: Record<string, unknown>,
  enterpriseId?: string,
  signal?: "SIGTERM" | "SIGINT",
  channelViewer?: string,
  statusRequested = false,
  contextScenario?: "granted" | "denied",
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
          channelIds: ["CALLOWED"],
          channelBindings:
            channelViewer === undefined
              ? []
              : [
                  {
                    channelId: "CALLOWED",
                    tenantId: "synthetic",
                    userId: "owner",
                    agentId: "shared",
                    coreToken: "synthetic-token-not-a-real-credential-shared",
                  },
                ],
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
          TEST_CHANNEL_VIEWER: channelViewer ?? "",
          TEST_CONTEXT: contextScenario ?? "",
          SLACK_APP_TOKEN: "synthetic",
          SLACK_BOT_TOKEN: "synthetic",
          COMPUTAH_CORE_URL: "http://127.0.0.1:1",
          COMPUTAH_SLACK_DB: join(dir, "inbox.sqlite"),
          COMPUTAH_SLACK_TIMING_SOCKET: "",
          COMPUTAH_SLACK_TIMING_TOKEN_FILE: "",
          COMPUTAH_SLACK_STATUS_ENABLED: statusRequested ? "true" : "false",
          COMPUTAH_SLACK_BINDINGS_FILE: join(dir, "bindings.json"),
          COMPUTAH_AXIOM_INGEST_TOKEN: "synthetic-only",
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
    assert.match(result.output, /synthetic.start_failed.flushed/);
    assert.doesNotMatch(result.output, /synthetic.socket.starting/);
  }
});

test("shared audience token must resolve to its exact isolated viewer before socket startup", async () => {
  const auth = { user_id: "UBOT", team_id: "TTEST" };
  const accepted = await run(auth, undefined, "SIGTERM", "shared");
  assert.equal(accepted.code, 0, accepted.output);
  assert.ok(accepted.sent);
  const rejected = await run(auth, undefined, undefined, "computah");
  assert.equal(rejected.code, 1, rejected.output);
  assert.doesNotMatch(rejected.output, /synthetic.socket.starting/);
});

test("optional native status requires explicit enablement and observed bot grants", async () => {
  const auth = { user_id: "UBOT", team_id: "TTEST" };
  const denied = await run(auth, undefined, "SIGTERM", undefined, true);
  assert.equal(denied.code, 0, denied.output);
  assert.match(denied.output, /computah.slack.status_disabled_missing_grants/);
  const enabled = await run(
    {
      ...auth,
      response_metadata: { scopes: ["chat:write", "assistant:write"] },
    },
    undefined,
    "SIGTERM",
    undefined,
    true,
  );
  assert.equal(enabled.code, 0, enabled.output);
  assert.doesNotMatch(
    enabled.output,
    /computah.slack.status_disabled_missing_grants/,
  );
});

test("executable fetches only the invoked thread with observed grants, ACKs first and sends existing text contract", async () => {
  for (const context of ["granted", "denied"] as const) {
    const result = await run(
      {
        user_id: "UBOT",
        team_id: "TTEST",
        response_metadata: {
          scopes: context === "granted" ? ["channels:history"] : [],
        },
      },
      undefined,
      undefined,
      "shared",
      false,
      context,
    );
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /synthetic.acked/);
    assert.match(result.output, /synthetic.core.correct/);
    assert.match(result.output, /synthetic.delivered/);
    if (context === "granted") {
      assert.match(result.output, /synthetic.context.lookup/);
      assert.ok(
        result.output.indexOf("synthetic.acked") <
          result.output.indexOf("synthetic.context.lookup"),
      );
    } else assert.doesNotMatch(result.output, /synthetic.context.lookup/);
  }
});
