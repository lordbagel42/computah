export interface CapturePolicy {
  team: string;
  tenantId: string;
  userId: string;
  agentId: string;
  enrollment?: {
    deniedUserIds: string[];
    ownerSlackUserId: string;
  };
}

/** Authenticated uploader only; this predicate does not replace HMAC verification. */
export function captureScopeAllowed(
  report: {
    requestedBy: string;
    source: { team: string; channel: string };
    scope: { tenantId: string; userId: string; agentId: string };
  },
  policy: CapturePolicy,
): boolean {
  if (report.source.team !== policy.team) return false;
  const enrollment = policy.enrollment;
  if (enrollment?.deniedUserIds.includes(report.requestedBy)) return false;
  if (
    report.scope.tenantId === policy.tenantId &&
    report.scope.userId === policy.userId &&
    report.scope.agentId === policy.agentId
  )
    return (
      !enrollment ||
      (report.requestedBy === enrollment.ownerSlackUserId &&
        /^D[A-Z0-9]+$/.test(report.source.channel))
    );
  if (
    !enrollment ||
    !/^[UW][A-Z0-9]+$/.test(report.requestedBy) ||
    enrollment.deniedUserIds.includes(report.requestedBy)
  )
    return false;
  const channel = report.source.channel;
  const audience = /^D[A-Z0-9]+$/.test(channel)
    ? "private"
    : /^[CG][A-Z0-9]+$/.test(channel)
      ? `channel:${channel}`
      : null;
  return (
    audience !== null &&
    report.scope.tenantId === `slack:${policy.team}` &&
    report.scope.userId === report.requestedBy &&
    report.scope.agentId === audience
  );
}
