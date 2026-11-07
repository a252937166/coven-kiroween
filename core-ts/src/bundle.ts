// The exported bundle "coven/v1" and offline recovery from it.
//
// A bundle holds only ciphertext and metadata: the vault key header, wrapped
// item keys, item ciphertexts and a record snapshot with its receipt. It holds
// no shares and no keys. Anyone with the bundle and k valid shares can open
// the whole vault at any time, with or without the service. Earliest release
// dates are online policy only; offline recovery reports them but does not
// enforce them.

import { bytesEqual, fromBase64, type Bytes } from "./bytes.ts";
import { HeaderCheckError } from "./envelope.ts";
import type { Receipt, RecordEntry } from "./records.ts";
import { combineShares, decodeShareText, shareIndex, shareTag, ShareError } from "./shares.ts";
import { checkVaultKey, openVaultItem } from "./vault.ts";

export const BUNDLE_FORMAT = "coven/v1";

export interface BundleItem {
  id: string;
  label: string;
  deliverTo: string[];
  earliestRelease: string | null;
  wrappedKey: string;
  ciphertext: string;
}

export interface Bundle {
  format: typeof BUNDLE_FORMAT;
  kind: "last-light-vault";
  exportedAt: string;
  vault: { id: string; name: string; threshold: number; trustees: { id: string; name: string }[] };
  header: string;
  items: BundleItem[];
  record: { entries: RecordEntry[]; receipt: Receipt };
}

export class BundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BundleError";
  }
}

const isStr = (x: unknown): x is string => typeof x === "string";

/** Validate structure. Throws BundleError with a reason; never echoes ciphertext. */
export function parseBundle(json: unknown): Bundle {
  const b = json as Bundle;
  if (!b || typeof b !== "object") throw new BundleError("bundle is not an object");
  if (b.format !== BUNDLE_FORMAT) throw new BundleError(`unsupported format, expected ${BUNDLE_FORMAT}`);
  if (b.kind !== "last-light-vault") throw new BundleError("unsupported bundle kind");
  const v = b.vault;
  if (!v || !isStr(v.id) || !isStr(v.name) || !Number.isInteger(v.threshold) || v.threshold < 2) {
    throw new BundleError("vault section is invalid");
  }
  if (!Array.isArray(v.trustees)) throw new BundleError("vault trustees missing");
  if (!isStr(b.header)) throw new BundleError("vault header missing");
  if (!Array.isArray(b.items)) throw new BundleError("items missing");
  for (const it of b.items) {
    if (!it || !isStr(it.id) || !isStr(it.label) || !isStr(it.wrappedKey) || !isStr(it.ciphertext)) {
      throw new BundleError("an item is invalid");
    }
    if (!Array.isArray(it.deliverTo)) throw new BundleError("an item is invalid");
  }
  if (!b.record || !Array.isArray(b.record.entries) || !b.record.receipt) throw new BundleError("record snapshot missing");
  return b;
}

export interface RecoveredItem {
  id: string;
  label: string;
  deliverTo: string[];
  earliestRelease: string | null;
  body: string;
}

export interface ShareProblem {
  /** 1-based position of the share argument. Never the share itself. */
  position: number;
  reason: string;
}

export class RecoveryError extends Error {
  readonly problems: ShareProblem[];
  constructor(message: string, problems: ShareProblem[] = []) {
    super(message);
    this.name = "RecoveryError";
    this.problems = problems;
  }
}

/** Decode share texts and reject malformed, foreign and duplicate ones before combining. */
export async function collectShares(bundle: Bundle, shareTexts: readonly string[]): Promise<Bytes[]> {
  const tag = await shareTag(bundle.vault.id);
  const problems: ShareProblem[] = [];
  const accepted: Bytes[] = [];
  shareTexts.forEach((text, i) => {
    let d;
    try {
      d = decodeShareText(text);
    } catch (e) {
      problems.push({ position: i + 1, reason: e instanceof ShareError ? e.message : "malformed share" });
      return;
    }
    if (!bytesEqual(d.tag, tag)) {
      problems.push({ position: i + 1, reason: "share belongs to a different vault" });
      return;
    }
    if (accepted.some((s) => shareIndex(s) === shareIndex(d.share))) {
      problems.push({ position: i + 1, reason: "duplicate share" });
      return;
    }
    accepted.push(d.share);
  });
  if (problems.length > 0) throw new RecoveryError("some shares were rejected", problems);
  if (accepted.length < bundle.vault.threshold) {
    throw new RecoveryError(`need ${bundle.vault.threshold} distinct valid shares, got ${accepted.length}`);
  }
  return accepted;
}

/** Rebuild the vault key, check its header, then open every item. */
export async function recoverVault(bundle: Bundle, shareTexts: readonly string[]): Promise<RecoveredItem[]> {
  const shares = await collectShares(bundle, shareTexts);
  const vaultKey = await combineShares(shares, bundle.vault.threshold);
  try {
    try {
      await checkVaultKey(vaultKey, bundle.vault.id, fromBase64(bundle.header));
    } catch (e) {
      if (e instanceof HeaderCheckError) {
        throw new RecoveryError("the shares do not rebuild this vault's key (one is wrong); nothing was decrypted");
      }
      throw e;
    }
    const out: RecoveredItem[] = [];
    for (const it of bundle.items) {
      const body = await openVaultItem(vaultKey, bundle.vault.id, it.id, {
        wrappedKey: fromBase64(it.wrappedKey),
        ciphertext: fromBase64(it.ciphertext),
      });
      out.push({ id: it.id, label: it.label, deliverTo: it.deliverTo, earliestRelease: it.earliestRelease, body });
    }
    return out;
  } finally {
    vaultKey.fill(0);
  }
}
