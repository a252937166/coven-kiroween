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

// ---------------------------------------------------------------------------
// Setup and lost-answer recovery (review blockers). Each test starts from a reset.

import { directory, ensureEnrolled, FlowError, resetDemo } from "../src/common.ts";
import { longTermKey } from "../src/keystore.ts";
import { bytesEqual } from "@coven/core-ts/bytes";

/** An Api that loses chosen answers: "after" sends the request (it commits) and drops the answer; "before" never sends it. */
class LossyApi extends Api {
  drops: { method: string; path: RegExp; mode: "after" | "before"; times: number; skip?: number }[] = [];
  override async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const d = this.drops.find((x) => x.times > 0 && x.method === method && x.path.test(path));
    if (d && d.skip) {
      d.skip--; // let the first matches through
    } else if (d) {
      d.times--;
      if (d.mode === "after") await super.request(method, path, body).catch(() => undefined);
      throw new TypeError(`answer lost (test): ${method} ${path}`);
    }
    return super.request<T>(method, path, body);
  }
}
const lossy = (app: "break-glass" | "last-light") => ({ api: new LossyApi({ base, app, cookieJar: true }), ks: new MemoryKeyStore() });

async function boundKeyOf(api: Api, user: string) {
  return (await directory(api)).get(user);
}

test("Enrollment: a reset started from either app lets both apps seed again in the same browser", async () => {
  const L = browser("last-light");
  const B = browser("break-glass");
  await L.api.post("/api/demo/reset");
  await ll.setupDemo(L.api, L.ks);
  await bg.setupDemo(B.api, B.ks);

  // Reset from Last Light: the service forgets every enrollment, only Last Light's keys are cleared here.
  await resetDemo(L.api, L.ks);
  assert.ok(await longTermKey(B.ks, bg.ADMIN), "Break Glass keys survive a Last Light reset");
  await bg.setupDemo(B.api, B.ks); // re-binds its kept keys instead of sealing to nobody
  await B.api.signIn(bg.ADMIN);
  const items = await bg.listItems(B.api);
  assert.equal(bg.demoProgress(items).ready, true);
  assert.ok(items.every((i) => i.seal_version_id), "every item sealed, aws-root included");
  assert.ok(bytesEqual((await boundKeyOf(B.api, bg.ADMIN))!, (await longTermKey(B.ks, bg.ADMIN))!.publicKey));
  await ll.setupDemo(L.api, L.ks);

  // Reset from Break Glass: Last Light's kept keys are re-bound on its next setup.
  await resetDemo(B.api, B.ks);
  const vaultId = await ll.setupDemo(L.api, L.ks);
  await L.api.signIn(ll.OWNER);
  assert.equal(ll.demoProgress(await ll.vault(L.api, vaultId)).ready, true);
  await bg.setupDemo(B.api, B.ks);
  await B.api.signIn(bg.ADMIN);
  assert.equal(bg.demoProgress(await bg.listItems(B.api)).ready, true);

  // A different browser with no keys is refused, and the bound identity key is not replaced.
  const other = browser("last-light");
  const before = await boundKeyOf(L.api, ll.OWNER);
  await assert.rejects(ll.setupDemo(other.api, other.ks), (e: unknown) => e instanceof FlowError && /does not hold/.test(e.message));
  assert.ok(bytesEqual((await boundKeyOf(L.api, ll.OWNER))!, before!));
});

test("Enrollment: a lost answer keeps the local key, and the retry finds it bound", async () => {
  const { api, ks } = lossy("break-glass");
  await api.post("/api/demo/reset");
  const DIRECTORY = /^\/api\/directory$/;
  const ENROLL = /^\/api\/enroll$/;

  // Answer lost after it committed: the read-back finds this browser's key bound.
  await api.signIn("user:sage");
  api.drops.push({ method: "POST", path: ENROLL, mode: "after", times: 1 });
  const sage = await ensureEnrolled(api, ks, "user:sage");
  assert.ok(bytesEqual((await boundKeyOf(api, "user:sage"))!, sage.publicKey));

  // Answer and read-back both lost: the call fails, the local half stays, the retry reconciles.
  await api.signIn("user:rowan");
  api.drops.push({ method: "POST", path: ENROLL, mode: "after", times: 1 });
  api.drops.push({ method: "GET", path: DIRECTORY, mode: "before", times: 1, skip: 1 });
  await assert.rejects(ensureEnrolled(api, ks, "user:rowan"), TypeError);
  const rowan = await longTermKey(ks, "user:rowan");
  assert.ok(rowan, "the local half is kept after an ambiguous failure");
  const again = await ensureEnrolled(api, ks, "user:rowan");
  assert.ok(bytesEqual(again.publicKey, rowan!.publicKey));
  assert.ok(bytesEqual((await boundKeyOf(api, "user:rowan"))!, rowan!.publicKey));

  // Lost before it was sent: the retry binds the same kept key.
  await api.signIn("user:ash");
  api.drops.push({ method: "POST", path: ENROLL, mode: "before", times: 1 });
  await assert.rejects(ensureEnrolled(api, ks, "user:ash"), TypeError);
  const ash = await longTermKey(ks, "user:ash");
  assert.ok(ash);
  assert.equal(await boundKeyOf(api, "user:ash"), undefined);
  await ensureEnrolled(api, ks, "user:ash");
  assert.ok(bytesEqual((await boundKeyOf(api, "user:ash"))!, ash!.publicKey));
});

test("Setup: an interrupted run resumes without duplicate vaults, letters, items or seals", async () => {
  // Last Light: the vault is created, then a letter's answer is lost after it committed.
  const L = lossy("last-light");
  await L.api.post("/api/demo/reset");
  L.api.drops.push({ method: "POST", path: /^\/api\/ll\/vaults\/[^/]+\/items$/, mode: "after", times: 1 });
  await assert.rejects(ll.setupDemo(L.api, L.ks), TypeError);
  await L.api.signIn(ll.OWNER);
  let vaults = await ll.listVaults(L.api);
  assert.equal(vaults.length, 1);
  assert.equal(ll.demoProgress(vaults[0]).ready, false, "a partial vault is not ready");
  await ll.setupDemo(L.api, L.ks);
  await ll.setupDemo(L.api, L.ks); // running it again changes nothing
  vaults = await ll.listVaults(L.api);
  assert.equal(vaults.length, 1, "one vault");
  assert.deepEqual(vaults[0].items.map((i) => i.label).sort(), ll.DEMO_ITEMS.map((i) => i.label).sort());

  // Last Light: the vault's own answer is lost after it committed.
  await L.api.post("/api/demo/reset");
  await L.ks.clear();
  L.api.drops.push({ method: "POST", path: /^\/api\/ll\/vaults$/, mode: "after", times: 1 });
  await assert.rejects(ll.setupDemo(L.api, L.ks), TypeError);
  await ll.setupDemo(L.api, L.ks);
  await L.api.signIn(ll.OWNER);
  vaults = await ll.listVaults(L.api);
  assert.equal(vaults.length, 1);
  assert.equal(ll.demoProgress(vaults[0]).ready, true);

  // Break Glass: aws-root is sealed but the answer is lost; the retry keeps that version.
  const B = lossy("break-glass");
  await B.api.post("/api/demo/reset");
  B.api.drops.push({ method: "POST", path: /^\/api\/bg\/items\/aws-root\/seal-versions$/, mode: "after", times: 1 });
  await assert.rejects(bg.setupDemo(B.api, B.ks), TypeError);
  await B.api.signIn(bg.ADMIN);
  const partial = await bg.listItems(B.api);
  assert.equal(bg.demoProgress(partial).ready, false);
  const v1 = partial.find((i) => i.item_id === "aws-root")!.seal_version_id;
  assert.ok(v1);
  await bg.setupDemo(B.api, B.ks);
  await B.api.signIn(bg.ADMIN);
  const done = await bg.listItems(B.api);
  assert.equal(bg.demoProgress(done).ready, true);
  assert.equal(done.length, bg.DEMO_ITEMS.length, "no duplicate items");
  assert.equal(done.find((i) => i.item_id === "aws-root")!.seal_version_id, v1, "not resealed");
});

test("Lost answers: a recovery or petition opened while its answer was lost is adopted by its one-time key", async () => {
  // Last Light first.
  const L = lossy("last-light");
  await L.api.post("/api/demo/reset");
  const vaultId = await ll.setupDemo(L.api, L.ks);
  await advanceClock(L.api, 48 * 86400);
  await L.api.signIn("user:ada");
  L.api.drops.push({ method: "POST", path: /\/recoveries$/, mode: "after", times: 1 });
  let status = await ll.beginRecovery(L.api, L.ks, "user:ada", vaultId); // read back and adopted
  const rid = status.recovery!.recovery_id;
  assert.equal(status.recovery!.recoverer_id, "user:ada");
  assert.equal(await ll.hasRecoveryKey(L.ks, rid), true);
  for (const t of ["user:ada", "user:bram", "user:cleo"]) {
    await L.api.signIn(t);
    await ll.submitShare(L.api, L.ks, t, await ll.vault(L.api, vaultId));
  }
  await L.api.signIn("user:ada");
  const opened = await ll.completeRecovery(L.api, L.ks, rid);
  assert.match(opened.items[0].body!, /blue pumpkin/);

  // The answer and the read-back are both lost: the next load adopts it.
  await L.api.post("/api/demo/reset");
  await L.ks.clear();
  const v2 = await ll.setupDemo(L.api, L.ks);
  await advanceClock(L.api, 48 * 86400);
  await L.api.signIn("user:bram");
  L.api.drops.push({ method: "POST", path: /\/recoveries$/, mode: "after", times: 1 });
  L.api.drops.push({ method: "GET", path: new RegExp(`^/api/ll/vaults/${v2}$`), mode: "before", times: 1, skip: 1 });
  await assert.rejects(ll.beginRecovery(L.api, L.ks, "user:bram", v2));
  status = await ll.vault(L.api, v2);
  assert.equal(status.recovery?.recoverer_id, "user:bram", "the recovery committed");
  assert.equal(await ll.reconcileRecovery(L.ks, "user:bram", status), true);
  assert.equal(await ll.hasRecoveryKey(L.ks, status.recovery!.recovery_id), true);
  // Another trustee's view never adopts it.
  assert.equal(await ll.reconcileRecovery(L.ks, "user:dov", status), false);

  // Break Glass.
  const B = lossy("break-glass");
  await B.api.post("/api/demo/reset");
  await bg.setupDemo(B.api, B.ks);
  await B.api.signIn("user:robin");
  B.api.drops.push({ method: "POST", path: /^\/api\/bg\/petitions$/, mode: "after", times: 1 });
  const p = await bg.openPetition(B.api, B.ks, "user:robin", "registrar-codes", "Lost answer (fictional)", 900);
  assert.equal(await bg.hasLocalKey(B.ks, p.petition_id), true);
  assert.equal((await bg.listPetitions(B.api)).length, 1, "no duplicate petition");
  for (const a of ["user:ash", "user:wren"]) {
    await B.api.signIn(a);
    await bg.approvePetition(B.api, B.ks, a, p.petition_id);
  }
  await B.api.signIn("user:robin");
  const r = await bg.retrieve(B.api, B.ks, p.petition_id);
  assert.match(r.secret, /8F2K-QX7M/);
});
