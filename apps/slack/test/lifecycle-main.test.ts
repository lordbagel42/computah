import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Real executable, HTTP/SSE parsing, cancellation transport and sanitized export;
// only the external Socket/Web/core/Axiom boundaries are synthetic.
const preload = `
import {registerHooks} from 'node:module';
globalThis.syntheticEmit=(id,text)=>globalThis.syntheticSocket.emit('slack_event',{body:{team_id:'TTEST',event_id:id,event:{type:'message',channel_type:'im',user:'UOWNER',channel:'DOWNER',ts:id+'.001',text,...(process.env.TEST_CARDS?{thread_ts:'1.000'}:{})}},ack:async()=>{}});
const modules={
 '@slack/socket-mode':\`import {EventEmitter} from 'node:events';
 export class SocketModeClient extends EventEmitter {
   start(){globalThis.syntheticSocket=this;setTimeout(()=>globalThis.syntheticEmit('1','private-work-canary'),5);return Promise.resolve();}
   async disconnect(){}
 }\`,
 '@slack/web-api':\`export const LogLevel={ERROR:'error'};
 export class WebClient {
   auth={test:async()=>({user_id:'UBOT',team_id:'TTEST',response_metadata:{scopes:['chat:write','im:write','im:history','app_mentions:read']}})};
   chat={postMessage:async(p)=>{
     if(p.channel!=='DOWNER'||p.thread_ts!==(process.env.TEST_CARDS?'1.000':undefined))throw new Error('DM was threaded or rerouted');
     if(p.text==='On it.'){
       console.log('synthetic.progress.correct');globalThis.syntheticEmit('2','stop');
     } else if(p.text.includes(process.env.TEST_CANCEL==='denied'?'Core denied cancellation':process.env.TEST_CANCEL==='unknown'?'Cancellation is not confirmed':'Core confirmed cancellation')){
       console.log('synthetic.cancel.correct');process.kill(process.pid,'SIGTERM');
     } else throw new Error('Unexpected or leaked text');
     return {ok:true};
   },startStream:async(p)=>{
     if(p.channel!=='DOWNER'||p.thread_ts!=='1.000'||p.recipient_user_id||p.task_display_mode!=='plan'||p.chunks.length!==1||p.chunks[0].id!=='interaction'||p.chunks[0].title!=='On it.'||p.chunks[0].status!=='in_progress'||p.markdown_text||p.blocks)throw new Error('Invalid native start');
     console.log('synthetic.stream.start.correct');
     if(process.env.TEST_CARDS==='denied')throw {data:{error:'missing_scope'}};
     if(process.env.TEST_CARDS==='error'){console.log('synthetic.progress.correct');globalThis.syntheticEmit('2','stop');throw new Error('ambiguous start');}
     return {ok:true,ts:'15.001'};
   },appendStream:async(p)=>{
     if(p.channel!=='DOWNER'||p.ts!=='15.001'||p.chunks.length!==2||p.chunks[1].id!=='worker'||p.chunks[1].status!=='in_progress'||p.markdown_text)throw new Error('Invalid native append');
     console.log('synthetic.stream.append.correct');console.log('synthetic.progress.correct');globalThis.syntheticEmit('2','stop');return {ok:true};
   },stopStream:async(p)=>{
     if(p.channel!=='DOWNER'||p.ts!=='15.001'||p.chunks.length!==2||p.chunks.some(c=>c.status!=='error')||!p.chunks[0].title.includes('confirmed cancellation'))throw new Error('Invalid native stop');
     console.log('synthetic.stream.stop.correct');return {ok:true};
   }};
 }\`
};
registerHooks({resolve(s,c,next){if(modules[s])return {url:'data:text/javascript,'+encodeURIComponent(modules[s]),shortCircuit:true};return next(s,c);}});
const spans=[];
const logs=[];
const coreHeaders=[];
let calls=0;
let observations=0;
let waiting=false;
globalThis.fetch=async(u,o)=>{
 const url=new URL(u);
 if(url.hostname==='api.axiom.co'){
   if(/private-work-canary|private-envelope-canary|private-worker-label|synthetic-core-secret/.test(o.body))throw new Error('Telemetry leaked private content');
   if(url.pathname==='/v1/traces')spans.push(...JSON.parse(o.body).resourceSpans.flatMap(r=>r.scopeSpans.flatMap(s=>s.spans)));
   else {
     logs.push(o.body);
     const records=JSON.parse(o.body).resourceLogs?.flatMap(r=>r.scopeLogs.flatMap(s=>s.logRecords))??[];
     if(waiting&&records.some(r=>r.body?.stringValue==='slack.reply_latency'&&r.attributes?.some(a=>a.key==='slack.reply.phase'&&a.value.stringValue==='overdue')))console.log('synthetic.deadline.during.wait.correct');
   }
   return new Response('{}');
 }
 if(url.hostname!=='127.0.0.1'||o.headers.authorization!=='Bearer synthetic-core-secret-not-a-real-credential'||!/^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/.test(o.headers.traceparent??''))throw new Error('Wrong core identity/trace');
 if(url.pathname.startsWith('/v1/submissions'))coreHeaders.push({path:url.pathname,carrier:o.headers.traceparent});
 if(url.pathname==='/v1/viewer')return Response.json({viewer:{tenantId:'tenant',userId:'owner',agentId:'private',capabilities:['task.send','history.read','task.control']}});
 if(url.pathname==='/v1/submissions'){
   if(++calls!==1||JSON.parse(o.body).text.startsWith('stop'))throw new Error('Stop created model work');
   return Response.json({id:'signed-handle'});
 }
 if(url.pathname.endsWith('/events')){
   if(o.method||o.headers['last-event-id']||o.headers.accept!=='text/event-stream')throw new Error('Invalid observation reconnect');
   console.log('synthetic.observation.correct');
   return new Response('data: '+JSON.stringify({version:1,kind:'resync',sequence:0,submissionId:'signed-handle',observations:[{submissionId:'signed-handle',source:process.env.TEST_CARDS&&observations++===0?'interaction':'worker',phase:'generating',workerLabel:'private-worker-label',text:'{"text":"private-envelope-canary"'}]})+'\\n\\n');
 }
 if(url.pathname.endsWith('/cancel')){
   if(o.method!=='POST'||o.body!=='{}')throw new Error('Invalid cancel request');
   console.log('synthetic.cancel.transport.correct');
   return process.env.TEST_CANCEL==='denied'?new Response('{}',{status:403}):Response.json({submissionId:'signed-handle',status:process.env.TEST_CANCEL==='unknown'?'unknown':'cancelled'});
 }
 // Wait long enough for the actual adapter's five-second progress threshold.
 waiting=true;
 await new Promise(resolve=>setTimeout(resolve,process.env.TEST_CANCEL==='cancelled'&&!process.env.TEST_CARDS?6100:3100));
 waiting=false;
 return Response.json({submission:{outcome:'streaming'}});
};
process.on('exit',()=>{
 const attr=(s,key)=>s.attributes?.find(a=>a.key===key)?.value?.stringValue;
 const status=spans.find(s=>s.name==='computah.slack.status');
 const child=(name,parent)=>spans.some(s=>s.name===name&&s.traceId===parent?.traceId&&s.parentSpanId===parent?.spanId);
 if(status&&child('computah.slack.core',status)&&child('computah.slack.api',status))console.log('synthetic.progress.trace.correct');
 const wait=spans.find(s=>s.name==='computah.slack.wait'&&attr(s,'outcome')===(process.env.TEST_CANCEL==='denied'?'denied':process.env.TEST_CANCEL==='unknown'?'error':'cancelled'));
 const root=spans.find(s=>s.name==='computah.slack.job'&&s.traceId===wait?.traceId&&s.spanId===wait?.parentSpanId);
 if(root&&spans.some(s=>s.name==='computah.slack.receive'&&s.traceId===root.traceId&&s.spanId===root.parentSpanId))console.log('synthetic.ingress.trace.correct');
 if(coreHeaders.length&&coreHeaders.every(h=>{
   const [,traceId,spanId]=h.carrier.split('-');
   const client=spans.find(s=>s.traceId===traceId&&s.spanId===spanId&&s.name==='computah.slack.core');
   const phase=h.path==='/v1/submissions'?'submit':h.path.endsWith('/events')?'status':'wait';
   return client&&spans.some(s=>s.traceId===traceId&&s.spanId===client.parentSpanId&&s.name==='computah.slack.'+phase);
 }))console.log('synthetic.wire.trace.correct');
 if(wait&&root&&child('computah.slack.core',wait))console.log('synthetic.cancel.trace.correct');
 if(logs.join('').includes(process.env.TEST_CANCEL==='denied'?'denied':process.env.TEST_CANCEL==='unknown'?'error':'cancelled'))console.log('synthetic.outcome.log.correct');
 if(process.env.TEST_CARDS==='denied'||process.env.TEST_CARDS==='error'){
   const expected=process.env.TEST_CARDS==='denied'?'denied':'error';
   const failed=spans.find(s=>s.name==='computah.slack.status'&&attr(s,'outcome')===expected);
   if(failed&&spans.some(s=>s.name==='computah.slack.api'&&s.parentSpanId===failed.spanId&&s.traceId===failed.traceId&&attr(s,'outcome')===expected))console.log('synthetic.stream.failure.trace.correct');
 }
 if(process.env.TEST_CARDS==='success'){
   const end=spans.find(s=>s.name==='computah.slack.status'&&attr(s,'outcome')==='cancelled');
   if(end&&child('computah.slack.api',end))console.log('synthetic.stream.end.trace.correct');
 }
});
`;

test("executable uses actual observation phases and scoped stop transport with sanitized parent-linked outcomes", async () => {
  for (const [outcome, cards] of [
    ["cancelled", ""],
    ["denied", ""],
    ["unknown", ""],
    ["cancelled", "success"],
    ["cancelled", "denied"],
    ["cancelled", "error"],
  ]) {
    const dir = await mkdtemp(join(tmpdir(), "slack-lifecycle-executable-"));
    try {
      await writeFile(join(dir, "preload.mjs"), preload);
      await writeFile(
        join(dir, "bindings.json"),
        JSON.stringify([
          {
            teamId: "TTEST",
            slackUserId: "UOWNER",
            tenantId: "tenant",
            userId: "owner",
            agentId: "private",
            coreToken: "synthetic-core-secret-not-a-real-credential",
            channelIds: [],
          },
        ]),
        { mode: 0o600 },
      );
      const child = spawn(
        process.execPath,
        [
          "--import",
          join(dir, "preload.mjs"),
          "--import",
          "tsx",
          "src/main.ts",
        ],
        {
          cwd: fileURLToPath(new URL("..", import.meta.url)),
          env: {
            ...process.env,
            TEST_CANCEL: outcome,
            TEST_CARDS: cards,
            COMPUTAH_AXIOM_CONTENT_ENABLED: "",
            SLACK_APP_TOKEN: "synthetic",
            SLACK_BOT_TOKEN: "synthetic",
            COMPUTAH_CORE_URL: "http://127.0.0.1:1",
            COMPUTAH_SLACK_DB: join(dir, "inbox.sqlite"),
            COMPUTAH_SLACK_BINDINGS_FILE: join(dir, "bindings.json"),
            COMPUTAH_SLACK_TIMING_SOCKET: "",
            COMPUTAH_SLACK_TIMING_TOKEN_FILE: "",
            COMPUTAH_SLACK_STATUS_ENABLED: "false",
            COMPUTAH_AXIOM_INGEST_TOKEN: "synthetic-only",
            COMPUTAH_AXIOM_LOG_DATASET: "computah-prod-logs",
            COMPUTAH_DEBUGSHARE_INGEST_URL: "",
            COMPUTAH_DEBUGSHARE_SIGNING_SECRET: "",
            COMPUTAH_DEBUGSHARE_REPORT_URL: "",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        output += chunk;
      });
      const deadline = setTimeout(() => child.kill("SIGKILL"), 35_000);
      try {
        const code = await new Promise<number | null>((resolve, reject) => {
          child.once("exit", resolve);
          child.once("error", reject);
        });
        assert.equal(code, 0, output);
        for (const marker of [
          "observation.correct",
          "progress.correct",
          "cancel.transport.correct",
          "cancel.correct",
          "progress.trace.correct",
          "cancel.trace.correct",
          "ingress.trace.correct",
          "wire.trace.correct",
          "outcome.log.correct",
          ...(outcome === "cancelled" && !cards
            ? ["deadline.during.wait.correct"]
            : []),
          ...(cards ? ["stream.start.correct"] : []),
          ...(cards === "success"
            ? [
                "stream.append.correct",
                "stream.stop.correct",
                "stream.end.trace.correct",
              ]
            : []),
          ...(cards === "error" || cards === "denied"
            ? ["stream.failure.trace.correct"]
            : []),
        ])
          assert.ok(
            output.includes(`synthetic.${marker}`),
            `${outcome}: missing ${marker}\n${output}`,
          );
        assert.doesNotMatch(
          output,
          /private-work-canary|private-envelope-canary|synthetic-core-secret/,
        );
      } finally {
        clearTimeout(deadline);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});
