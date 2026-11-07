// Record chain hashing and receipt verification (proposal section 3.4).
//
// The Python service computes the same hashes (service/coven_service/records.py).
// A receipt is (length N, head hash H). From a receipt and a chain the
// verifier reports exactly one of: consistent, altered (the witnessed prefix
// no longer hashes to H), truncated (fewer than N entries). It cannot say
// which entry changed. Locating changes needs a retained snapshot.

import { toHex, utf8 } from "./bytes.ts";

export interface RecordEntry {
  seq: number;
  at: string;
  type: string;
  data: Record<string, unknown>;
  hash?: string;
}

export interface Receipt {
  length: number;
  head: string;
}

export type ReceiptOutcome = "consistent" | "altered" | "truncated";

export const GENESIS = "0".repeat(64);

/** Sorted keys, no whitespace, non-ASCII as \uXXXX: matches Python json.dumps(sort_keys, separators, ensure_ascii). */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("records allow integers only");
    return String(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value).replace(/[\u0080-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
  }
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return "{" + keys.map((k) => canonicalJson(k) + ":" + canonicalJson(obj[k])).join(",") + "}";
  }
  throw new TypeError("unsupported value in record");
}

export async function entryHash(prev: string, e: RecordEntry): Promise<string> {
  const body = canonicalJson({ seq: e.seq, at: e.at, type: e.type, data: e.data });
  const digest = await globalThis.crypto.subtle.digest("SHA-256", utf8(`coven/v1/record\n${prev}\n${body}`));
  return toHex(new Uint8Array(digest));
}

/** Head hash after the first n entries, recomputed from entry contents. */
export async function headAfter(entries: readonly RecordEntry[], n: number): Promise<string> {
  let h = GENESIS;
  for (let i = 0; i < n; i++) h = await entryHash(h, entries[i]);
  return h;
}

export async function verifyReceipt(entries: readonly RecordEntry[], receipt: Receipt): Promise<ReceiptOutcome> {
  if (entries.length < receipt.length) return "truncated";
  return (await headAfter(entries, receipt.length)) === receipt.head ? "consistent" : "altered";
}

/** Internal consistency: sequence numbers 1..n in order, stored hashes match contents. */
export async function verifyChain(entries: readonly RecordEntry[]): Promise<{ ok: boolean; firstBad?: number }> {
  let h = GENESIS;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    h = await entryHash(h, e);
    if (e.seq !== i + 1 || (e.hash !== undefined && e.hash !== h)) return { ok: false, firstBad: e.seq };
  }
  return { ok: true };
}

export interface SnapshotDiff {
  changed: number[];
  missing: number[];
  added: number[];
}

/** Entry-level comparison against a retained snapshot. Only possible with such a copy. */
export async function diffAgainstSnapshot(
  current: readonly RecordEntry[],
  snapshot: readonly RecordEntry[],
): Promise<SnapshotDiff> {
  const key = (e: RecordEntry) => canonicalJson({ seq: e.seq, at: e.at, type: e.type, data: e.data });
  const changed: number[] = [];
  const n = Math.min(current.length, snapshot.length);
  for (let i = 0; i < n; i++) if (key(current[i]) !== key(snapshot[i])) changed.push(snapshot[i].seq);
  const missing = snapshot.slice(n).map((e) => e.seq);
  const added = current.slice(n).map((e) => e.seq);
  return { changed, missing, added };
}
