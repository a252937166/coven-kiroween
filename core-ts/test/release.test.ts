// Spec 05 T-13 (client rejection) and T-07 (old version material fails), plus the
// Last Light recovery package path. Fictional data only.

import { test } from "node:test";
import assert from "node:assert/strict";

import { toBase64 } from "../src/bytes.ts";
import { sealApproval, sealRecoveryShare } from "../src/envelope.ts";
import { exportRawPublicKey, generateEphemeralKeyPair } from "../src/keys.ts";
import { openRecovery, openRelease, ReleaseError, type LocalPetition, type ReleasePackage } from "../src/release.ts";
import { sealCredential, sealVaultItem, sealVaultKey } from "../src/vault.ts";

const itemId = "aws-root";
const approvers = ["user:sage", "user:rowan", "user:ash", "user:wren"];

async function setup(petitionId = "pet-1") {
  const sealed = await sealCredential(itemId, "fictional-root-password", 4, 2);
  const pair = await generateEphemeralKeyPair();
  const publicKey = await exportRawPublicKey(pair.publicKey);
  const local: LocalPetition = {
    petitionId,
    itemId,
    sealVersionId: sealed.sealVersionId,
    requesterId: "user:robin",
    publicKey,
    privateKey: pair.privateKey,
  };
  const envFor = async (i: number, overrides: Partial<{ petitionId: string; approverId: string; requesterId: string }> = {}) =>
    toBase64(
      await sealApproval(sealed.shares[i], publicKey, {
        petitionId: overrides.petitionId ?? petitionId,
        itemId,
        sealVersionId: sealed.sealVersionId,
        requesterId: overrides.requesterId ?? "user:robin",
        approverId: overrides.approverId ?? approvers[i],
      }),
    );
  const pkg = async (envelopes: { approver_id: string; envelope: string }[]): Promise<ReleasePackage> => ({
    seal_version_id: sealed.sealVersionId,
    threshold: 2,
    item_header: toBase64(sealed.header),
    item_ciphertext: toBase64(sealed.ciphertext),
    envelopes,
  });
  return { sealed, local, envFor, pkg };
}

test("T-13 a valid package opens exactly the sealed credential", async () => {
  const s = await setup();
  const p = await s.pkg([
    { approver_id: approvers[0], envelope: await s.envFor(0) },
    { approver_id: approvers[2], envelope: await s.envFor(2) },
  ]);
  assert.equal(await openRelease(s.local, p), "fictional-root-password");
});

test("T-13 swapped approver labels are rejected", async () => {
  const s = await setup();
  const p = await s.pkg([
    { approver_id: approvers[1], envelope: await s.envFor(0) },
    { approver_id: approvers[0], envelope: await s.envFor(1) },
  ]);
  await assert.rejects(openRelease(s.local, p), ReleaseError);
});

test("T-13 duplicated approver is rejected", async () => {
  const s = await setup();
  const e = await s.envFor(0);
  await assert.rejects(
    openRelease(s.local, await s.pkg([{ approver_id: approvers[0], envelope: e }, { approver_id: approvers[0], envelope: e }])),
    /same approver/,
  );
});

test("T-13 an envelope from another petition or for another requester is rejected", async () => {
  const s = await setup();
  for (const bad of [await s.envFor(1, { petitionId: "pet-2" }), await s.envFor(1, { requesterId: "user:kit" })]) {
    const p = await s.pkg([
      { approver_id: approvers[0], envelope: await s.envFor(0) },
      { approver_id: approvers[1], envelope: bad },
    ]);
    await assert.rejects(openRelease(s.local, p), /does not match this request/);
  }
});

test("T-13 too few envelopes are rejected", async () => {
  const s = await setup();
  await assert.rejects(openRelease(s.local, await s.pkg([{ approver_id: approvers[0], envelope: await s.envFor(0) }])), /need 2/);
});

test("T-07 a package claiming another version is rejected before any decryption", async () => {
  const s = await setup();
  const p = await s.pkg([
    { approver_id: approvers[0], envelope: await s.envFor(0) },
    { approver_id: approvers[1], envelope: await s.envFor(1) },
  ]);
  p.seal_version_id = crypto.randomUUID();
  await assert.rejects(openRelease(s.local, p), /different seal version/);
});

test("Last Light recovery package opens available items and reports withheld ones", async () => {
  const vaultId = crypto.randomUUID();
  const { vaultKey, header, shares } = await sealVaultKey(vaultId, 5, 3);
  const a = await sealVaultItem(vaultKey, vaultId, "letter", "Dear family (fictional)");
  const pair = await generateEphemeralKeyPair();
  const publicKey = await exportRawPublicKey(pair.publicKey);
  const local = { recoveryId: "rec-1", vaultId, recovererId: "user:ada", publicKey, privateKey: pair.privateKey };
  const trustees = ["user:ada", "user:bram", "user:cleo"];
  const envelopes = [];
  for (let i = 0; i < 3; i++) {
    envelopes.push({
      trustee_id: trustees[i],
      envelope: toBase64(await sealRecoveryShare(shares[i], publicKey, { ...local, trusteeId: trustees[i] })),
    });
  }
  const res = await openRecovery(local, {
    vault_id: vaultId,
    threshold: 3,
    header: toBase64(header),
    envelopes,
    items: [
      { item_id: "letter", label: "Letter", deliver_to: ["Ada"], earliest_release: null, wrapped_key: toBase64(a.wrappedKey), ciphertext: toBase64(a.ciphertext) },
      { item_id: "later", label: "Later", deliver_to: [], earliest_release: "2099-01-01", withheld: true },
    ],
  });
  assert.equal(res.items[0].body, "Dear family (fictional)");
  assert.equal(res.items[1].withheld, true);
  assert.equal(res.items[1].body, null);
  assert.deepEqual(res.failed, []);
  // A recovery envelope replayed into another recovery fails.
  await assert.rejects(
    openRecovery({ ...local, recoveryId: "rec-2" }, { vault_id: vaultId, threshold: 3, header: toBase64(header), envelopes, items: [] }),
    ReleaseError,
  );
});

// --- Last Light: one bad contribution must not block the others --------------

import { RecoveryIncompleteError } from "../src/release.ts";
import { splitKey } from "../src/shares.ts";
import { generateKey } from "../src/envelope.ts";

async function llSetup() {
  const vaultId = crypto.randomUUID();
  const { vaultKey, header, shares } = await sealVaultKey(vaultId, 5, 3);
  const item = await sealVaultItem(vaultKey, vaultId, "letter", "Dear family (fictional)");
  const pair = await generateEphemeralKeyPair();
  const publicKey = await exportRawPublicKey(pair.publicKey);
  const local = { recoveryId: "rec-1", vaultId, recovererId: "user:ada", publicKey, privateKey: pair.privateKey };
  const trustees = ["user:ada", "user:bram", "user:cleo", "user:dov", "user:esme"];
  const seal = async (i: number, share: Uint8Array = shares[i], recoveryId = local.recoveryId) => ({
    trustee_id: trustees[i],
    envelope: toBase64(await sealRecoveryShare(share, publicKey, { ...local, recoveryId, trusteeId: trustees[i] })),
  });
  const pkg = (envelopes: { trustee_id: string; envelope: string }[]) => ({
    vault_id: vaultId,
    threshold: 3,
    header: toBase64(header),
    envelopes,
    items: [{ item_id: "letter", label: "Letter", deliver_to: [], earliest_release: null, wrapped_key: toBase64(item.wrappedKey), ciphertext: toBase64(item.ciphertext) }],
  });
  return { local, seal, pkg };
}

test("Last Light: an envelope bound to another recovery is set aside; the other three open the vault", async () => {
  const s = await llSetup();
  const res = await openRecovery(s.local, s.pkg([await s.seal(0), await s.seal(1), await s.seal(2, undefined, "rec-other"), await s.seal(3)]));
  assert.equal(res.items[0].body, "Dear family (fictional)");
  assert.deepEqual(res.failed, ["user:cleo"]);
  assert.deepEqual(res.used, ["user:ada", "user:bram", "user:dov"]);
});

test("Last Light: with only three contributions and one bad, the error names it and nothing opens", async () => {
  const s = await llSetup();
  await assert.rejects(openRecovery(s.local, s.pkg([await s.seal(0), await s.seal(1), await s.seal(2, undefined, "rec-other")])), (e: unknown) => {
    assert.ok(e instanceof RecoveryIncompleteError);
    assert.deepEqual(e.failed, ["user:cleo"]);
    assert.equal(e.usable, 2);
    return true;
  });
});

test("Last Light: a contribution that decrypts but carries a wrong share is skipped by the header check", async () => {
  const s = await llSetup();
  const foreign = (await splitKey(generateKey(), 5, 3))[2];
  const four = [await s.seal(0), await s.seal(1), await s.seal(2, foreign), await s.seal(3)];
  const res = await openRecovery(s.local, s.pkg(four));
  assert.equal(res.items[0].body, "Dear family (fictional)");
  assert.ok(!res.used.includes("user:cleo"));
  await assert.rejects(openRecovery(s.local, s.pkg(four.slice(0, 3))), RecoveryIncompleteError);
});
