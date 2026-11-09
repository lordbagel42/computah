import { oauthProviderResourceClient } from "@better-auth/oauth-provider/resource-client";
import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { canonicalOrigin, createAuth, operatorAllowed } from "./auth.js";
import { catalog } from "./catalog.js";
import { boundedBody, equalSecret } from "./security.js";
import { Telemetry, traceParent } from "./telemetry.js";

export async function handleMcp(request: Request, env: Env): Promise<Response> {
  let scopes: string[];
  const bearer =
    request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  if (equalSecret(bearer, env.AGENT_MCP_TOKEN)) {
    // Explicit operator automation credential, not capture/notice/bootstrap authority.
    scopes = ["issues:read", "issues:write", "traces:read"];
  } else {
    try {
      const auth = createAuth(env);
      const claims = await oauthProviderResourceClient(auth)
        .getActions()
        .verifyAccessTokenRequest(request, {
          jwksUrl: `${canonicalOrigin}/api/auth/jwks`,
          verifyOptions: {
            audience: `${canonicalOrigin}/mcp`,
            issuer: `${canonicalOrigin}/api/auth`,
            typ: "at+jwt",
          },
        });
      if (!claims.sub || !(await operatorAllowed(env, claims.sub)))
        return Response.json({ error: "Access denied" }, { status: 403 });
      scopes = typeof claims.scope === "string" ? claims.scope.split(" ") : [];
    } catch {
      return Response.json(
        { error: "Authentication required" },
        {
          status: 401,
          headers: {
            "WWW-Authenticate": `Bearer resource_metadata="${canonicalOrigin}/.well-known/oauth-protected-resource/mcp"`,
          },
        },
      );
    }
  }
  const server = new McpServer(
    { name: "computah-debugshare", version: "1.0.0" },
    {
      instructions:
        "Internal all-scopes operator tracker. IDs and payload filters are not authority. Preserve immutable report evidence; mutations require expectedRevision. Status resolved is not deployment proof. Never include credentials or hidden reasoning in notes.",
    },
  );
  const telemetry = new Telemetry(env.AXIOM_TELEMETRY_TOKEN);
  const invoke = async (
    name: string,
    input: unknown,
    carrier = request.headers.get("traceparent") ?? "",
  ) => {
    const response = await env.TRACKER.getByName("operator-tracker-v1").fetch(
      new Request(`${canonicalOrigin}/api/tools/${name}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-debug-operator": "authorized",
          traceparent: carrier,
        },
        body: JSON.stringify(input),
        signal: request.signal,
      }),
    );
    if (!response.ok)
      throw new Error("Issue not found, invalid input or conflicting revision");
    return response.json();
  };
  for (const [name, tool] of Object.entries(catalog)) {
    server.registerTool(
      name,
      {
        description: tool.description,
        inputSchema: tool.schema,
        annotations: {
          readOnlyHint: tool.scope !== "issues:write",
          destructiveHint: false,
          openWorldHint: false,
        },
      },
      async (input: unknown): Promise<CallToolResult> => {
        const span = telemetry.start(
          "computah.debugshare.mcp",
          traceParent(request.headers.get("traceparent")),
        );
        if (!scopes.includes(tool.scope)) {
          await span.end("denied");
          return {
            isError: true,
            content: [{ type: "text", text: "Required scope not granted" }],
          };
        }
        try {
          const result = await invoke(
            name,
            input,
            `00-${span.span.traceId}-${span.span.spanId}-01`,
          );
          await span.end(
            name === "get_issue_trace" && !env.AXIOM_TRACE_READ_TOKEN
              ? "not_configured"
              : "success",
          );
          return { content: [{ type: "text", text: JSON.stringify(result) }] };
        } catch {
          await span.end(request.signal.aborted ? "cancelled" : "error");
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: "Issue not found, invalid input or conflicting revision. Refresh before retrying a mutation.",
              },
            ],
          };
        }
      },
    );
  }
  server.registerResource(
    "contract",
    "computah-debug://contract",
    {
      description:
        "Tracker API authority, immutable snapshots, lifecycle and pagination contract",
      mimeType: "text/plain",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          text: "Operator-granted access only. Reports retain exact requester/workspace/audience and immutable IDs/snapshots. get_issue returns report and first200 events; issue_history paginates complete history. list_issues uses bounded keyset cursors; concurrent updates can move entries. update_issue/add_issue_note require expectedRevision; refresh after conflict. Private trace queries accept only recorded capture/transport correlations. Capture HMAC and notice ACK credentials never authorize MCP. No arbitrary SQL, APL, upstream URLs or secret export.",
          mimeType: "text/plain",
        },
      ],
    }),
  );
  server.registerResource(
    "issue",
    new ResourceTemplate("computah-debug://issues/{id}", { list: undefined }),
    {
      description: "Exact immutable report and investigation history",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      if (!scopes.includes("issues:read"))
        throw new Error("Required scope not granted");
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(
              await invoke("get_issue", { id: variables.id }),
            ),
          },
        ],
      };
    },
  );
  server.registerPrompt(
    "investigate-issue",
    {
      description:
        "Evidence-first investigation without claiming status equals deployed repair",
    },
    async () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: "Read the exact report ID with inspect_issue, page its history, and follow only stored capture/transport traces with get_issue_trace if granted. Separate evidence from hypotheses. Add concise evidence using add_issue_note with expectedRevision, preserving original snapshots. Report source shipment, deployment adoption and human/runtime acceptance separately; do not mark resolved from passing tests alone.",
          },
        },
      ],
    }),
  );
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    const body =
      request.method === "POST"
        ? JSON.parse(await boundedBody(request, 450_000))
        : undefined;
    return await transport.handleRequest(request, { parsedBody: body });
  } finally {
    await server.close();
  }
}
