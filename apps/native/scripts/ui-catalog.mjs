// Trusted json-render → Rune adapter. Model specs are data, never executable source.
import {
  createSpecStreamCompiler,
  defineCatalog,
  defineSchema,
  evaluateVisibility,
  resolveActionParam,
  resolveElementProps,
  validateSpec,
} from "@json-render/core";
import { z } from "zod";

export const CATALOG_VERSION = "computah.native@1";
const color = z.string().regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/);
export const style = z
  .object({
    width: z.number().min(0).max(1600).optional(),
    grow: z.number().min(0).max(10).optional(),
    padding: z.number().min(0).max(64).optional(),
    gap: z.number().min(0).max(64).optional(),
    radius: z.number().min(0).max(64).optional(),
    font_size: z.number().min(10).max(48).optional(),
    font_family: z.string().trim().min(1).max(128).optional(),
    weight: z.number().min(100).max(900).optional(),
    fill: color.optional(),
    color: color.optional(),
  })
  .strict();
export const theme = z
  .object({
    background: color,
    surface: color,
    text: color,
    muted: color,
    gap: z.number().min(0).max(64),
    padding: z.number().min(0).max(64),
    radius: z.number().min(0).max(64),
  })
  .strict();
const common = { style: style.optional() };
const props = (extra = {}) => z.object({ ...common, ...extra }).strict();
const components = {
  Row: {
    props: props(),
    description: "Horizontal native layout; children divide growing width.",
  },
  Column: {
    props: props(),
    description: "Vertical native layout. Use grow:0 for content-only groups.",
  },
  Card: {
    props: props(),
    description: "Rounded content-sized native surface.",
  },
  Divider: {
    props: props({ thickness: z.number().min(0.5).max(16).default(1) }),
    description:
      "Native horizontal rule; thickness defaults to 1, style.fill sets its color. No children.",
  },
  Text: {
    props: props({ text: z.string().max(16000) }),
    description: "Readable native text.",
  },
  Button: {
    props: props({ label: z.string().min(1).max(160) }),
    description:
      "Follow-up button. Bind on.press to chat.send with params.message; no shell actions.",
  },
  Table: {
    props: props({
      title: z.string().optional(),
      columns: z.array(z.string()).min(1).max(8),
      rows: z.array(z.array(z.string())).max(100),
    }),
    description:
      "Reusable native table with ordered columns/cells; illustrative unless supplied data.",
  },
  Restaurant: {
    props: props({
      name: z.string(),
      description: z.string(),
      timezone: z.string(),
    }),
    description:
      "Reusable restaurant card. Photos/hours unknown, not fabricated.",
  },
  Sidebar: {
    props: props({ text: z.string().default("Computah") }),
    description: "App-only saved chats and New conversation. One per app.",
  },
  Header: {
    props: props({ text: z.string() }),
    description: "App-only heading.",
  },
  Transcript: {
    props: props(),
    description: "App-only live conversation and inline cards. One per app.",
  },
  Composer: {
    props: props(),
    description: "App-only shared input and Send/Stop. One per app.",
  },
  Empty: {
    props: z.object({}).strict(),
    description:
      "App-only intentional blank root; independent Restore remains.",
  },
};
const schema = defineSchema((s) => ({
  spec: s.object({
    root: s.string(),
    elements: s.record(
      s.object({
        type: s.ref("catalog.components"),
        props: s.propsOf("catalog.components"),
        children: { ...s.array(s.string()), optional: true },
        visible: { ...s.any(), optional: true },
        on: { ...s.any(), optional: true },
      }),
    ),
    state: { ...s.any(), optional: true },
  }),
  catalog: s.object({
    components: s.map({ props: s.zod(), description: s.string() }),
    actions: s.map({ params: s.zod(), description: s.string() }),
  }),
}));
export const catalog = defineCatalog(schema, {
  components,
  actions: {
    "chat.send": {
      params: z.object({ message: z.string().min(1).max(8000) }).strict(),
      description: "Send a follow-up into this same conversation.",
    },
  },
});

// Privately compile actual SpecStream patches; no partially validated action is mounted.
export function compileStream(chunks) {
  const input = chunks.join("");
  if (Buffer.byteLength(input) > 128 * 1024)
    throw new Error("SpecStream exceeds budget");
  for (const line of input.split("\n").filter((line) => line.trim())) {
    const patch = JSON.parse(line);
    if (
      !["add", "replace", "remove", "move", "copy", "test"].includes(
        patch.op,
      ) ||
      typeof patch.path !== "string"
    )
      throw new Error("Invalid SpecStream operation");
    for (const pointer of [patch.path, patch.from].filter(
      (value) => value !== undefined,
    )) {
      if (
        typeof pointer !== "string" ||
        !pointer.startsWith("/") ||
        pointer
          .split("/")
          .some((key) =>
            ["__proto__", "constructor", "prototype"].includes(key),
          )
      )
        throw new Error("Unsafe patch pointer");
    }
    rejectUnsupported(patch.value);
  }
  const compiler = createSpecStreamCompiler();
  for (const chunk of chunks) compiler.push(chunk);
  compiler.push("\n");
  return compiler.getResult();
}

function rejectUnsupported(value) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (
      key.startsWith("$") &&
      !["$state", "$template", "$cond", "$then", "$else"].includes(key)
    )
      throw new Error(
        `Unsupported native directive ${key}; implement it in the project first.`,
      );
    if (["__proto__", "prototype", "constructor"].includes(key))
      throw new Error("Unsafe key");
    rejectUnsupported(child);
  }
}

export function materialize(input, surface = "card") {
  const spec =
    typeof input === "string" ? compileStream([input]) : structuredClone(input);
  if (Buffer.byteLength(JSON.stringify(spec)) > 128 * 1024)
    throw new Error("Spec exceeds 128 KiB");
  if (
    !spec ||
    typeof spec !== "object" ||
    !spec.elements ||
    Object.keys(spec.elements).length > 128
  )
    throw new Error("Invalid spec or node budget exceeded");
  rejectUnsupported(spec);
  const structural = validateSpec(spec, { checkOrphans: true });
  if (
    !structural.valid ||
    structural.issues.some((i) => i.code === "orphaned_element")
  )
    throw new Error(JSON.stringify(structural.issues));
  const context = { stateModel: spec.state ?? {} };
  const resolved = structuredClone(spec);
  for (const [id, element] of Object.entries(resolved.elements)) {
    if (!id || ["__proto__", "prototype", "constructor"].includes(id))
      throw new Error("Invalid element ID");
    if (element.repeat || element.watch || element.slots)
      throw new Error("Repeat/watch/slots require a native implementation");
    element.props = resolveElementProps(element.props ?? {}, context);
  }
  const admitted = catalog.validate(resolved);
  if (!admitted.success) throw new Error(admitted.error.message);
  const seen = new Set();
  const controls = new Set();
  function node(id, depth = 0) {
    if (depth > 12 || seen.has(id))
      throw new Error("Cycle/shared child/depth limit");
    seen.add(id);
    const element = resolved.elements[id];
    if (!element) throw new Error("Missing child");
    const definition = components[element.type];
    if (!definition) throw new Error(`Unknown component ${element.type}`);
    const p = definition.props.parse(element.props);
    if (
      surface === "card" &&
      ["Sidebar", "Header", "Transcript", "Composer", "Empty"].includes(
        element.type,
      )
    )
      throw new Error("Inline cards cannot mount app controls");
    if (["Sidebar", "Transcript", "Composer"].includes(element.type)) {
      if (controls.has(element.type)) throw new Error("Duplicate app control");
      controls.add(element.type);
    }
    const children = (element.children ?? [])
      .map((child) => node(child, depth + 1))
      .filter(Boolean);
    if (
      element.visible !== undefined &&
      !evaluateVisibility(element.visible, context)
    )
      return null;
    if (element.type === "Empty") {
      if (depth || children.length)
        throw new Error("Empty must be the sole app root");
      return null;
    }
    let data = null;
    if (element.type === "Divider") {
      if (children.length) throw new Error("Divider cannot have children");
      data = { thickness: p.thickness };
    }
    if (element.type === "Button") {
      const binding = element.on?.press;
      if (
        !binding ||
        Array.isArray(binding) ||
        binding.action !== "chat.send" ||
        Object.keys(element.on).some((k) => k !== "press") ||
        Object.keys(binding).some((k) => !["action", "params"].includes(k))
      )
        throw new Error("Button requires only host chat.send action");
      const params = Object.fromEntries(
        Object.entries(binding.params ?? {}).map(([k, v]) => [
          k,
          resolveActionParam(v, context),
        ]),
      );
      data = {
        prompt: catalog.data.actions["chat.send"].params.parse(params).message,
      };
    } else if (element.on)
      throw new Error("Only Button press actions are implemented");
    if (element.type === "Table") {
      if (p.rows.some((row) => row.length !== p.columns.length))
        throw new Error("Table width mismatch");
      data = { columns: p.columns, rows: p.rows };
    }
    if (element.type === "Restaurant")
      data = {
        name: p.name,
        description: p.description,
        timezone: p.timezone,
        photo: null,
        schedule: null,
      };
    return {
      kind: element.type.toLowerCase(),
      version: 1,
      id,
      text: p.text ?? p.label ?? p.title ?? "",
      style: p.style ?? {},
      data,
      children,
    };
  }
  const root = node(spec.root);
  if (seen.size !== Object.keys(spec.elements).length)
    throw new Error("Unreachable elements");
  if (surface === "card" && !root)
    throw new Error("An inline card cannot be blank");
  return { root, design: { catalog: CATALOG_VERSION, spec } };
}

export function renderReply(input, currentTheme) {
  if (input.catalog !== CATALOG_VERSION)
    throw new Error("Unsupported catalog version");
  if ((input.cards ?? []).length > 12)
    throw new Error("At most 12 inline cards");
  let count = 0;
  const cards = (input.cards ?? []).map((spec, index) => {
    const result = materialize(spec);
    function scope(node) {
      if (++count > 120) throw new Error("Aggregate card budget exceeded");
      node.id = `card-${index}-${node.id}`;
      node.children.forEach(scope);
    }
    scope(result.root);
    return { ...result.root, design: result.design };
  });
  let app = null;
  if (input.app) {
    const result = materialize(input.app.spec, "app");
    app = {
      version: 1,
      theme: theme.parse(input.app.theme ?? currentTheme),
      root: result.root,
      design: result.design,
    };
  }
  const reply = {
    message: z.string().max(16000).parse(input.message),
    cards,
    app,
  };
  if (Buffer.byteLength(JSON.stringify(reply)) > 128 * 1024)
    throw new Error("Materialized response too large");
  return reply;
}
