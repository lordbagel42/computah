import { execFile } from "node:child_process";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  buildUI,
  editSource,
  ROOT,
  readSource,
  workspaceInfo,
  writeSource,
} from "./workspace.mjs";

const result = (text: unknown, details = {}) => ({
  content: [
    {
      type: "text" as const,
      text: typeof text === "string" ? text : JSON.stringify(text),
    },
  ],
  details,
});
async function ui(
  operation: string,
  input?: unknown,
  signal?: AbortSignal,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [path.join(ROOT, "scripts/ui-worker.mjs")],
      {
        cwd: ROOT,
        env: { PATH: process.env.PATH, LANG: "en_US.UTF-8" },
        timeout: 10000,
        maxBuffer: 2 * 1024 * 1024,
        signal,
      },
      (error, stdout, stderr) => {
        if (error) reject(new Error(stderr || "UI validation failed"));
        else {
          try {
            resolve(JSON.parse(stdout));
          } catch {
            reject(new Error("Invalid materializer output"));
          }
        }
      },
    );
    child.stdin!.end(JSON.stringify({ operation, input }));
  });
}
export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "inspect_ui",
    label: "Inspect UI",
    description:
      "Read the actual json-render catalog/schema and local project capabilities. Use before generating or extending UI.",
    parameters: Type.Object({}),
    async execute(_id, _p, signal) {
      return result({
        ...workspaceInfo(),
        ...(await ui("catalog", undefined, signal)),
      });
    },
  });
  pi.registerTool({
    name: "read_source",
    label: "Read source",
    description:
      "Read owned Computah UI source, catalog, or read-only pinned Rune API. No other files/credentials/history.",
    parameters: Type.Object({
      path: Type.String(),
      offset: Type.Optional(Type.Number()),
      limit: Type.Optional(Type.Number()),
    }),
    async execute(_id, p) {
      return result(readSource(p.path, p.offset, p.limit));
    },
  });
  pi.registerTool({
    name: "edit_source",
    label: "Edit source",
    description:
      "Exact single-match edit to owned source. Implement missing capabilities, not just apologies. Cannot edit tooling, dependencies or unrelated files.",
    parameters: Type.Object({
      path: Type.String(),
      old: Type.String(),
      replacement: Type.String(),
    }),
    async execute(_id, p) {
      return result(editSource(p.path, p.old, p.replacement));
    },
  });
  pi.registerTool({
    name: "write_source",
    label: "Write source",
    description:
      "Write an owned UI source file (including a new src/*.rs module) or catalog. Preserve history, recovery and tool boundaries.",
    parameters: Type.Object({ path: Type.String(), content: Type.String() }),
    async execute(_id, p) {
      return result(writeSource(p.path, p.content));
    },
  });
  pi.registerTool({
    name: "build_ui",
    label: "Build Computah",
    description:
      "Run fixed Rust formatter, Clippy, tests and locked build asynchronously. Success triggers host-owned state-preserving install/relaunch after this turn. Repair build errors and retry; no general shell.",
    parameters: Type.Object({}),
    async execute(_id, _p, signal, onUpdate) {
      const output = await buildUI(signal, (stage) =>
        onUpdate?.(result(stage)),
      );
      return result(output, { computah_build: true });
    },
  });
  pi.registerTool({
    name: "render_ui",
    label: "Render interface",
    description:
      "The ONLY generative UI API. Validate json-render0.22 catalog Spec(s) or SpecStream JSONL strings and materialize to native Rune. Changes auto-activate after this turn; no approval. Cards are inline; app is {theme,spec}. Empty component as app root intentionally blanks app. Use inspect_ui for catalog/schema. No executable code/URLs in UI data.",
    parameters: Type.Object({
      catalog: Type.String(),
      message: Type.String(),
      cards: Type.Optional(Type.Array(Type.Any())),
      app: Type.Optional(
        Type.Union([
          Type.Object({ theme: Type.Any(), spec: Type.Any() }),
          Type.Null(),
        ]),
      ),
    }),
    async execute(_id, p, signal) {
      const reply = await ui("render", p, signal);
      return result(
        "Validated. The host will activate this interface automatically at settlement.",
        { computah_reply: reply },
      );
    },
  });
}
