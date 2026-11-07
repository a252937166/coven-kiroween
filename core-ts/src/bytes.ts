// Small byte helpers shared by core-ts modules. No secrets are logged here.

/** A byte array backed by a plain ArrayBuffer, which WebCrypto accepts as BufferSource. */
export type Bytes = Uint8Array<ArrayBuffer>;

/** Copy any Uint8Array into a fresh ArrayBuffer-backed Bytes. */
export function bytes(src: ArrayLike<number> | ArrayBuffer): Bytes {
  if (src instanceof ArrayBuffer) return new Uint8Array(src.slice(0));
  const out = new Uint8Array(src.length);
  out.set(src);
  return out;
}

export function randomBytes(n: number): Bytes {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

export function concatBytes(...parts: Uint8Array[]): Bytes {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function toHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

export function fromHex(hex: string): Bytes {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new TypeError("invalid hex");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Standard base64 with padding. */
export function toBase64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    s += i + 1 < b.length ? B64[(n >> 6) & 63] : "=";
    s += i + 2 < b.length ? B64[n & 63] : "=";
  }
  return s;
}

/** Accepts base64 or base64url, with or without padding. */
export function fromBase64(s: string): Bytes {
  const clean = s.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  if (!/^[A-Za-z0-9+/]*$/.test(clean) || clean.length % 4 === 1) throw new TypeError("invalid base64");
  const out: number[] = [];
  let buf = 0;
  let bits = 0;
  for (const ch of clean) {
    buf = (buf << 6) | B64.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buf >> bits) & 0xff);
    }
  }
  return bytes(out);
}

export function toBase64Url(b: Uint8Array): string {
  return toBase64(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function utf8(s: string): Bytes {
  return encoder.encode(s) as Bytes;
}

export function fromUtf8(b: Uint8Array): string {
  return decoder.decode(b);
}

/** uint16 big-endian length prefix followed by the UTF-8 bytes of s. */
export function lengthPrefixed(s: string): Bytes {
  const body = utf8(s);
  if (body.length > 0xffff) throw new RangeError("field too long");
  const out = new Uint8Array(2 + body.length);
  out[0] = body.length >> 8;
  out[1] = body.length & 0xff;
  out.set(body, 2);
  return out;
}

/** Domain tag followed by length-prefixed fields. Used for every AAD in Coven. */
export function encodeAad(domain: string, fields: readonly string[]): Bytes {
  return concatBytes(utf8(domain), new Uint8Array([0x00]), ...fields.map(lengthPrefixed));
}
