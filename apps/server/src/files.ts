import { runtimeLog } from "@computah/observability";
import type { JsonValue } from "@earendil-works/chord";
import { type Context, withTelemetry } from "@earendil-works/chord/context";
import {
  defineExtension,
  type ToolExecutionApi,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import {
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-durable/tools";
import type { Scope } from "./core.js";

export type FileCapability = "files.read" | "files.write";

/** Native tools use Rivet Pi's default per-actor databaseEnv, never the host FS. */
export function createFileTools(options: {
  authorize(
    scope: Readonly<Scope>,
    capability: FileCapability,
  ): boolean | Promise<boolean>;
  scope(
    api: ToolExecutionApi,
    context: Context,
  ): Promise<Readonly<Scope> | null>;
}) {
  async function allowed(
    scope: Readonly<Scope>,
    grants: readonly FileCapability[],
  ) {
    try {
      for (const grant of grants)
        if (!(await options.authorize(Object.freeze({ ...scope }), grant)))
          return false;
      return true;
    } catch {
      return false;
    }
  }
  function protect<P extends object, D extends JsonValue>(
    native: ToolRegistration<P, D>,
    grants: readonly FileCapability[],
  ): ToolRegistration<P, D> {
    return {
      ...native,
      description: `${native.description} This path names a file in this Worker's private durable database, NOT the host filesystem, a repository, or another Worker's files.`,
      // Preserve native unsafe replay for mutations: an interrupted edit may already have landed.
      execute: (args, api, context) =>
        context.telemetry.startSpan(
          {
            name: `computah.files.${native.name}`,
            attributes: { "tool.name": native.name },
          },
          async (span) => {
            let outcome: "success" | "error" | "denied" | "cancelled" = "error";
            try {
              const scope = await options.scope(api, context);
              if (!scope || !(await allowed(scope, grants))) {
                outcome = "denied";
                throw new Error("Private file operation denied");
              }
              // Grants are checked at execution, independently of Task admission/discovery.
              if (context.abortSignal?.aborted) {
                outcome = "cancelled";
                throw new Error("Private file operation cancelled");
              }
              const result = await native.execute(
                args,
                api,
                withTelemetry(span, context),
              );
              outcome = result.isError ? "error" : "success";
              if (result.isError) span.setStatus({ status: "error" });
              return result;
            } catch (error) {
              if (context.abortSignal?.aborted) outcome = "cancelled";
              span.setStatus({ status: "error" });
              throw error;
            } finally {
              span.setAttributes({ outcome });
              runtimeLog(
                "operation.completed",
                {
                  operation:
                    native.name === "read"
                      ? "files.read"
                      : native.name === "write"
                        ? "files.write"
                        : "files.edit",
                  outcome,
                },
                outcome === "success" ? "info" : "warn",
              );
            }
          },
        ),
    };
  }
  const read = protect(createReadTool(), ["files.read"]);
  const write = protect(createWriteTool(), ["files.write"]);
  const edit = protect(createEditTool(), ["files.read", "files.write"]);
  const extension = defineExtension({
    name: "computah.files",
    tools: [read, write, edit],
  });
  return {
    extension,
    async available(scope: Readonly<Scope>) {
      const canRead = await allowed(scope, ["files.read"]);
      const canWrite = await allowed(scope, ["files.write"]);
      return [
        ...(canRead ? [read] : []),
        ...(canWrite ? [write] : []),
        ...(canRead && canWrite ? [edit] : []),
      ];
    },
  };
}
