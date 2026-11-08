import assert from "node:assert/strict";
import { test } from "node:test";
import activate, { description } from "../.amp/plugins/computah-bugs.ts";

type API = Parameters<typeof activate>[0];
type Definition = Parameters<API["registerLinkPattern"]>[0];

function registration(): Definition {
  const definitions: Definition[] = [];
  const amp = {
    registerLinkPattern(definition: Definition) {
      definitions.push(definition);
      return { unsubscribe() {} };
    },
  };
  // Only this API is supplied: accessing any other host feature fails the test.
  activate(amp as API);
  assert.equal(definitions.length, 1);
  const definition = definitions[0];
  assert.ok(definition);
  return definition;
}

test("registers one supported link pattern and a static description", () => {
  assert.equal(typeof description, "string");
  assert.ok(description.length > 0 && description.length <= 300);
  assert.deepEqual(registration(), {
    id: "computah-bug",
    pattern: "computah_bug_[a-z0-9]{24}",
    href: "https://computah-issues.raygen.executor.website/#{{match}}",
  });
});

test("matches exactly the new ID token, not legacy UUIDs or malformed IDs", () => {
  const { pattern } = registration();
  // Full-token validation only. Amp, not the plugin, supplies transcript boundaries.
  const token = new RegExp(`^(?:${pattern})$`, "u");
  for (const suffix of [
    "a".repeat(24),
    "0".repeat(24),
    "abcd0123456789efghijklmn",
  ]) {
    assert.ok(token.test(`computah_bug_${suffix}`), suffix);
  }
  for (const invalid of [
    "",
    "123e4567-e89b-42d3-a456-426614174000",
    `computah_bug_${"a".repeat(23)}`,
    `computah_bug_${"a".repeat(25)}`,
    `computah_bug_${"A".repeat(24)}`,
    `COMPUTAH_BUG_${"a".repeat(24)}`,
    `xcomputah_bug_${"a".repeat(24)}`,
    `computah_bug_${"a".repeat(23)}_`,
    `computah_bug_${"a".repeat(23)}é`,
    `computah_bug_${"a".repeat(23)}-`,
    `computah_bug_${"a".repeat(24)}_extra`,
    "computah_bug_../../attacker.example/x",
    "computah_bug_<script>alert(1)</script>",
  ]) {
    assert.ok(!token.test(invalid), invalid);
  }
});

test("URL-encoded matches stay on the fixed HTTPS tracker origin and hash route", () => {
  const { pattern, href } = registration();
  const id = "computah_bug_abcd0123456789efghijklmn";
  const match = new RegExp(pattern, "u").exec(`See (${id}), please.`)?.[0];
  assert.equal(match, id);
  assert.ok(match);
  // Model the documented host substitution, not a plugin-owned renderer.
  const url = new URL(href.replace("{{match}}", encodeURIComponent(match)));
  assert.equal(url.protocol, "https:");
  assert.equal(url.origin, "https://computah-issues.raygen.executor.website");
  assert.equal(url.pathname, "/");
  assert.equal(url.hash, `#${id}`);
  assert.equal(url.search, "");
  assert.equal(url.username, "");
  assert.equal(url.password, "");
});
