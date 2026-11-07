// End-to-end: real core-ts cryptography through the real Python service over HTTP.
// Covers proposal acceptance scenarios 1 to 4 at the API level. Fictional data only.
// Each "browser" is an Api with its own cookie jar plus a MemoryKeyStore.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

import { Api, ApiError } from "../src/api.ts";
import { MemoryKeyStore } from "../src/keystore.ts";
import { advanceClock, checkChain, mail } from "../src/common.ts";
import * as bg from "../src/breakglass.ts";
import * as ll from "../src/lastlight.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const python = join(root, "service/.venv/bin/python");
let proc: ChildProcess;
let base = "";
let logs = "";

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

before(async () => {
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), "coven-e2e-"));
  proc = spawn(python, ["-m", "coven_service", "--port", String(port), "--db", join(dir, "e2e.sqlite")], {
    cwd: join(root, "service"),
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout!.on("data", (d) => (logs += d));
  proc.stderr!.on("data", (d) => (logs += d));
  base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(base + "/api/personas");
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error("service did not start:\n" + logs);
});

after(() => {
  proc?.kill();
});

const browser = (app: "break-glass" | "last-light") => ({ api: new Api({ base, app, cookieJar: true }), ks: new MemoryKeyStore() });

test("Break Glass: quorum, duplicates, single-item release, rotation, expiry (scenarios 2 and 3)", async () => {
  // One browser holds every persona, like the judge's demo.
  const { api, ks } = browser("break-glass");
  await bg.setupDemo(api, ks);

  await api.signIn("user:robin");
  const p = await bg.openPetition(api, ks, "user:robin", "aws-root", "Prod DB locked out (fictional)", 900);
  assert.equal(p.state, "Open");

  await api.signIn("user:sage");
  assert.equal((await bg.approvePetition(api, ks, "user:sage", p.petition_id)).counted, true);
  assert.equal((await bg.approvePetition(api, ks, "user:sage", p.petition_id)).counted, false);

  await api.signIn("user:robin");
  await assert.rejects(api.get(`/api/bg/petitions/${p.petition_id}/release`), (e: unknown) => e instanceof ApiError && e.status === 409);

  await api.signIn("user:rowan");
  const done = await bg.approvePetition(api, ks, "user:rowan", p.petition_id);
  assert.equal(done.status.state, "Approved");

  // Another engineer cannot use the link.
  await api.signIn("user:kit");
  await assert.rejects(api.get(`/api/bg/petitions/${p.petition_id}/release`), (e: unknown) => e instanceof ApiError && e.status === 404);

  await api.signIn("user:robin");
  const r = await bg.retrieve(api, ks, p.petition_id);
  assert.equal(r.secret, bg.DEMO_ITEMS[0].secret);
  assert.match(r.notice, /stays valid until you rotate it/);
  // The ephemeral key is gone after local decryption.
  assert.equal(await bg.hasLocalKey(ks, p.petition_id), false);

  // Other items stay sealed: no petition, no material.
  const items = await bg.listItems(api);
  assert.equal(items.find((i) => i.item_id === "aws-root")!.rotation_state, "rotation_required");
  assert.equal(items.find((i) => i.item_id === "registrar-codes")!.rotation_state, "none");

  await bg.confirmRotation(api, "aws-root");
  assert.equal((await bg.listItems(api)).find((i) => i.item_id === "aws-root")!.rotation_state, "rotated");

  // Scenario 3: expiry. A new petition reaches quorum, then the window ends.
  const q = await bg.openPetition(api, ks, "user:robin", "registrar-codes", "Registrar locked (fictional)", 120);
  for (const a of ["user:ash", "user:wren"]) {
    await api.signIn(a);
    await bg.approvePetition(api, ks, a, q.petition_id);
  }
  await advanceClock(api, 120);
  await api.signIn("user:robin");
  await assert.rejects(bg.retrieve(api, ks, q.petition_id), (e: unknown) => e instanceof ApiError && e.status === 410);
  assert.equal((await bg.petition(api, q.petition_id)).state, "Expired");

  // Reseal: a petition on the old version is invalidated; old release material cannot open the new version.
  const s = await bg.openPetition(api, ks, "user:robin", "release-signing", "Need to sign hotfix (fictional)", 900);
  await api.signIn("user:quinn");
  const res = await bg.sealItem(api, "release-signing", "rotated-passphrase (fictional)", bg.APPROVERS, 2);
  assert.deepEqual(res.invalidated_petitions, [s.petition_id]);
  await api.signIn("user:robin");
  assert.equal((await bg.petition(api, s.petition_id)).state, "Invalidated");

  const chain = await checkChain(api, "bg", (await api.get<{ receipt: { length: number; head: string } }>("/api/records/bg")).receipt);
  assert.equal(chain.outcome, "consistent");
  assert.ok(chain.internallyConsistent);
});

test("Last Light: check-in cancels, recovery with a typed card code, offline CLI (scenarios 1 and 4)", async () => {
  const { api, ks } = browser("last-light");
  const vaultId = await ll.setupDemo(api, ks);

  // Each trustee prints a card from their own share, in their own browser.
  const cards: Record<string, ll.CardContent> = {};
  for (const t of ll.TRUSTEES) {
    await api.signIn(t);
    cards[t] = await ll.myCard(api, ks, t, vaultId);
    await ll.recordCardIssued(api, vaultId);
  }

  await api.signIn(ll.OWNER);
  await advanceClock(api, 34 * 86400);
  assert.equal((await ll.vault(api, vaultId)).state, "Vigil");
  assert.equal((await ll.checkIn(api, vaultId)).state, "Lit");
  await advanceClock(api, 47 * 86400);
  assert.equal((await ll.vault(api, vaultId)).state, "Handover");

  await api.signIn("user:ada");
  let status = await ll.beginRecovery(api, ks, "user:ada", vaultId);
  await ll.submitShare(api, ks, "user:ada", status);
  await api.signIn("user:bram");
  status = await ll.vault(api, vaultId);
  // Bram types the word code from his printed card.
  await ll.submitShare(api, ks, "user:bram", status, cards["user:bram"].words.toLowerCase());
  await api.signIn("user:ada");
  await assert.rejects(ll.completeRecovery(api, ks, status.recovery!.recovery_id), (e: unknown) => e instanceof ApiError && e.status === 409);
  await api.signIn("user:cleo");
  await ll.submitShare(api, ks, "user:cleo", await ll.vault(api, vaultId), cards["user:cleo"].qr);
  await api.signIn("user:ada");
  const opened = await ll.completeRecovery(api, ks, status.recovery!.recovery_id);
  assert.match(opened.items[0].body!, /blue pumpkin/);
  assert.equal(opened.items[2].withheld, true);
  assert.equal((await ll.vault(api, vaultId)).state, "Released");
  const inbox = await mail(api);
  assert.ok(inbox.some((m) => /released/.test(m.subject)));

  // Scenario 4: bundle + offline CLI with printed-card text; wrong and duplicate shares rejected.
  const b = await ll.bundle(api, vaultId);
  const dir = mkdtempSync(join(tmpdir(), "coven-bundle-"));
  const path = join(dir, "bundle.json");
  writeFileSync(path, JSON.stringify(b));
  const cli = join(root, "core-ts/bin/recover.js");
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
  const two = run(path, "--share", cards["user:dov"].words, "--share", cards["user:esme"].qr);
  assert.equal(two.status, 1);
  const dup = run(path, "--share", cards["user:dov"].words, "--share", cards["user:dov"].qr, "--share", cards["user:esme"].qr);
  assert.match(dup.stderr, /share 2: duplicate share/);
  const ok = run(path, "--share", cards["user:dov"].words, "--share", cards["user:esme"].qr, "--share", cards["user:ada"].words);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /blue pumpkin/);
  assert.match(ok.stdout, /Happy birthday, Esme/); // offline recovery ignores the earliest date
  const bj = JSON.parse(readFileSync(path, "utf8"));
  const verify = run("verify", path, "--receipt", `${bj.record.receipt.length}:${bj.record.receipt.head}`);
  assert.equal(verify.status, 0, verify.stdout + verify.stderr);

  // GR-LOG / AG-01 rehearsal: no share text or raw share appears in service logs or the bundle.
  const bundleText = readFileSync(path, "utf8");
  for (const c of Object.values(cards)) {
    for (const s of [c.qr, c.words, c.words.replace(/-/g, ""), c.qr.slice(7)]) {
      assert.ok(!logs.includes(s), "share text in service logs");
      assert.ok(!bundleText.includes(s), "share text in bundle");
    }
  }
  assert.match(logs, /route=\/api\/ll\/recoveries\/\{rid\}\/package/);
});

import { fromBase64, toBase64 } from "@coven/core-ts/bytes";
import { openTrusteeShare, sealRecoveryShare } from "@coven/core-ts/envelope";
import { RecoveryIncompleteError } from "@coven/core-ts/release";
import { requireKey } from "../src/common.ts";

test("Last Light: one undecryptable contribution after release, a supplement, then a retry (real envelopes)", async () => {
  const { api, ks } = browser("last-light");
  await api.post("/api/demo/reset");
  const vaultId = await ll.setupDemo(api, ks);
  await advanceClock(api, 48 * 86400);

  await api.signIn("user:ada");
  let status = await ll.beginRecovery(api, ks, "user:ada", vaultId);
  const rid = status.recovery!.recovery_id;
  await ll.submitShare(api, ks, "user:ada", status);
  await api.signIn("user:bram");
  await ll.submitShare(api, ks, "user:bram", await ll.vault(api, vaultId));

  // Cleo's real share, sealed under the wrong recovery ID: shape-valid, so the service accepts it.
  await api.signIn("user:cleo");
  status = await ll.vault(api, vaultId);
  const cleo = await requireKey(ks, "user:cleo");
  const { share_blob } = await api.get<{ share_blob: string }>(`/api/ll/vaults/${vaultId}/my-share`);
  const share = await openTrusteeShare(fromBase64(share_blob), cleo.privateKey, cleo.publicKey, { vaultId, trusteeId: "user:cleo" });
  const bad = await sealRecoveryShare(share, fromBase64(status.recovery!.public_key), {
    recoveryId: "not-this-recovery",
    vaultId,
    recovererId: "user:ada",
    trusteeId: "user:cleo",
  });
  await api.post(`/api/ll/recoveries/${rid}/shares`, { envelope: toBase64(bad) });

  // The package is served (vault becomes Released), but this browser cannot rebuild the key yet.
  await api.signIn("user:ada");
  await assert.rejects(ll.completeRecovery(api, ks, rid), (e: unknown) => {
    assert.ok(e instanceof RecoveryIncompleteError);
    assert.deepEqual(e.failed, ["user:cleo"]);
    assert.equal(e.usable, 2);
    return true;
  });
  assert.equal((await ll.vault(api, vaultId)).state, "Released");

  // The owner cannot undo a release by checking in.
  await api.signIn(ll.OWNER);
  await assert.rejects(ll.checkIn(api, vaultId), (e: unknown) => e instanceof ApiError && e.status === 409);

  // Cleo cannot replace her contribution; Dov adds his share to the same recovery.
  await api.signIn("user:cleo");
  const again = await ll.submitShare(api, ks, "user:cleo", await ll.vault(api, vaultId));
  assert.equal(again.counted, false);
  await api.signIn("user:dov");
  const sup = await ll.submitShare(api, ks, "user:dov", await ll.vault(api, vaultId));
  assert.equal(sup.counted, true);

  await api.signIn("user:ada");
  const opened = await ll.completeRecovery(api, ks, rid);
  assert.match(opened.items[0].body!, /blue pumpkin/);
  assert.deepEqual(opened.failed, ["user:cleo"]);
  assert.deepEqual(opened.used, ["user:ada", "user:bram", "user:dov"]);
  assert.ok((await mail(api)).some((m) => m.subject === "Another share was added"));
});
