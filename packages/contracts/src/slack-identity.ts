import { createHmac, timingSafeEqual } from "node:crypto";

/** Host-only enrollment policy. Never accept it from HTTP/model arguments. */
export interface SlackEnrollment {
  teamId: string;
  enterpriseId?: string;
  deniedUserIds: string[];
  ownerSlackUserId: string;
  ownerScope: { tenantId: string; userId: string; agentId: string };
  secret: string;
}
export const slackCapabilities = [
  "task.send",
  "history.read",
  "task.control",
  "files.read",
  "files.write",
] as const;

export function readSlackEnrollment(
  env: NodeJS.ProcessEnv,
): SlackEnrollment | undefined {
  const raw = env.COMPUTAH_SLACK_ENROLLMENT_JSON;
  const secret = env.COMPUTAH_SLACK_ENROLLMENT_SECRET;
  if (!raw && !secret) return undefined;
  const policy = JSON.parse(raw ?? "null");
  if (
    !secret ||
    secret.length < 32 ||
    !policy ||
    !/^[UW][A-Z0-9]+$/.test(policy.ownerSlackUserId) ||
    !policy.ownerScope ||
    ![
      policy.ownerScope.tenantId,
      policy.ownerScope.userId,
      policy.ownerScope.agentId,
    ].every(
      (part) =>
        typeof part === "string" && part.length > 0 && part.length <= 200,
    ) ||
    policy.ownerScope.tenantId.startsWith("slack:") ||
    !/^T[A-Z0-9]+$/.test(policy.teamId) ||
    (policy.enterpriseId !== undefined &&
      !/^E[A-Z0-9]+$/.test(policy.enterpriseId)) ||
    policy.channelIds !== undefined ||
    !Array.isArray(policy.deniedUserIds) ||
    policy.deniedUserIds.length > 1000 ||
    !policy.deniedUserIds.every(
      (id: unknown) => typeof id === "string" && /^[UW][A-Z0-9]+$/.test(id),
    )
  )
    throw new Error("Invalid Slack enrollment policy");
  return {
    teamId: policy.teamId,
    ...(policy.enterpriseId
      ? { enterpriseId: policy.enterpriseId as string }
      : {}),
    ownerSlackUserId: policy.ownerSlackUserId,
    ownerScope: {
      tenantId: policy.ownerScope.tenantId,
      userId: policy.ownerScope.userId,
      agentId: policy.ownerScope.agentId,
    },
    deniedUserIds: [...policy.deniedUserIds],
    secret,
  };
}

export function slackIdentity(
  policy: SlackEnrollment,
  team: string,
  user: string,
  audience: string,
) {
  if (
    team !== policy.teamId ||
    !/^[UW][A-Z0-9]+$/.test(user) ||
    policy.deniedUserIds.includes(user) ||
    (audience !== "dm" && !/^[CG][A-Z0-9]+$/.test(audience))
  )
    return undefined;
  const tenantId = `slack:${team}`;
  const userId = user;
  const agentId = audience === "dm" ? "private" : `channel:${audience}`;
  const payload = Buffer.from(JSON.stringify([team, user, audience])).toString(
    "base64url",
  );
  const signature = createHmac("sha256", policy.secret)
    .update(`computah.slack.v1.${payload}`)
    .digest("base64url");
  return {
    tenantId,
    userId,
    agentId,
    coreToken: `slack1.${payload}.${signature}`,
  };
}

export function verifySlackIdentity(policy: SlackEnrollment, token: string) {
  if (token.length > 512) return undefined;
  const [version, payload, signature, extra] = token.split(".");
  if (version !== "slack1" || !payload || !signature || extra !== undefined)
    return undefined;
  try {
    const parts: unknown = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    );
    if (
      !Array.isArray(parts) ||
      parts.length !== 3 ||
      !parts.every((part) => typeof part === "string")
    )
      return undefined;
    const [team, user, audience] = parts as [string, string, string];
    const identity = slackIdentity(policy, team, user, audience);
    if (!identity) return undefined;
    const expected = Buffer.from(identity.coreToken);
    const actual = Buffer.from(token);
    return actual.length === expected.length &&
      timingSafeEqual(actual, expected)
      ? identity
      : undefined;
  } catch {
    return undefined;
  }
}

/** Recomputable after recovery; a model cannot select another actor's Binding. */
export function slackScopeAllowed(
  policy: SlackEnrollment,
  scope: { tenantId: string; userId: string; agentId: string },
) {
  const audience =
    scope.agentId === "private"
      ? "dm"
      : scope.agentId.startsWith("channel:")
        ? scope.agentId.slice(8)
        : "";
  const identity = slackIdentity(policy, policy.teamId, scope.userId, audience);
  return (
    identity &&
    scope.tenantId === identity.tenantId &&
    scope.agentId === identity.agentId
  );
}
