import assert from "node:assert/strict";
import { test } from "node:test";
import {
  readSlackEnrollment,
  slackCapabilities,
  slackIdentity,
  slackScopeAllowed,
  verifySlackIdentity,
} from "../src/slack-identity.js";

test("Slack credentials bind exact canonical user/workspace/audience and never carry owner grants", () => {
  const env = {
    COMPUTAH_SLACK_ENROLLMENT_SECRET:
      "synthetic-issuer-secret-32-characters-long",
    COMPUTAH_SLACK_ENROLLMENT_JSON: JSON.stringify({
      teamId: "TTEST",
      ownerSlackUserId: "UOWNER",
      ownerScope: { tenantId: "tenant", userId: "owner", agentId: "default" },
      channelIds: ["CONE", "CTWO"],
      deniedUserIds: ["UBLOCKED"],
    }),
  };
  const policy = readSlackEnrollment(env)!;
  assert.equal(readSlackEnrollment({}), undefined);
  assert.throws(() =>
    readSlackEnrollment({ ...env, COMPUTAH_SLACK_ENROLLMENT_SECRET: "short" }),
  );
  const alice = slackIdentity(policy, "TTEST", "UALICE", "dm")!;
  assert.deepEqual(
    verifySlackIdentity(readSlackEnrollment(env)!, alice.coreToken),
    alice,
  );
  assert.ok(slackScopeAllowed(policy, alice));
  for (const [team, user, audience] of [
    ["TOTHER", "UALICE", "dm"],
    ["TTEST", "UBLOCKED", "dm"],
    ["TTEST", "UALICE", "COTHER"],
    ["TTEST", "../owner", "dm"],
  ] as const)
    assert.equal(slackIdentity(policy, team, user, audience), undefined);
  const variants = [
    slackIdentity(policy, "TTEST", "UBOB", "dm")!,
    slackIdentity(policy, "TTEST", "UALICE", "CONE")!,
    slackIdentity(policy, "TTEST", "UALICE", "CTWO")!,
    slackIdentity(policy, "TTEST", "UOWNER", "CONE")!,
  ];
  assert.equal(
    new Set(
      [alice, ...variants].map((scope) =>
        JSON.stringify([scope.tenantId, scope.userId, scope.agentId]),
      ),
    ).size,
    5,
  );
  for (const invalid of [
    alice.coreToken + ".extra",
    alice.coreToken.replace("slack1.", "slack2."),
    alice.coreToken.slice(0, -1),
    "x".repeat(513),
    variants[0]!.coreToken.replace(
      variants[0]!.coreToken.split(".")[2]!,
      alice.coreToken.split(".")[2]!,
    ),
  ])
    assert.equal(verifySlackIdentity(policy, invalid), undefined);
  assert.equal(
    verifySlackIdentity(
      { ...policy, secret: "different-private-key-32-characters-long" },
      alice.coreToken,
    ),
    undefined,
  );
  assert.equal(
    verifySlackIdentity(
      { ...policy, deniedUserIds: ["UALICE"] },
      alice.coreToken,
    ),
    undefined,
  );
  assert.equal(
    slackScopeAllowed(policy, { ...alice, agentId: "owner" }),
    undefined,
  );
  assert.equal(
    slackScopeAllowed(policy, { ...alice, tenantId: "owner" }),
    false,
  );
  assert.deepEqual(slackCapabilities, [
    "task.send",
    "history.read",
    "task.control",
    "files.read",
    "files.write",
  ]);
});
