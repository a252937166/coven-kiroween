// Hosted mode with real core-ts cryptography over HTTP. Two "browsers" (each
// its own cookie jar and key store) share one hosted service. A moves its demo
// clock and resets while B completes its own petition and recovery, and B's
// printed card codes still open B's bundle with the offline tool. Fictional data only.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

import { Api, ApiError } from "../src/api.ts";
import { MemoryKeyStore } from "../src/keystore.ts";
import { advanceClock, resetDemo } from "../src/common.ts";
import * as bg from "../src/breakglass.ts";
import * as ll from "../src/lastlight.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const python = join(root, "service/.venv/bin/python");
let proc: ChildProcess;
let base = "";
let logs = "";
let spacesDir = "";

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
  spacesDir = join(mkdtempSync(join(tmpdir(), "coven-hosted-")), "spaces");
  // The production settings, except the port: secure host-only cookies, default bounds.
  proc = spawn(python, ["-m", "coven_service", "--port", String(port), "--spaces-dir", spacesDir], {
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
const spaceFiles = () => readdirSync(spacesDir).filter((f) => /^[0-9a-f]{64}\.sqlite$/.test(f)).length;
const notFound = (e: unknown) => e instanceof ApiError && e.status === 404;

test("Hosted Break Glass: A moves its clock and resets while B's petition is approved and released", async () => {
  const before = spaceFiles();
  const a = browser("break-glass");
  const b = browser("break-glass");
  assert.deepEqual(await a.api.get("/api/demo/space"), { private: true, idle_days: 7 });
  await bg.setupDemo(a.api, a.ks);
  await b.api.signIn("user:robin");
  assert.deepEqual(await bg.listItems(b.api), []); // A's setup is not in B's space
  await bg.setupDemo(b.api, b.ks);
  assert.equal(spaceFiles(), before + 2);
  const sealedA = new Set((await bg.listItems(a.api)).map((i) => i.seal_version_id));
  assert.ok((await bg.listItems(b.api)).every((i) => i.seal_version_id && !sealedA.has(i.seal_version_id)));

  await b.api.signIn("user:robin");
  const p = await bg.openPetition(b.api, b.ks, "user:robin", "aws-root", "B in its own space (fictional)", 900);
  await b.api.signIn("user:sage");
  assert.equal((await bg.approvePetition(b.api, b.ks, "user:sage", p.petition_id)).counted, true);

  // A: its own petition, an hour on its own clock (the petition expires), then a reset.
  await a.api.signIn("user:robin");
  const pa = await bg.openPetition(a.api, a.ks, "user:robin", "aws-root", "A in its own space (fictional)", 900);
  assert.equal((await advanceClock(a.api, 3600)).offset_seconds, 3600);
  assert.equal((await bg.petition(a.api, pa.petition_id)).state, "Expired");
  await assert.rejects(bg.petition(b.api, pa.petition_id), notFound); // not in B's space at all
  await resetDemo(a.api, a.ks);

  await b.api.signIn("user:rowan");
  assert.equal((await bg.approvePetition(b.api, b.ks, "user:rowan", p.petition_id)).status.state, "Approved");
  await b.api.signIn("user:robin");
  const out = await bg.retrieve(b.api, b.ks, p.petition_id);
  assert.match(out.secret, /Pumpkin-Lantern-4417/);
  assert.equal((await b.api.get<{ offset_seconds: number }>("/api/demo/clock")).offset_seconds, 0);

  // A starts over in its own space, now empty, with its clock back at zero.
  await a.api.signIn("user:robin");
  assert.deepEqual(await bg.listItems(a.api), []);
  assert.equal((await a.api.get<{ offset_seconds: number }>("/api/demo/clock")).offset_seconds, 0);
  await bg.setupDemo(a.api, a.ks);
  assert.equal((await bg.listItems(a.api)).length, 3);
  assert.equal(spaceFiles(), before + 2); // a reset empties a space; it does not make a new one
});

test("Hosted Last Light: B's recovery and offline recovery complete while A moves its clock and resets", async () => {
  const before = spaceFiles();
  const a = browser("last-light");
  const b = browser("last-light");
  const va = await ll.setupDemo(a.api, a.ks);
  await b.api.signIn(ll.OWNER);
  assert.deepEqual(await ll.listVaults(b.api), []); // A's vault is not in B's space
  const vb = await ll.setupDemo(b.api, b.ks);
  assert.equal(spaceFiles(), before + 2);

  const cards: Record<string, ll.CardContent> = {};
  for (const t of ["user:bram", "user:dov", "user:esme"]) {
    await b.api.signIn(t);
    cards[t] = await ll.myCard(b.api, b.ks, t, vb);
    await ll.recordCardIssued(b.api, vb);
  }
  await b.api.signIn(ll.OWNER);
  await advanceClock(b.api, 47 * 86400);
  assert.equal((await ll.vault(b.api, vb)).state, "Handover");
  await a.api.signIn(ll.OWNER);
  assert.equal((await ll.vault(a.api, va)).state, "Lit"); // B's clock is B's own

  await b.api.signIn("user:ada");
  const status = await ll.beginRecovery(b.api, b.ks, "user:ada", vb);
  await ll.submitShare(b.api, b.ks, "user:ada", status);

  // A: 400 days on its own clock, then a reset, in the middle of B's recovery.
  await advanceClock(a.api, 400 * 86400);
  assert.equal((await ll.vault(a.api, va)).state, "Handover");
  await resetDemo(a.api, a.ks);
  await assert.rejects(ll.vault(b.api, va), notFound);

  await b.api.signIn("user:bram");
  await ll.submitShare(b.api, b.ks, "user:bram", await ll.vault(b.api, vb), cards["user:bram"].words); // typed from the card
  await b.api.signIn("user:cleo");
  await ll.submitShare(b.api, b.ks, "user:cleo", await ll.vault(b.api, vb));
  await b.api.signIn("user:ada");
  const opened = await ll.completeRecovery(b.api, b.ks, status.recovery!.recovery_id);
  assert.match(opened.items[0].body!, /blue pumpkin/);
  assert.equal((await ll.vault(b.api, vb)).state, "Released");

  // The paper format is unchanged: B's printed codes open B's bundle with the offline tool.
  const path = join(mkdtempSync(join(tmpdir(), "coven-hosted-bundle-")), "bundle.json");
  writeFileSync(path, JSON.stringify(await ll.bundle(b.api, vb)));
  const cli = join(root, "core-ts/bin/recover.js");
  const ok = spawnSync(process.execPath, [cli, path, "--share", cards["user:bram"].words, "--share", cards["user:dov"].qr, "--share", cards["user:esme"].words], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /blue pumpkin/);

  // A is on its own, empty space.
  await a.api.signIn(ll.OWNER);
  assert.deepEqual(await ll.listVaults(a.api), []);
  assert.equal(spaceFiles(), before + 2);

  // No card text, raw share, token or space name in the service log.
  for (const c of Object.values(cards)) {
    for (const s of [c.qr, c.words, c.words.replace(/-/g, ""), c.qr.slice(7)]) assert.ok(!logs.includes(s), "share text in service logs");
  }
  assert.doesNotMatch(logs, /[A-Za-z0-9_-]{40,}/); // no token (43 chars) or space name (64 hex) at all
  assert.match(logs, /space created live=\d+/);
});
