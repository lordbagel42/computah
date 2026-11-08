import { createHmac } from "node:crypto";
import type { BusDispatch, BusScope } from "./bus.js";
import type { CoreSession, Scope } from "./core.js";
import { projectMessages } from "./http.js";

/** Explicit test/future proven-Fast host seam. Never imported by bus-main. */
export function coreBusDispatch(options: {
  secret: string;
  bind(scope: Scope): CoreSession;
}): BusDispatch {
  return async (scope: BusScope, input) => {
    const session = options.bind(scope);
    const admitted = await session.submit(
      session.interactionId,
      input.text,
      input.clientMutationId,
    );
    const result = await session.result(
      session.interactionId,
      admitted.submissionId,
      true,
    );
    const data = Buffer.from(JSON.stringify(admitted.submissionId)).toString(
      "base64url",
    );
    // Matches existing HTTP signed Submission handles, not a second result API.
    const principalKey = JSON.stringify([
      scope.tenantId,
      scope.userId,
      scope.agentId,
    ]);
    const signature = createHmac("sha256", options.secret)
      .update(JSON.stringify([principalKey, "submission", data]))
      .digest("base64url");
    const submissionId = `${data}.${signature}`;
    const status =
      result.submission.status === "done"
        ? "completed"
        : result.submission.status === "unanswered" &&
            ["aborted", "withdrawn"].includes(result.submission.reason)
          ? "cancelled"
          : "failed";
    const text =
      status === "completed"
        ? projectMessages(result.entries, submissionId)
            .filter((message) => message.role === "assistant")
            .flatMap((message) =>
              message.blocks.flatMap((block) =>
                block.kind === "text" ? [block.text] : [],
              ),
            )
            .join("")
        : null;
    return { submissionId, status, text };
  };
}
