import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { SocketModeClient } from "@slack/socket-mode";
import { LogLevel, WebClient } from "@slack/web-api";
import { type Binding, type Ingress, SlackAdapter } from "./adapter.js";

async function main() {
  process.umask(0o077);
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
    warn() {},
    error() {},
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
  const auth = await web.auth.test();
  if (
    !auth.user_id ||
    bindings.some(
      (b) =>
        b.slackUserId === auth.user_id ||
        (auth.is_enterprise_install
          ? !auth.enterprise_id || b.enterpriseId !== auth.enterprise_id
          : !auth.team_id || b.teamId !== auth.team_id),
    )
  )
    throw new Error("Installation mismatch");
  const request = async (binding: Binding, path: string, body?: unknown) => {
    const response = await fetch(new URL(path, base), {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${binding.coreToken}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    });
    if (!response.ok) throw new Error("Core unavailable");
    return response.json();
  };
  for (const binding of bindings) {
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
  const adapter = new SlackAdapter(statePath, bindings, auth.user_id, {
    request,
    async openDm(user) {
      const result = await web.conversations.open({ users: user });
      if (!result.channel?.id?.startsWith("D"))
        throw new Error("No private DM");
      return result.channel.id;
    },
    async post(channel, text, thread) {
      await web.chat.postMessage({
        channel,
        text: text
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;"),
        mrkdwn: false,
        parse: "none",
        unfurl_links: false,
        unfurl_media: false,
        blocks: [
          { type: "section", text: { type: "plain_text", text, emoji: false } },
        ],
        ...(thread ? { thread_ts: thread } : {}),
      });
    },
  });
  let stopping = false;
  socket.on("slack_event", async ({ body, ack }) => {
    try {
      if (stopping) return;
      adapter.admit(body as Ingress);
      await ack();
    } catch {
      console.error("computah.slack.admission_failed");
    }
  });
  socket.on("error", () => console.error("computah.slack.connection_error"));
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
  try {
    await Promise.race([socket.start(), stopped]);
    if (!stopping) console.info("computah.slack.ready");
    while (!stopping) {
      await adapter.step();
      await delay(1000);
    }
  } finally {
    await socket.disconnect();
    adapter.close();
    clearTimeout(shutdownDeadline);
    console.info("computah.slack.stopped");
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
