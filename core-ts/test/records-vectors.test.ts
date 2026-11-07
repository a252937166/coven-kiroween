// Cross-language regression: core-ts record hashing must match the Python
// service byte for byte. Vectors live in fixtures/record-vectors.json and are
// also asserted by service/tests/test_records.py.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { canonicalJson, entryHash, GENESIS, verifyChain, type RecordEntry } from "../src/records.ts";

const doc = JSON.parse(readFileSync(new URL("../../fixtures/record-vectors.json", import.meta.url), "utf8"));

test("record vectors: canonical JSON and hashes match Python", async () => {
  let prev = GENESIS;
  for (const v of doc.vectors) {
    assert.equal(canonicalJson(v.entry), v.canonical, v.name);
    assert.equal(v.prev, prev, v.name);
    assert.equal(await entryHash(prev, v.entry), v.hash, v.name);
    prev = v.hash;
  }
  const chain: RecordEntry[] = doc.vectors.map((v: { entry: RecordEntry; hash: string }) => ({ ...v.entry, hash: v.hash }));
  assert.deepEqual(await verifyChain(chain), { ok: true });
});

test("U+007F is escaped like Python ensure_ascii", () => {
  assert.equal(canonicalJson("a\u007fb"), '"a\\u007fb"');
  assert.equal(canonicalJson("a~b"), '"a~b"');
});
