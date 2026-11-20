// Flows shared by both apps: enrollment, directory, mail, records.

import { bytesEqual, fromBase64, fromHex, toBase64 } from "@coven/core-ts/bytes";
import { fingerprint, fingerprintLabel, importRawPublicKey } from "@coven/core-ts/keys";
import { verifyReceipt, verifyChain, type Receipt, type ReceiptOutcome, type RecordEntry } from "@coven/core-ts/records";
import { ApiError, type Api } from "./api.ts";
import { createLongTermKey, longTermKey, type KeyStore, type LongTermKey } from "./keystore.ts";

export interface Persona {
  id: string;
  name: string;
  app: string;
  role: string;
}

export interface DirectoryEntry {
  account_id: string;
  public_key: string;
  name?: string;
}

export class FlowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlowError";
  }
}

/** Returns false once the persona that started a flow is no longer active. */
export type Guard = () => boolean;

export class StaleFlowError extends FlowError {
  constructor() {
    super("the signed-in persona changed; this action was cancelled before it was sent");
    this.name = "StaleFlowError";
  }
}

/** Call right before a request that must be sent as the persona who started the flow. */
export function ensureLive(guard: Guard | undefined) {
  if (guard && !guard()) throw new StaleFlowError();
}

/** The public key the service has bound to `user`, or null when there is none. */
async function boundKey(api: Api, user: string): Promise<Uint8Array | null> {
  const row = (await api.get<DirectoryEntry[]>("/api/directory")).find((r) => r.account_id === user);
  return row ? fromBase64(row.public_key) : null;
}

const HELD_ELSEWHERE = (user: string) => `${user} is enrolled with a key this browser does not hold. Use "Reset demo".`;

/**
 * Make sure this browser holds a key for `user` and the service has bound its
 * public half. Reconciles with the service's directory every time:
 * - the same key on both sides: done;
 * - the service holds no key (for example after a demo reset started from the
 *   other app, which clears only that app's browser keys): bind this browser's key;
 * - the service holds a different key: refuse. A bound identity key is never replaced.
 * A new key is stored here before it is sent. If the answer is lost, the key
 * stays, so the next attempt finds it bound (or binds it) instead of stranding it.
 */
export async function ensureEnrolled(api: Api, ks: KeyStore, user: string): Promise<LongTermKey> {
  const local = await longTermKey(ks, user);
  const bound = await boundKey(api, user);
  if (bound) {
    if (local && bytesEqual(local.publicKey, bound)) return local;
    throw new FlowError(HELD_ELSEWHERE(user));
  }
  const key = local ?? (await createLongTermKey(ks, user));
  try {
    await api.post("/api/enroll", { public_key: toBase64(key.publicKey) });
  } catch (e) {
    // The request may have been bound anyway, or raced another tab: read back.
    const now = await boundKey(api, user).catch(() => undefined);
    if (now && bytesEqual(now, key.publicKey)) return key;
    if (now || (e instanceof ApiError && e.code === "already_enrolled")) throw new FlowError(HELD_ELSEWHERE(user));
    throw e; // ambiguous: the key stays here for the next attempt
  }
  return key;
}

/** A one-time key pair, stored before the request that binds its public half. */
export interface PendingKey {
  publicKey: Uint8Array;
  privateKey: CryptoKey;
}

const MAX_PENDING = 4;

/** Keep a pending key in `slot` before its public half is sent. */
export async function keepPending(ks: KeyStore, slot: string, key: PendingKey): Promise<void> {
  const list = (await ks.get<PendingKey[]>(slot)) ?? [];
  await ks.put(slot, [...list.slice(-(MAX_PENDING - 1)), key]);
}

/** The pending key in `slot` whose public half is `publicKey`, if this browser made it. */
export async function findPending(ks: KeyStore, slot: string, publicKey: Uint8Array): Promise<PendingKey | undefined> {
  return ((await ks.get<PendingKey[]>(slot)) ?? []).find((k) => bytesEqual(k.publicKey, publicKey));
}

export async function dropPending(ks: KeyStore, slot: string, publicKey: Uint8Array): Promise<void> {
  const rest = ((await ks.get<PendingKey[]>(slot)) ?? []).filter((k) => !bytesEqual(k.publicKey, publicKey));
  if (rest.length > 0) await ks.put(slot, rest);
  else await ks.delete(slot);
}

/** True when the service surely did not commit the request: it answered with a client error. */
export function definitelyRejected(e: unknown): boolean {
  return e instanceof ApiError && e.status >= 400 && e.status < 500;
}

export async function requireKey(ks: KeyStore, user: string): Promise<LongTermKey> {
  const k = await longTermKey(ks, user);
  if (!k) throw new FlowError(`This browser holds no key for ${user}. Run demo setup or reset the demo.`);
  return k;
}

export async function directory(api: Api): Promise<Map<string, Uint8Array>> {
  const rows = await api.get<DirectoryEntry[]>("/api/directory");
  return new Map(rows.map((r) => [r.account_id, fromBase64(r.public_key)]));
}

/**
 * Validate a public key the server sent and compute its fingerprint here.
 * Refuse if the server's fingerprint string disagrees (design section 3).
 */
export async function checkedFingerprint(rawB64: string, serverFingerprintHex: string): Promise<{ raw: Uint8Array; label: string }> {
  const raw = fromBase64(rawB64);
  await importRawPublicKey(raw);
  const fp = await fingerprint(raw);
  if (!bytesEqual(fp, fromHex(serverFingerprintHex))) throw new FlowError("the key fingerprint does not match the key; refusing");
  return { raw, label: fingerprintLabel(fp) };
}

export interface Mail {
  id: number;
  subject: string;
  body: string;
  at: string;
}

export function mail(api: Api): Promise<Mail[]> {
  return api.get(`/api/mail?app_name=${encodeURIComponent(api.app)}`);
}

export interface ChainCheck {
  outcome: ReceiptOutcome;
  internallyConsistent: boolean;
  length: number;
}

/** Verify the service's current chain against a receipt the user kept. Runs in the browser. */
export async function checkChain(api: Api, chain: string, receipt: Receipt): Promise<ChainCheck> {
  const data = await api.get<{ entries: RecordEntry[]; receipt: Receipt }>(`/api/records/${encodeURIComponent(chain)}`);
  return {
    outcome: await verifyReceipt(data.entries, receipt),
    internallyConsistent: (await verifyChain(data.entries)).ok,
    length: data.entries.length,
  };
}

export function parseReceipt(text: string): Receipt {
  const m = /^\s*(\d+):([0-9a-f]{64})\s*$/.exec(text);
  if (!m) throw new FlowError("a receipt looks like <length>:<64 hex characters>");
  return { length: Number(m[1]), head: m[2] };
}

export async function advanceClock(api: Api, seconds: number) {
  return api.post<{ server_now: string; offset_seconds: number }>("/api/demo/clock", { advance_seconds: seconds });
}

export async function resetDemo(api: Api, ks: KeyStore) {
  await api.post("/api/demo/reset");
  await ks.clear();
}
