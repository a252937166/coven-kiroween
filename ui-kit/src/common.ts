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

/** Make sure this browser holds a key for `user` and the service has bound its public half. */
export async function ensureEnrolled(api: Api, ks: KeyStore, user: string): Promise<LongTermKey> {
  const existing = await longTermKey(ks, user);
  if (existing) return existing;
  const key = await createLongTermKey(ks, user);
  try {
    await api.post("/api/enroll", { public_key: toBase64(key.publicKey) });
  } catch (e) {
    await ks.delete(`lt:${user}`);
    if (e instanceof ApiError && e.code === "already_enrolled") {
      throw new FlowError(`${user} is enrolled with a key this browser does not hold. Use "Reset demo".`);
    }
    throw e;
  }
  return key;
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
