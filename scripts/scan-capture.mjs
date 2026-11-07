#!/usr/bin/env node
// AG-01 capture scanner (spec 05 task 9.2).
//
//   node scripts/scan-capture.mjs <capture-dir-or-file> <secrets-file>
//   node scripts/scan-capture.mjs --self-test
//
// The secrets file holds one share text per line: a "coven1:..." QR payload
// and/or a word code. For each one the scanner searches every file under the
// capture path for:
//   - the QR payload, and its base64url body;
//   - the word code with and without separators, in any case;
//   - the payload bytes and the raw share bytes as hex (any case), base64 and base64url.
// It prints only file names and byte offsets, never a matched value.
// Exit 0: no match. Exit 1: at least one match. Exit 2: usage error.

import { readFileSync, readdirSync, statSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TAG_PREFIX = 5; // version byte + 4-byte vault tag

function b64urlDecode(s) {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function needles(line) {
  const out = []; // { label, value, ci }
  const t = line.trim();
  if (!t || t.startsWith("#")) return out;
  if (t.startsWith("coven1:")) {
    const body = t.slice(7);
    out.push({ label: "qr payload", value: t, ci: false }, { label: "qr body", value: body, ci: false });
    const payload = b64urlDecode(body);
    for (const [name, bytes] of [["payload", payload], ["raw share", payload.subarray(TAG_PREFIX)]]) {
      out.push({ label: `${name} hex`, value: bytes.toString("hex"), ci: true });
      out.push({ label: `${name} base64`, value: bytes.toString("base64").replace(/=+$/, ""), ci: false });
      out.push({ label: `${name} base64url`, value: bytes.toString("base64url"), ci: false });
    }
  } else {
    const compact = t.replace(/[\s-]/g, "");
    out.push({ label: "word code", value: t, ci: true }, { label: "word code (no separators)", value: compact, ci: true });
    out.push({ label: "word code (spaces)", value: t.replace(/-/g, " "), ci: true });
  }
  return out.filter((n) => n.value.length >= 12);
}

function files(path) {
  const st = statSync(path);
  if (st.isFile()) return [path];
  return readdirSync(path).flatMap((n) => files(join(path, n)));
}

function indexesOf(hay, needle) {
  const found = [];
  let i = hay.indexOf(needle);
  while (i >= 0 && found.length < 20) {
    found.push(i);
    i = hay.indexOf(needle, i + 1);
  }
  return found;
}

export function scan(capturePath, secretLines) {
  const ns = secretLines.flatMap(needles);
  const hits = [];
  for (const f of files(capturePath)) {
    const text = readFileSync(f).toString("latin1");
    const lower = text.toLowerCase();
    for (const n of ns) {
      const offs = n.ci ? indexesOf(lower, n.value.toLowerCase()) : indexesOf(text, n.value);
      for (const o of offs) hits.push({ file: f, offset: o, kind: n.label });
    }
  }
  return { hits, needleCount: ns.length };
}

function selfTest() {
  // Fictional share: 0x01 || tag || 33 share bytes.
  const payload = Buffer.concat([Buffer.from([1, 0xde, 0xad, 0xbe, 0xef]), Buffer.from(Array.from({ length: 33 }, (_, i) => (i * 37 + 11) & 255))]);
  const qr = "coven1:" + payload.toString("base64url");
  const words = "0424-ZEEP-CGZF-TQ05-J54F-FGFC-306Q-D81H";
  const dir = mkdtempSync(join(tmpdir(), "coven-scan-"));
  try {
    writeFileSync(join(dir, "clean.log"), "GET /api/ll/vaults route=/api/ll/vaults status=200\n");
    let r = scan(dir, [qr, words]);
    if (r.hits.length !== 0) throw new Error("clean capture reported a match");
    const cases = [
      qr,
      payload.subarray(5).toString("hex").toUpperCase(),
      payload.subarray(5).toString("base64"),
      payload.toString("base64url"),
      words.toLowerCase(),
      words.replace(/-/g, ""),
      words.replace(/-/g, " "),
    ];
    for (const [i, c] of cases.entries()) {
      writeFileSync(join(dir, `leak${i}.har`), `{"postData":"x${c}y"}`);
      r = scan(dir, [qr, words]);
      if (r.hits.length === 0) throw new Error(`missed case ${i}`);
      rmSync(join(dir, `leak${i}.har`));
    }
    console.log(`self-test PASS (${cases.length} leak forms detected, clean capture clean)`);
    return 0;
  } catch (e) {
    console.error(`self-test FAIL: ${e.message}`);
    return 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [a, b] = process.argv.slice(2);
  if (a === "--self-test") process.exit(selfTest());
  if (!a || !b) {
    console.error("usage: node scripts/scan-capture.mjs <capture-dir-or-file> <secrets-file> | --self-test");
    process.exit(2);
  }
  const { hits, needleCount } = scan(a, readFileSync(b, "utf8").split(/\r?\n/));
  if (needleCount === 0) {
    console.error("no secrets read from the secrets file");
    process.exit(2);
  }
  for (const h of hits) console.log(`MATCH ${h.kind} in ${h.file} at offset ${h.offset}`);
  console.log(hits.length === 0 ? `AG-01 scan PASS: ${needleCount} forms, no match` : `AG-01 scan FAIL: ${hits.length} matches`);
  process.exit(hits.length === 0 ? 0 : 1);
}
