// Proposal invariants 1 and 3; spec 05 BG-02.1 / BG-02.4 (T-07) for item-level sharing.
// fast-check properties over the real library and encodings. Fictional data only.

import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import { bytesEqual } from "../src/bytes.ts";
import { aad, checkKeyHeader, generateKey, HeaderCheckError, makeKeyHeader } from "../src/envelope.ts";
import {
  combineShares,
  decodeQrPayload,
  decodeShareText,
  decodeWordCode,
  encodeQrPayload,
  encodeWordCode,
  shareIndex,
  ShareError,
  shareTag,
  splitKey,
} from "../src/shares.ts";
import { openCredential, sealCredential } from "../src/vault.ts";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

test("inv-1 any k distinct shares rebuild the key and pass the header check", async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 2, max: 6 }), fc.integer({ min: 0, max: 4 }), fc.integer(), async (k, extra, seed) => {
      const n = k + extra;
      const key = generateKey();
      const header = await makeKeyHeader(key, aad.llHeader("v"));
      const shares = await splitKey(key, n, k);
      const pick = fc.sample(fc.shuffledSubarray(shares, { minLength: k, maxLength: k }), { numRuns: 1, seed })[0];
      const rebuilt = await combineShares(pick, k);
      assert.ok(bytesEqual(rebuilt, key));
      await checkKeyHeader(rebuilt, header, aad.llHeader("v"));
    }),
    { numRuns: 40 },
  );
});

test("inv-1 k-1 shares plus a wrong, foreign or malformed share fail the header check or are refused", async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 2, max: 5 }), fc.constantFrom("wrong", "foreign", "duplicate", "short"), async (k, kind) => {
      const key = generateKey();
      const header = await makeKeyHeader(key, aad.llHeader("v"));
      const shares = await splitKey(key, k + 1, k);
      const base = shares.slice(0, k - 1);
      let bad: Uint8Array;
      if (kind === "wrong") {
        bad = shares[k - 1].slice();
        bad[0] ^= 0x01;
      } else if (kind === "foreign") {
        const other = await splitKey(generateKey(), k + 1, k);
        bad = other.find((s) => !base.some((b) => shareIndex(b) === shareIndex(s)))!;
      } else if (kind === "duplicate") {
        bad = base[0].slice();
      } else {
        bad = shares[k - 1].slice(1);
      }
      let opened = false;
      try {
        const rebuilt = await combineShares([...base, bad], k);
        await checkKeyHeader(rebuilt, header, aad.llHeader("v"));
        opened = true;
      } catch (e) {
        assert.ok(e instanceof HeaderCheckError || e instanceof ShareError, String(e));
      }
      assert.equal(opened, false);
    }),
    { numRuns: 60 },
  );
});

test("inv-1 fewer than k shares are refused before combining", async () => {
  const shares = await splitKey(generateKey(), 5, 3);
  await assert.rejects(combineShares(shares.slice(0, 2), 3), ShareError);
});

test("inv-3 QR payload and word code round-trip", async () => {
  await fc.assert(
    fc.asyncProperty(fc.uint8Array({ minLength: 2, maxLength: 64 }), fc.string(), async (share, scope) => {
      const tag = await shareTag(scope);
      for (const text of [encodeQrPayload(tag, share), encodeWordCode(tag, share)]) {
        const d = decodeShareText(text);
        assert.ok(bytesEqual(d.tag, tag));
        assert.ok(bytesEqual(d.share, share));
      }
    }),
  );
});

test("inv-3 word code is case- and separator-insensitive", async () => {
  const tag = await shareTag("vault-x");
  const share = new Uint8Array(33).map((_, i) => i * 7);
  const code = encodeWordCode(tag, share);
  const typed = code.toLowerCase().replace(/-/g, " ");
  assert.ok(bytesEqual(decodeWordCode(typed).share, share));
});

test("inv-3 the checksum detects every single-symbol substitution", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.uint8Array({ minLength: 33, maxLength: 33 }),
      fc.nat(),
      fc.integer({ min: 1, max: 31 }),
      async (share, posSeed, delta) => {
        const tag = await shareTag("vault-y");
        const symbols = encodeWordCode(tag, share).replace(/-/g, "").split("");
        const pos = posSeed % symbols.length;
        const v = CROCKFORD.indexOf(symbols[pos]);
        symbols[pos] = CROCKFORD[(v + delta) % 32];
        assert.throws(() => decodeWordCode(symbols.join("")), ShareError);
      },
    ),
    { numRuns: 300 },
  );
});

test("inv-3 the checksum detects swaps of two adjacent different symbols", async () => {
  await fc.assert(
    fc.asyncProperty(fc.uint8Array({ minLength: 33, maxLength: 33 }), fc.nat(), async (share, posSeed) => {
      const tag = await shareTag("vault-z");
      const symbols = encodeWordCode(tag, share).replace(/-/g, "").split("");
      const pos = posSeed % (symbols.length - 1);
      fc.pre(symbols[pos] !== symbols[pos + 1]);
      [symbols[pos], symbols[pos + 1]] = [symbols[pos + 1], symbols[pos]];
      assert.throws(() => decodeWordCode(symbols.join("")), ShareError);
    }),
    { numRuns: 200 },
  );
});

test("inv-3 malformed QR text is refused", () => {
  assert.throws(() => decodeQrPayload("coven1:!!!"), ShareError);
  assert.throws(() => decodeQrPayload("coven2:AAAA"), ShareError);
  assert.throws(() => decodeShareText("coven1:AQ"), ShareError);
});

test("T-07 each seal version has a fresh key and share set; old material fails the new version", async () => {
  const itemId = "item-aws-root-fictional";
  const v1 = await sealCredential(itemId, "fictional-root-password-v1", 4, 2);
  const v2 = await sealCredential(itemId, "fictional-root-password-v2", 4, 2);
  assert.notEqual(v1.sealVersionId, v2.sealVersionId);
  assert.ok(!v1.shares.some((a) => v2.shares.some((b) => bytesEqual(a, b))));

  const k1 = await combineShares(v1.shares.slice(0, 2), 2);
  const k2 = await combineShares(v2.shares.slice(1, 3), 2);
  assert.ok(!bytesEqual(k1, k2));
  assert.equal(await openCredential(k1, itemId, v1.sealVersionId, v1.header, v1.ciphertext), "fictional-root-password-v1");
  assert.equal(await openCredential(k2, itemId, v2.sealVersionId, v2.header, v2.ciphertext), "fictional-root-password-v2");

  // The old key against the new version.
  await assert.rejects(openCredential(k1, itemId, v2.sealVersionId, v2.header, v2.ciphertext), HeaderCheckError);
  // The new header under the old version's ID (version binding in the header AAD).
  await assert.rejects(openCredential(k2, itemId, v1.sealVersionId, v2.header, v2.ciphertext), HeaderCheckError);
  // Old shares mixed with new shares.
  const mixedX = v2.shares.find((s) => shareIndex(s) !== shareIndex(v1.shares[0]))!;
  try {
    const mixed = await combineShares([v1.shares[0], mixedX], 2);
    await assert.rejects(openCredential(mixed, itemId, v2.sealVersionId, v2.header, v2.ciphertext), HeaderCheckError);
  } catch (e) {
    assert.ok(e instanceof ShareError);
  }
});
