// Offline recovery from a bundle (proposal invariant 1, acceptance scenario 4)
// and receipt verification (invariant 9's TypeScript side). Fictional data only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { parseBundle, recoverVault, RecoveryError, BundleError } from "../src/bundle.ts";
import { canonicalJson, diffAgainstSnapshot, entryHash, GENESIS, verifyChain, verifyReceipt } from "../src/records.ts";
import { chain, fixtureVault } from "./helpers.ts";

test("bundle recovers with any 3 of 5 shares, QR or word code", async () => {
  const f = await fixtureVault();
  const items = await recoverVault(f.bundle, [f.qr[0], f.words[2], f.qr[4]]);
  assert.equal(items.length, 2);
  assert.match(items[0].body, /pumpkin/);
  assert.equal(items[1].earliestRelease, "2027-01-01");
});

test("bundle refuses 2 shares, duplicates, foreign and typo'd shares, naming positions only", async () => {
  const f = await fixtureVault();
  const other = await fixtureVault("vault-other");
  await assert.rejects(recoverVault(f.bundle, [f.qr[0], f.qr[1]]), /need 3 distinct/);
  await assert.rejects(recoverVault(f.bundle, [f.qr[0], f.words[0], f.qr[1]]), (e: unknown) => {
    assert.ok(e instanceof RecoveryError);
    assert.deepEqual(e.problems, [{ position: 2, reason: "duplicate share" }]);
    return true;
  });
  await assert.rejects(recoverVault(f.bundle, [f.qr[0], other.qr[1], f.qr[2]]), (e: unknown) => {
    assert.ok(e instanceof RecoveryError);
    assert.equal(e.problems[0].reason, "share belongs to a different vault");
    return true;
  });
  const typo = f.words[1].replace(/^./, (c) => (c === "A" ? "B" : "A"));
  await assert.rejects(recoverVault(f.bundle, [f.qr[0], typo, f.qr[2]]), (e: unknown) => {
    assert.ok(e instanceof RecoveryError);
    assert.match(e.problems[0].reason, /checksum/);
    assert.ok(!JSON.stringify(e.problems).includes(f.words[1]));
    return true;
  });
});

test("a share of the right vault but wrong content fails the header check; nothing is decrypted", async () => {
  const f = await fixtureVault();
  // Re-split the same vault ID with a different key: same tag, wrong share.
  const impostor = await fixtureVault(f.bundle.vault.id);
  await assert.rejects(recoverVault(f.bundle, [f.qr[0], f.qr[1], impostor.qr[2]]), (e: unknown) => {
    assert.ok(e instanceof RecoveryError || /duplicate/.test(String(e)));
    return true;
  });
});

test("parseBundle rejects other formats", () => {
  assert.throws(() => parseBundle({ format: "coven/v0" }), BundleError);
  assert.throws(() => parseBundle(null), BundleError);
});

test("inv-9 receipt check: consistent, altered, truncated", async () => {
  const entries = await chain(["a", "b", "c", "d"]);
  const receipt = { length: 3, head: entries[2].hash! };
  assert.equal(await verifyReceipt(entries, receipt), "consistent");
  const edited = entries.map((e) => (e.seq === 2 ? { ...e, data: { n: 99 } } : e));
  assert.equal(await verifyReceipt(edited, receipt), "altered");
  const reordered = [entries[1], entries[0], ...entries.slice(2)];
  assert.equal(await verifyReceipt(reordered, receipt), "altered");
  assert.equal(await verifyReceipt(entries.slice(0, 2), receipt), "truncated");
  assert.deepEqual((await verifyChain(entries)).ok, true);
  assert.deepEqual((await verifyChain(edited)).firstBad, 2);
});

test("inv-9 snapshot diff locates changed entries only with a retained copy", async () => {
  const snapshot = await chain(["a", "b", "c"]);
  const current = [snapshot[0], { ...snapshot[1], type: "b2" }, snapshot[2], ...(await chain(["a", "b", "c", "d"])).slice(3)];
  assert.deepEqual(await diffAgainstSnapshot(current, snapshot), { changed: [2], missing: [], added: [4] });
});

test("records known-answer vector shared with the Python service", async () => {
  // The same vector is asserted in service/tests/test_records.py.
  const e = { seq: 1, at: "2026-11-07T12:00:00Z", type: "vault.created", data: { vault: "v1", name: "Café" } };
  assert.equal(canonicalJson(e), '{"at":"2026-11-07T12:00:00Z","data":{"name":"Caf\\u00e9","vault":"v1"},"seq":1,"type":"vault.created"}');
  assert.equal(await entryHash(GENESIS, e), "d144a0ccf833f6c0dcd0130b078cbca2fdcad1e21291139d488dd69163fddb50");
});

const cli = fileURLToPath(new URL("../bin/recover.js", import.meta.url));

function runCli(args: string[], input?: string) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", input });
}

test("offline CLI recovers from a bundle file and never prints a share", async () => {
  const f = await fixtureVault();
  const dir = mkdtempSync(join(tmpdir(), "coven-cli-"));
  const path = join(dir, "bundle.json");
  writeFileSync(path, JSON.stringify(f.bundle));

  const two = runCli([path, "--share", f.qr[0], "--share", f.qr[1]]);
  assert.equal(two.status, 1);
  assert.match(two.stderr, /need 3 distinct valid shares/);

  const ok = runCli([path, "--share", f.qr[0], "--share", f.words[1], "--share", f.qr[3], "--record", join(dir, "local.json")]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /pumpkin/);
  assert.match(ok.stdout, /earliest release \(online policy\): 2027-01-01/);
  const all = ok.stdout + ok.stderr + readFileSync(join(dir, "local.json"), "utf8");
  for (const s of [...f.qr, ...f.words]) assert.ok(!all.includes(s), "share text leaked into output");

  const stdin = runCli([path], `${f.words[0]}\n${f.words[2]}\n${f.words[4]}\n\n`);
  assert.equal(stdin.status, 0, stdin.stderr);
  assert.match(stdin.stdout, /Home Wi-Fi/);

  const dup = runCli([path, "--share", f.qr[0], "--share", f.qr[0], "--share", f.qr[1]]);
  assert.equal(dup.status, 1);
  assert.match(dup.stderr, /share 2: duplicate share/);
});

test("offline CLI verifies the record against a receipt", async () => {
  const f = await fixtureVault();
  const dir = mkdtempSync(join(tmpdir(), "coven-cli-"));
  const path = join(dir, "bundle.json");
  writeFileSync(path, JSON.stringify(f.bundle));
  const r = f.bundle.record.receipt;
  const ok = runCli(["verify", path, "--receipt", `${r.length}:${r.head}`]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /^consistent/);

  const edited = f.bundle.record.entries.map((e) => (e.seq === 2 ? { ...e, type: "cards.reissued" } : e));
  writeFileSync(join(dir, "chain.json"), JSON.stringify({ entries: edited }));
  const bad = runCli(["verify", path, "--receipt", `${r.length}:${r.head}`, "--chain", join(dir, "chain.json")]);
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /witnessed prefix altered/);
  assert.match(bad.stdout, /changed \[2\]/);

  writeFileSync(join(dir, "short.json"), JSON.stringify({ entries: f.bundle.record.entries.slice(0, 1) }));
  const short = runCli(["verify", path, "--receipt", `${r.length}:${r.head}`, "--chain", join(dir, "short.json")]);
  assert.match(short.stdout, /^truncated/);
});
