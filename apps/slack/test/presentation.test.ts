import assert from "node:assert/strict";
import { test } from "node:test";
import { presentSlack } from "../src/presentation.js";

test("safe labeled links become native links, but mentions, unsafe targets and code remain literal", () => {
  const message = presentSlack(
    [
      "*Useful*\n\n• [Mixed](https://example.com/Case?q=A&b=%2f)",
      "<https://example.com/B|Second & label>",
      "<@U123> <!here> <#C123|channel> &amp;",
      "[bad](javascript:alert) [secret](https://user:pass@example.com/)",
      "`[code](https://example.com/)`",
      "```\n  <https://example.com/|literal> \\n\n```",
    ].join("\n"),
  );
  const expected = [
    "*Useful*\n\n• <https://example.com/Case?q=A&amp;b=%2f|Mixed>",
    "<https://example.com/B|Second &amp; label>",
    "&lt;@U123&gt; &lt;!here&gt; &lt;#C123|channel&gt; &amp;amp;",
    "[bad](javascript:alert) [secret](https://user:pass@example.com/)",
    "`[code](https://example.com/)`",
    "```\n  &lt;https://example.com/|literal&gt; \\n\n```",
  ].join("\n");
  assert.equal(message.text, expected);
  assert.deepEqual(message.blocks, [
    {
      type: "section",
      text: { type: "mrkdwn", text: expected, verbatim: true },
    },
  ]);
});

test("adjacent, emphasized and parenthesized links keep exact independent targets and code boundaries", () => {
  for (const [source, expected] of [
    [
      "[A](https://a.test/a)[B](https://b.test/b)",
      "<https://a.test/a|A><https://b.test/b|B>",
    ],
    [
      "[A](https://a.test/a),[B](https://b.test/b)",
      "<https://a.test/a|A>,<https://b.test/b|B>",
    ],
    [
      "[A](https://a.test/a)`[code](https://b.test/b)`",
      "<https://a.test/a|A>`[code](https://b.test/b)`",
    ],
    ["*[Guide](https://example.com)*", "*<https://example.com|Guide>*"],
    ["([Guide](https://example.com))", "(<https://example.com|Guide>)"],
    [
      "[literal](https://example.com/a(b)c)",
      "[literal](https://example.com/a(b)c)",
    ],
  ]) {
    assert.equal(presentSlack(source).text, expected);
  }
});

test("long code preserves content and every section has complete fences", () => {
  const content = "  const x = '<&>';\\n\n".repeat(700);
  const expected = "  const x = '&lt;&amp;&gt;';\\n\n".repeat(700);
  const result = presentSlack(`\`\`\`js\n${content}\`\`\`\nAfter code.`);
  assert.equal(result.text, `\`\`\`js\n${expected}\`\`\`\nAfter code.`);
  assert.ok(result.blocks.length > 3);
  // Remove only the synthetic close/reopen pairs between sections.
  assert.equal(
    result.blocks
      .map((b) => b.text.text)
      .join("")
      .replaceAll("\n``````\n", ""),
    result.text,
  );
  for (const block of result.blocks) {
    assert.ok(block.text.text.length <= 3000);
    assert.equal((block.text.text.match(/```/g)?.length ?? 0) % 2, 0);
  }
});

test("escaped budget, section count, Unicode and indivisible tokens have truthful hard limits", () => {
  for (const source of [
    "<&😀 ".repeat(20000),
    `\`\`\`\n${"<&😀 ".repeat(20000)}`,
    `prefix \`${"x".repeat(3000)}\` suffix`,
    `prefix [huge](https://example.com/${"x".repeat(3000)}) suffix`,
    `[long](https://example.com/${"y".repeat(1400)}) `.repeat(30),
  ]) {
    const result = presentSlack(source);
    assert.match(result.text, /\[Answer shortened for Slack:/);
    assert.ok(result.text.length < 30000);
    assert.ok(result.blocks.length <= 20);
    assert.ok(
      result.blocks.every(
        (b) => b.text.text.length > 0 && b.text.text.length <= 3000,
      ),
    );
    assert.equal(Buffer.from(result.text).toString("utf8"), result.text);
    assert.ok(
      result.blocks.every(
        (b) => Buffer.from(b.text.text).toString("utf8") === b.text.text,
      ),
    );
    assert.ok(
      result.blocks.every(
        (b) => (b.text.text.match(/```/g)?.length ?? 0) % 2 === 0,
      ),
    );
  }
  assert.equal(presentSlack("a ".repeat(14500)).text, "a ".repeat(14500));
  assert.match(presentSlack("a ".repeat(14501)).text, /shortened/);
  assert.equal(presentSlack("x".repeat(12000)).text, "x".repeat(12000));
});
