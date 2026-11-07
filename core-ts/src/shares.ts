// Shamir sharing over GF(2^8) via the audited `shamir-secret-sharing` library
// (pinned 0.0.4), plus the printable encodings used on Last Light share cards.
//
// The library does not verify a rebuilt secret. Callers must run the key's
// header check (envelope.checkKeyHeader) before decrypting anything.
//
// Printable encodings:
//   QR payload  "coven1:" + base64url(payload)
//   word code   Crockford base32 of payload in groups of 4, plus two check
//               symbols: sum((i+1) * v_i) mod 1021. Any single-symbol change
//               and any swap of two different symbols changes the check.
//   payload     0x01 || tag (4 bytes) || share
// The tag names the vault the share belongs to so foreign shares fail early.

import { combine, split } from "shamir-secret-sharing";
import { bytes, bytesEqual, concatBytes, encodeAad, fromBase64, toBase64Url, type Bytes } from "./bytes.ts";

export const SHARE_PAYLOAD_VERSION = 0x01;
export const QR_PREFIX = "coven1:";
const TAG_LENGTH = 4;
const CHECK_MOD = 1021;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export class ShareError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShareError";
  }
}

/** Split a key into n shares, any k of which rebuild it. */
export async function splitKey(key: Uint8Array, n: number, k: number): Promise<Bytes[]> {
  if (!Number.isInteger(n) || !Number.isInteger(k) || k < 2 || n < k || n > 255) {
    throw new ShareError("need 2 <= k <= n <= 255");
  }
  return (await split(bytes(key), n, k)).map((s) => bytes(s));
}

/** The x coordinate is the last byte of a share. */
export function shareIndex(share: Uint8Array): number {
  return share[share.length - 1];
}

/**
 * Combine shares after structural checks: at least k, equal length, no
 * duplicate x coordinates. Wrong or foreign shares still combine to garbage;
 * the header check catches them.
 */
export async function combineShares(shares: readonly Uint8Array[], k: number): Promise<Bytes> {
  if (shares.length < k) throw new ShareError(`need ${k} shares, got ${shares.length}`);
  const len = shares[0].length;
  const seen = new Set<number>();
  for (const s of shares) {
    if (s.length !== len || len < 2) throw new ShareError("shares have different lengths");
    const x = shareIndex(s);
    if (x === 0) throw new ShareError("malformed share");
    if (seen.has(x)) throw new ShareError("duplicate share");
    seen.add(x);
  }
  return bytes(await combine(shares.map((s) => bytes(s))));
}

/** 4-byte tag for a sharing scope (a vault ID). */
export async function shareTag(scope: string): Promise<Bytes> {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", encodeAad("coven/v1/share-tag", [scope])));
  return digest.slice(0, TAG_LENGTH);
}

export interface DecodedShare {
  tag: Bytes;
  share: Bytes;
}

function payload(tag: Uint8Array, share: Uint8Array): Bytes {
  if (tag.length !== TAG_LENGTH) throw new ShareError("tag must be 4 bytes");
  return concatBytes(new Uint8Array([SHARE_PAYLOAD_VERSION]), tag, share);
}

function parsePayload(p: Uint8Array): DecodedShare {
  if (p.length < 1 + TAG_LENGTH + 2 || p[0] !== SHARE_PAYLOAD_VERSION) throw new ShareError("malformed share");
  return { tag: bytes(p.slice(1, 1 + TAG_LENGTH)), share: bytes(p.slice(1 + TAG_LENGTH)) };
}

export function encodeQrPayload(tag: Uint8Array, share: Uint8Array): string {
  return QR_PREFIX + toBase64Url(payload(tag, share));
}

function toBase32(b: Uint8Array): number[] {
  const out: number[] = [];
  let buf = 0;
  let bits = 0;
  for (const x of b) {
    buf = (buf << 8) | x;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out.push((buf >> bits) & 31);
    }
    buf &= (1 << bits) - 1;
  }
  if (bits > 0) out.push((buf << (5 - bits)) & 31);
  return out;
}

function fromBase32(v: number[]): Bytes {
  const nBytes = Math.floor((v.length * 5) / 8);
  const out = new Uint8Array(nBytes);
  let buf = 0;
  let bits = 0;
  let j = 0;
  for (const x of v) {
    buf = (buf << 5) | x;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      if (j < nBytes) out[j++] = (buf >> bits) & 0xff;
    }
    buf &= (1 << bits) - 1;
  }
  if (buf !== 0) throw new ShareError("word code has stray bits");
  return out;
}

function checkValue(v: number[]): number {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum = (sum + (i + 1) * v[i]) % CHECK_MOD;
  return sum;
}

export function encodeWordCode(tag: Uint8Array, share: Uint8Array): string {
  const v = toBase32(payload(tag, share));
  const c = checkValue(v);
  const all = [...v, c >> 5, c & 31].map((x) => CROCKFORD[x]).join("");
  return all.match(/.{1,4}/g)!.join("-");
}

function normalizeWordCode(code: string): number[] {
  const cleaned = code.toUpperCase().replace(/[\s-]/g, "").replace(/[IL]/g, "1").replace(/O/g, "0");
  const v: number[] = [];
  for (const ch of cleaned) {
    const i = CROCKFORD.indexOf(ch);
    if (i < 0) throw new ShareError("word code has an invalid character");
    v.push(i);
  }
  return v;
}

export function decodeWordCode(code: string): DecodedShare {
  const v = normalizeWordCode(code);
  if (v.length < 4) throw new ShareError("word code too short");
  const body = v.slice(0, -2);
  const c = (v[v.length - 2] << 5) | v[v.length - 1];
  if (c !== checkValue(body)) throw new ShareError("word code checksum mismatch: check for a typo");
  return parsePayload(fromBase32(body));
}

export function decodeQrPayload(text: string): DecodedShare {
  if (!text.startsWith(QR_PREFIX)) throw new ShareError("not a coven1 share");
  let p: Bytes;
  try {
    p = fromBase64(text.slice(QR_PREFIX.length));
  } catch {
    throw new ShareError("malformed share");
  }
  return parsePayload(p);
}

/** Accept either printed form: the QR payload text or the typed word code. */
export function decodeShareText(text: string): DecodedShare {
  const t = text.trim();
  return t.startsWith(QR_PREFIX) ? decodeQrPayload(t) : decodeWordCode(t);
}

/** Decode and check that the share belongs to the given scope. */
export async function decodeShareFor(text: string, scope: string): Promise<Bytes> {
  const d = decodeShareText(text);
  if (!bytesEqual(d.tag, await shareTag(scope))) throw new ShareError("share belongs to a different vault");
  return d.share;
}
