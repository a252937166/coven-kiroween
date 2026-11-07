// Checks T-10 (key validation) and T-12 (AAD binding) from spec 05 design.
// Dependency-free: node:test plus built-in WebCrypto. Fixtures are fictional.
// fast-check versions of these properties are tracked in tasks 1.1 and 1.3.

import { test } from "node:test";
import assert from "node:assert/strict";

import { bytesEqual } from "../src/bytes.ts";
import {
  exportRawPublicKey,
  fingerprint,
  generateEphemeralKeyPair,
  importRawPublicKey,
  KeyValidationError,
} from "../src/keys.ts";
import {
  encodeApprovalAad,
  isWellFormedEnvelope,
  openApproval,
  openApproverShare,
  sealApproval,
  sealApproverShare,
  type ApprovalBinding,
} from "../src/envelope.ts";

const binding: ApprovalBinding = {
  petitionId: "pet-0001",
  itemId: "item-aws-root-fictional",
  sealVersionId: "8c2f0d6e-1b7a-4c3e-9d55-000000000001",
  requesterId: "user:robin@example.test",
  approverId: "user:sage@example.test",
};

const share = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);

async function requester() {
  const pair = await generateEphemeralKeyPair();
  const raw = await exportRawPublicKey(pair.publicKey);
  return { pair, raw };
}

test("T-12 approval envelope round-trips under its exact binding", async () => {
  const r = await requester();
  const env = await sealApproval(share, r.raw, binding);
  assert.ok(isWellFormedEnvelope(env));
  const out = await openApproval(env, r.pair.privateKey, r.raw, binding);
  assert.ok(bytesEqual(out, share));
});

test("T-12 changing any one of the five string fields fails", async () => {
  const r = await requester();
  const env = await sealApproval(share, r.raw, binding);
  for (const field of Object.keys(binding) as (keyof ApprovalBinding)[]) {
    const other = { ...binding, [field]: binding[field] + "x" };
    await assert.rejects(openApproval(env, r.pair.privateKey, r.raw, other), /authentication failed/, field);
  }
});

test("T-12 a different requester key (fingerprint) fails", async () => {
  const r = await requester();
  const mallory = await requester();
  const env = await sealApproval(share, r.raw, binding);
  // Right private key, wrong claimed public key -> different fingerprint in AAD and salt.
  await assert.rejects(openApproval(env, r.pair.privateKey, mallory.raw, binding));
  // Another requester's key pair cannot open it.
  await assert.rejects(openApproval(env, mallory.pair.privateKey, mallory.raw, binding));
});

test("T-12 any single bit flip in the ciphertext region fails", async () => {
  const r = await requester();
  const env = await sealApproval(share, r.raw, binding);
  for (let i = 66; i < env.length; i++) {
    const bad = env.slice();
    bad[i] ^= 0x01;
    await assert.rejects(openApproval(bad, r.pair.privateKey, r.raw, binding));
  }
});

test("T-12 AAD encoding is injective across field boundaries", async () => {
  const fp = await fingerprint((await requester()).raw);
  const a = encodeApprovalAad({ ...binding, petitionId: "ab", itemId: "c" }, fp);
  const b = encodeApprovalAad({ ...binding, petitionId: "a", itemId: "bc" }, fp);
  assert.ok(!bytesEqual(a, b));
});

test("approver share blob opens only for its approver and binding", async () => {
  const approver = await requester();
  const other = await requester();
  const b = { itemId: binding.itemId, sealVersionId: binding.sealVersionId, approverId: binding.approverId };
  const blob = await sealApproverShare(share, approver.raw, b);
  assert.ok(bytesEqual(await openApproverShare(blob, approver.pair.privateKey, approver.raw, b), share));
  await assert.rejects(openApproverShare(blob, other.pair.privateKey, other.raw, b));
  await assert.rejects(
    openApproverShare(blob, approver.pair.privateKey, approver.raw, { ...b, sealVersionId: "v2" }),
  );
});

test("T-10 malformed public keys are rejected", async () => {
  const good = (await requester()).raw;
  const cases: Uint8Array[] = [
    new Uint8Array(0),
    good.slice(0, 64),
    new Uint8Array([...good, 0]),
    new Uint8Array([0x02, ...good.slice(1, 33)]), // compressed form
    new Uint8Array([0x03, ...good.slice(1)]), // wrong prefix
    (() => {
      const off = good.slice();
      off[64] ^= 0x01; // off the curve
      return off;
    })(),
    new Uint8Array(65), // all zero
  ];
  for (const c of cases) {
    await assert.rejects(importRawPublicKey(c), KeyValidationError);
  }
  await importRawPublicKey(good);
});
