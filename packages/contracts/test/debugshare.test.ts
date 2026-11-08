import assert from "node:assert/strict";
import test from "node:test";
import { isDebugshareId } from "../src/index.js";

test("report identity accepts new opaque IDs and unchanged legacy UUIDv4 only", () => {
  for (const id of [
    "computah_bug_abcd0123456789efghijklmn",
    "computah_bug_000000000000000000000000",
    "12b42dd4-8123-4234-9234-123456789abc",
  ])
    assert.equal(isDebugshareId(id), true, id);
  for (const id of [
    null,
    1,
    "",
    "12b42dd4-8123-1234-9234-123456789abc",
    "computah_bug_abcd0123456789efghijklm",
    "computah_bug_abcd0123456789efghijklmno",
    "computah_bug_Abcd0123456789efghijklmn",
    "computah_bug_abcd0123456789efghijklm_",
    "computah_bug_abcd0123456789efghijklmé",
    "computah_bug_abcd0123456789efghijklmn\n",
    "12b42dd4-8123-4234-9234-123456789abc\n",
    "xcomputah_bug_abcd0123456789efghijklmn",
    "computah_bug_abcd0123456789efghijklmn/../../evil",
  ])
    assert.equal(isDebugshareId(id), false, String(id));
});
