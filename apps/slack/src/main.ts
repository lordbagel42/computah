import { createHmac } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  readSlackEnrollment,
  slackIdentity,
} from "@computah/contracts/slack-identity";
import {
  currentTraceHeaders,
  runtimeLog,
  startObservability,
  traceEvent,
  traceOperation,
} from "@computah/observability";
import { SocketModeClient } from "@slack/socket-mode";
import { LogLevel, WebClient } from "@slack/web-api";
import {
  type Binding,
  type Ingress,
  SlackAdapter,
  type Transport,
} from "./adapter.js";
import type { DebugReport } from "./debugshare.js";
import {
  CoreDenied,
  CoreRejected,
  readAcknowledgement,
  taskUpdates,
} from "./lifecycle.js";
import { presentSlack } from "./presentation.js";
import { startTimingBroker } from "./timing-broker.js";

async function main() {
  const telemetry = await startObservability("slack");
  try {
    await run();
  } catch {
    traceEvent("start.failed");
    runtimeLog("runtime.start_failed", { outcome: "error" }, "error");
    throw new Error("Slack runtime failed");
  } finally {
    // Includes config/auth/viewer failures before the socket loop is constructed.
    await telemetry.close();
  }
}

async function run() {
  process.umask(0o077);
  const enrollment = readSlackEnrollment(process.env);
  const required = (name: string) => {
    const value = process.env[name];
    if (!value) throw new Error("Missing configuration");
    return value;
  };
  const configPath = required("COMPUTAH_SLACK_BINDINGS_FILE");
  const statePath = required("COMPUTAH_SLACK_DB");
  if (!isAbsolute(configPath) || !isAbsolute(statePath))
    throw new Error("Absolute paths required");
  if ((await stat(configPath)).mode & 0o077)
    throw new Error("Private binding file required");
  const bindings: Binding[] = JSON.parse(await readFile(configPath, "utf8"));
  if (
    !Array.isArray(bindings) ||
    !bindings.length ||
    bindings.some(
      (b) =>
        !b ||
        [
          b.teamId,
          b.slackUserId,
          b.tenantId,
          b.userId,
          b.agentId,
          b.coreToken,
        ].some((v) => typeof v !== "string" || !v) ||
        !Array.isArray(b.channelIds) ||
        b.channelIds.some(
          (id) => typeof id !== "string" || !/^[CG][A-Z0-9]+$/.test(id),
        ) ||
        (b.enterpriseId !== undefined &&
          (typeof b.enterpriseId !== "string" ||
            !/^E[A-Z0-9]+$/.test(b.enterpriseId))) ||
        (b.channelBindings !== undefined &&
          (!Array.isArray(b.channelBindings) ||
            b.channelBindings.some(
              (channel) =>
                !channel ||
                !/^[CG][A-Z0-9]+$/.test(channel.channelId) ||
                [
                  channel.tenantId,
                  channel.userId,
                  channel.agentId,
                  channel.coreToken,
                ].some((v) => typeof v !== "string" || !v) ||
                channel.coreToken.length < 32,
            ))) ||
        b.coreToken.length < 32,
    )
  )
    throw new Error("Invalid bindings");
  const base = new URL(required("COMPUTAH_CORE_URL"));
  if (
    base.username ||
    base.password ||
    base.pathname !== "/" ||
    base.search ||
    base.hash ||
    !(
      base.protocol === "https:" ||
      (base.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname))
    )
  )
    throw new Error("Protected core URL required");
  await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
  if ((await stat(dirname(statePath))).mode & 0o077)
    throw new Error("Private state directory required");
  // SDK default loggers may contain payloads or credential-bearing request details.
  const logger = {
    debug() {},
    info() {},
    warn() {
      traceEvent("report");
      runtimeLog("runtime.report", { outcome: "error" }, "warn");
    },
    error() {
      traceEvent("report");
      runtimeLog("runtime.report", { outcome: "error" }, "error");
    },
    setLevel() {},
    getLevel: () => LogLevel.ERROR,
    setName() {},
  };
  const web = new WebClient(required("SLACK_BOT_TOKEN"), {
    logger,
    retryConfig: { retries: 0 },
    rejectRateLimitedCalls: true,
    timeout: 15_000,
  });
  const socket = new SocketModeClient({
    appToken: required("SLACK_APP_TOKEN"),
    logger,
    clientOptions: {
      retryConfig: { retries: 0 },
      rejectRateLimitedCalls: true,
      timeout: 15_000,
    },
  });
  const auth = await traceOperation("slack.api", () => web.auth.test());
  if (
    !auth.user_id ||
    (enrollment &&
      (enrollment.ownerSlackUserId === auth.user_id ||
        (auth.is_enterprise_install
          ? enrollment.enterpriseId !== auth.enterprise_id
          : enrollment.teamId !== auth.team_id))) ||
    bindings.some(
      (b) =>
        b.slackUserId === auth.user_id ||
        (auth.is_enterprise_install
          ? !auth.enterprise_id || b.enterpriseId !== auth.enterprise_id
          : !auth.team_id || b.teamId !== auth.team_id),
    )
  )
    throw new Error("Installation mismatch");
  const statusEnabled =
    process.env.COMPUTAH_SLACK_STATUS_ENABLED === "true" &&
    ["chat:write", "assistant:write"].every((scope) =>
      auth.response_metadata?.scopes?.includes(scope),
    );
  if (process.env.COMPUTAH_SLACK_STATUS_ENABLED === "true" && !statusEnabled)
    console.info("computah.slack.status_disabled_missing_grants");
  // Streaming uses the existing observed chat:write grant, not assistant:write
  // or interactivity. Keep optional card calls shorter than ordinary posts.
  const streamWeb = auth.response_metadata?.scopes?.includes("chat:write")
    ? new WebClient(required("SLACK_BOT_TOKEN"), {
        logger,
        retryConfig: { retries: 0 },
        rejectRateLimitedCalls: true,
        timeout: 2000,
      })
    : undefined;
  const diagnosticSecrets = Object.entries(process.env)
    .filter(
      ([key, value]) =>
        /TOKEN|SECRET|API_KEY/.test(key) && value && value.length >= 8,
    )
    .map(([, value]) => value as string);
  const timingSocket = process.env.COMPUTAH_SLACK_TIMING_SOCKET;
  const timingTokenFile = process.env.COMPUTAH_SLACK_TIMING_TOKEN_FILE;
  let timingToken: string | undefined;
  if (timingSocket || timingTokenFile) {
    if (
      !timingSocket ||
      !timingTokenFile ||
      !isAbsolute(timingSocket) ||
      !isAbsolute(timingTokenFile)
    )
      throw new Error("Complete private timing broker configuration required");
    if (
      [statePath, configPath, timingTokenFile].some((path) => {
        const location = relative(dirname(timingSocket), path);
        return (
          location !== ".." &&
          !location.startsWith("../") &&
          !isAbsolute(location)
        );
      })
    )
      throw new Error(
        "Timing socket directory must not contain private state or credentials",
      );
    if ((await stat(timingTokenFile)).mode & 0o077)
      throw new Error("Private timing credential file required");
    timingToken = (await readFile(timingTokenFile, "utf8")).trim();
    if (timingToken.length < 32) throw new Error("Invalid timing credential");
    diagnosticSecrets.push(timingToken);
  }
  const uploadConfig = [
    process.env.COMPUTAH_DEBUGSHARE_INGEST_URL,
    process.env.COMPUTAH_DEBUGSHARE_SIGNING_SECRET,
    process.env.COMPUTAH_DEBUGSHARE_REPORT_URL,
  ];
  if (uploadConfig.some(Boolean) && !uploadConfig.every(Boolean))
    throw new Error("Incomplete DEBUGSHARE configuration");
  const publishDebugshare = uploadConfig.every(Boolean)
    ? async (report: DebugReport) => {
        const [ingest, secret, origin] = uploadConfig as [
          string,
          string,
          string,
        ];
        for (const target of [ingest, origin]) {
          const url = new URL(target);
          if (
            url.protocol !== "https:" ||
            url.username ||
            url.password ||
            url.hash
          )
            throw new Error("Protected DEBUGSHARE URL required");
        }
        if (secret.length < 32)
          throw new Error("DEBUGSHARE signing key too short");
        const body = JSON.stringify(report);
        const timestamp = String(Date.now());
        const signature = createHmac("sha256", secret)
          .update(`${timestamp}.${body}`)
          .digest("hex");
        const response = await fetch(ingest, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-computah-timestamp": timestamp,
            "x-computah-signature": signature,
          },
          body,
          signal: AbortSignal.timeout(10_000),
          redirect: "error",
        });
        const result = (await response.json()) as { id?: unknown };
        if (!response.ok || result.id !== report.id)
          throw new Error("DEBUGSHARE upload unavailable");
        const url = new URL(origin);
        url.hash = report.id;
        return url.href;
      }
    : undefined;
  const request = async (binding: Binding, path: string, body?: unknown) =>
    traceOperation("slack.core", async () => {
      const response = await fetch(new URL(path, base), {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${binding.coreToken}`,
          "content-type": "application/json",
          ...currentTraceHeaders(),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
        redirect: "error",
      });
      if (
        path === "/v1/community" &&
        [400, 403, 409, 413, 429].includes(response.status)
      )
        throw new CoreRejected();
      if (response.status === 401 || response.status === 403)
        throw new CoreDenied();
      if (!response.ok) throw new Error("Core unavailable");
      return response.json();
    });
  for (const binding of [
    ...bindings.flatMap((b) => [
      b,
      ...(b.channelBindings ?? []).map((channel) => ({ ...b, ...channel })),
    ]),
    ...(enrollment
      ? [
          {
            teamId: enrollment.teamId,
            slackUserId: enrollment.ownerSlackUserId,
            channelIds: [],
            ...slackIdentity(
              enrollment,
              enrollment.teamId,
              enrollment.ownerSlackUserId,
              "dm",
            )!,
          },
        ]
      : []),
  ]) {
    const result = (await request(binding, "/v1/viewer")) as {
      viewer?: Partial<Binding> & { capabilities?: string[] };
    };
    if (
      !result.viewer ||
      ["tenantId", "userId", "agentId"].some(
        (key) =>
          result.viewer?.[key as "tenantId"] !== binding[key as "tenantId"],
      ) ||
      !["task.send", "history.read"].every((cap) =>
        result.viewer?.capabilities?.includes(cap),
      )
    )
      throw new Error("Core binding mismatch");
  }
  const adapter = new SlackAdapter(
    statePath,
    bindings,
    auth.user_id,
    {
      request,
      ...(streamWeb
        ? ({
            async stream(_binding, update) {
              return traceOperation("slack.api", async (span) => {
                if (!update.ts || !update.terminal)
                  return { status: "closed" as const };
                const chunks = taskUpdates(update.phase, update.terminal);
                try {
                  const args = {
                    channel: update.channel,
                    ts: update.ts,
                    chunks,
                  };
                  await streamWeb.chat.stopStream(args);
                  return { status: "ok" as const };
                } catch (error) {
                  const code = (error as { data?: { error?: string } }).data
                    ?.error;
                  if (
                    [
                      "missing_scope",
                      "unknown_method",
                      "not_allowed_token_type",
                      "feature_not_enabled",
                      "not_in_channel",
                    ].includes(code ?? "")
                  ) {
                    span.setAttribute("outcome", "denied");
                    return { status: "unsupported" as const };
                  }
                  if (
                    [
                      "message_not_in_streaming_state",
                      "stopped_by_user",
                    ].includes(code ?? "")
                  ) {
                    span.setAttribute("outcome", "error");
                    return { status: "closed" as const };
                  }
                  span.setAttribute("outcome", "error");
                  throw error;
                }
              });
            },
          } satisfies Pick<Transport, "stream">)
        : {}),
      async acknowledgement(binding, submission, signal) {
        return traceOperation("slack.core", async () => {
          const response = await fetch(
            new URL(
              `/v1/submissions/${encodeURIComponent(submission)}/events`,
              base,
            ),
            {
              headers: {
                authorization: `Bearer ${binding.coreToken}`,
                accept: "text/event-stream",
                ...currentTraceHeaders(),
              },
              signal,
              redirect: "error",
            },
          );
          return readAcknowledgement(response, submission);
        });
      },
      ...(publishDebugshare ? { publishDebugshare } : {}),
      async diagnosticContext(source) {
        // Channel prefixes do not reliably distinguish private channels from MPIMs.
        // Slack authorizes the exact conversation; this is only an observed-grant gate.
        const scopes = source.channel.startsWith("D")
          ? ["im:history"]
          : ["channels:history", "groups:history", "mpim:history"];
        if (
          !scopes.some((scope) =>
            auth.response_metadata?.scopes?.includes(scope),
          )
        )
          throw new Error("Diagnostic context unavailable");
        const root =
          source.thread ??
          (source.channel.startsWith("D") ? null : source.message);
        const url = new URL(
          `https://slack.com/api/conversations.${root ? "replies" : "history"}`,
        );
        url.search = new URLSearchParams({
          channel: source.channel,
          ...(root ? { ts: root } : {}),
          latest: source.message,
          inclusive: "true",
          limit: "20",
        }).toString();
        const response = await traceOperation("slack.api", () =>
          fetch(url, {
            headers: { authorization: `Bearer ${required("SLACK_BOT_TOKEN")}` },
            signal: AbortSignal.timeout(2000),
            redirect: "error",
          }),
        );
        const result = (await response.json()) as {
          ok?: boolean;
          messages?: unknown;
        };
        if (!response.ok || result.ok !== true)
          throw new Error("Diagnostic context unavailable");
        return { messages: result.messages };
      },
      async openDm(user) {
        const result = await traceOperation("slack.api", () =>
          web.conversations.open({ users: user }),
        );
        if (!result.channel?.id?.startsWith("D"))
          throw new Error("No private DM");
        return result.channel.id;
      },
      async post(channel, text, thread) {
        await traceOperation("slack.api", () =>
          web.chat.postMessage({
            channel,
            ...presentSlack(text),
            mrkdwn: true,
            link_names: false,
            parse: "none",
            unfurl_links: false,
            unfurl_media: false,
            ...(thread ? { thread_ts: thread } : {}),
          }),
        );
      },
      async threadContext(channel, thread, before, signal) {
        if (
          !["channels:history", "groups:history", "mpim:history"].some(
            (scope) => auth.response_metadata?.scopes?.includes(scope),
          )
        )
          throw new Error("Thread context unavailable");
        // One bounded page from the invoked thread, no search, profiles, DMs or pagination.
        const url = new URL("https://slack.com/api/conversations.replies");
        url.search = new URLSearchParams({
          channel,
          ts: thread,
          latest: before,
          inclusive: "false",
          limit: "15",
        }).toString();
        const response = await traceOperation("slack.api", () =>
          fetch(url, {
            headers: { authorization: `Bearer ${required("SLACK_BOT_TOKEN")}` },
            signal,
            redirect: "error",
          }),
        );
        const result = (await response.json()) as {
          ok?: boolean;
          messages?: unknown;
        };
        if (!response.ok || result.ok !== true)
          throw new Error("Thread context unavailable");
        return { messages: result.messages };
      },
      async status(channel, thread, status, signal) {
        try {
          // Separate, cancellable HTTP request: optional status never consumes the
          // delivery client's queue or its 15s request budget. No automatic retries.
          const response = await traceOperation("slack.api", () =>
            fetch("https://slack.com/api/agents.sessions.setStatus", {
              method: "POST",
              headers: {
                authorization: `Bearer ${required("SLACK_BOT_TOKEN")}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                channel_id: channel,
                thread_ts: thread,
                status,
              }),
              signal,
              redirect: "error",
            }),
          );
          const result = (await response.json()) as {
            ok?: boolean;
            error?: string;
          };
          if (
            [
              "missing_scope",
              "feature_disabled",
              "unknown_method",
              "not_allowed_token_type",
              "enterprise_is_restricted",
              "invalid_auth",
              "token_revoked",
              "token_expired",
              "account_inactive",
            ].includes(result.error ?? "")
          ) {
            console.info("computah.slack.status_unsupported");
            return "unsupported";
          }
          if (!response.ok || result.ok !== true)
            throw new Error("Status unavailable");
          return "ok";
        } catch {
          console.error("computah.slack.status_failed");
          throw new Error("Slack status unavailable");
        }
      },
    },
    Date.now,
    statusEnabled,
    1200,
    true,
    diagnosticSecrets,
    enrollment,
  );
  let stopping = false;
  socket.on("slack_event", async ({ body, ack }) => {
    const receivedAt = Date.now();
    try {
      await traceOperation("slack.receive", async () => {
        if (stopping) return;
        const outcome = adapter.admit(body as Ingress, receivedAt);
        runtimeLog("slack.receive", {
          operation: "receive",
          outcome:
            outcome === "accepted"
              ? "queued"
              : outcome === "duplicate"
                ? "success"
                : "denied",
        });
        await adapter.acknowledge(body as Ingress, ack);
      });
    } catch {
      console.error("computah.slack.admission_failed");
      runtimeLog(
        "slack.receive",
        { operation: "receive", outcome: "error" },
        "error",
      );
    }
  });
  socket.on("error", () => {
    console.error("computah.slack.connection_error");
    traceEvent("report");
    runtimeLog(
      "runtime.report",
      { outcome: "error", reason: "transport" },
      "error",
    );
  });
  let shutdownDeadline: ReturnType<typeof setTimeout> | undefined;
  const stopped = new Promise<void>((resolve) => {
    const stop = () => {
      stopping = true;
      // An interrupted send remains journaled as posting/uncertain on restart.
      shutdownDeadline = setTimeout(() => process.exit(1), 45_000);
      shutdownDeadline.unref();
      resolve();
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  });
  let timingBroker: Awaited<ReturnType<typeof startTimingBroker>> | undefined;
  // Separate from the core long poll: unanswered deadlines must remain visible.
  const replyDeadlines = setInterval(() => adapter.pumpReplyLatency(), 250);
  replyDeadlines.unref();
  try {
    if (timingSocket && timingToken)
      timingBroker = await startTimingBroker({
        socketPath: timingSocket,
        token: timingToken,
        read: (requestId, scope) => adapter.readTiming(requestId, scope),
      });
    await Promise.race([socket.start(), stopped]);
    if (!stopping) {
      console.info("computah.slack.ready");
      traceEvent("ready");
      runtimeLog("runtime.ready", { outcome: "ready" });
    }
    while (!stopping) {
      await traceOperation("slack.step", () => adapter.step());
      await delay(1000);
    }
  } finally {
    clearInterval(replyDeadlines);
    try {
      await socket.disconnect();
    } finally {
      try {
        try {
          await timingBroker?.close();
        } finally {
          await adapter.stop();
        }
      } finally {
        adapter.close();
        clearTimeout(shutdownDeadline);
        console.info("computah.slack.stopped");
        traceEvent("stopped");
        runtimeLog("runtime.stopped", { outcome: "stopped" });
      }
    }
  }
}

// Own process lifetime: an SDK startup/reconnect must not outlive shutdown.
main().then(
  () => process.exit(0),
  () => {
    console.error("computah.slack.start_failed");
    process.exit(1);
  },
);
