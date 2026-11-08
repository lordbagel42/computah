import assert from "node:assert/strict";
import test from "node:test";
import {
  CATALOG_VERSION,
  compileStream,
  materialize,
  renderReply,
} from "./ui-catalog.mjs";

const one = (type, props = {}, extra = {}) => ({
  root: "root",
  elements: { root: { type, props, ...extra } },
});
test("catalog resolves state, visibility and host follow-up action without executable handlers", () => {
  const spec = {
    root: "card",
    state: {
      title: "A real title",
      next: "Tell me about option B",
      show: false,
    },
    elements: {
      card: { type: "Card", props: {}, children: ["title", "hidden", "next"] },
      title: { type: "Text", props: { text: { $state: "/title" } } },
      hidden: {
        type: "Text",
        props: { text: "Hidden" },
        visible: { $state: "/show" },
      },
      next: {
        type: "Button",
        props: { label: "Option B" },
        on: {
          press: {
            action: "chat.send",
            params: { message: { $state: "/next" } },
          },
        },
      },
    },
  };
  const result = materialize(spec);
  assert.equal(result.root.children[0].text, "A real title");
  assert.deepEqual(
    result.root.children.map((n) => n.kind),
    ["text", "button"],
  );
  assert.equal(result.root.children[1].data.prompt, "Tell me about option B");
  assert.deepEqual(result.design, { catalog: CATALOG_VERSION, spec });
  spec.elements.next.on.press.action = "run";
  assert.throws(() => materialize(spec));
});

test("real SpecStream compiles across arbitrary chunk boundaries, fails on malformed final input", () => {
  const spec = one("Table", {
    columns: ["Plan", "Time"],
    rows: [
      ["Walk", "20m"],
      ["Museum", "90m"],
    ],
  });
  const stream =
    JSON.stringify({ op: "add", path: "/root", value: spec.root }) +
    "\n" +
    JSON.stringify({ op: "add", path: "/elements", value: spec.elements }) +
    "\n";
  for (const position of [1, 13, stream.length - 7]) {
    assert.deepEqual(
      compileStream([stream.slice(0, position), stream.slice(position)]),
      spec,
    );
  }
  assert.deepEqual(materialize(stream).root.data.rows, [
    ["Walk", "20m"],
    ["Museum", "90m"],
  ]);
  assert.throws(() => materialize(`${stream}{"op":`));
  assert.throws(() => compileStream(['{"op":"unknown","path":"/root"}']));
});

test("cards have independent IDs; blank app is legal but blank card/live controls are not", () => {
  const card = one("Restaurant", {
    name: "Illustrative Cafe",
    description: "Example only",
    timezone: "UTC",
  });
  const theme = {
    background: "#111214",
    surface: "#1c1e22",
    text: "#ededee",
    muted: "#a6a8b0",
    gap: 16,
    padding: 24,
    radius: 12,
  };
  const reply = renderReply({
    catalog: CATALOG_VERSION,
    message: "Two examples",
    cards: [card, card],
    app: { theme, spec: one("Empty") },
  });
  assert.notEqual(reply.cards[0].id, reply.cards[1].id);
  assert.equal(reply.app.root, null);
  assert.equal(reply.app.design.catalog, CATALOG_VERSION);
  assert.throws(() => materialize(one("Empty")));
  assert.throws(() => materialize(one("Composer")));
  assert.throws(() => renderReply({ catalog: "wrong@99", message: "x" }));
  assert.deepEqual(materialize(one("Divider", { thickness: 3 })).root.data, {
    thickness: 3,
  });
  assert.throws(() => materialize(one("Divider", { thickness: 17 })));
  assert.throws(() =>
    materialize(one("Text", { text: "x", style: { font_family: " " } })),
  );
});

test("rejects broken trees, unsupported directives and out-of-budget styling without partial output", () => {
  assert.throws(() =>
    materialize(one("Text", { text: "x", style: { gap: 65 } })),
  );
  assert.throws(() =>
    materialize(one("Text", { text: "x" }, { children: ["root"] })),
  );
  assert.throws(() =>
    materialize(one("Text", { text: "x" }, { children: ["missing"] })),
  );
  assert.throws(() => materialize(one("Text", { text: "x" }, { watch: {} })));
  assert.throws(() => materialize(one("Text", { text: { $unknown: "x" } })));
  assert.throws(() =>
    materialize(one("Table", { columns: ["A"], rows: [["one", "two"]] })),
  );
  const orphan = one("Text", { text: "x" });
  orphan.elements.extra = { type: "Text", props: { text: "Orphan" } };
  assert.throws(() => materialize(orphan));
});
