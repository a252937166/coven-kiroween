// Seal and open helpers for the two sharing modes (proposal section 3.2).
//
// Vault-level (Last Light): one vault key wraps per-item keys. Rebuilding the
// vault key opens the whole vault.
// Item-level (Break Glass): each seal version of one credential has its own
// fresh key, split among approvers. Rebuilding it opens that version only.
//
// Every function here runs in the browser or the offline tool. Keys and
// plaintext never leave the caller.

import { fromUtf8, utf8, type Bytes } from "./bytes.ts";
import { aad, aeadOpen, aeadSeal, checkKeyHeader, generateKey, makeKeyHeader } from "./envelope.ts";
import { splitKey } from "./shares.ts";

// ---------------------------------------------------------------------------
// Break Glass: one seal version of one credential (BG-02.1, BG-02.4)

export interface SealedCredential {
  sealVersionId: string;
  header: Bytes;
  ciphertext: Bytes;
  /** Raw shares, one per approver in order. Seal each to its approver, then drop. */
  shares: Bytes[];
}

/** Fresh random UUIDv4 for a new seal version. */
export function newSealVersionId(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * Seal a credential as a new version: a fresh independent key every time,
 * never derived from an earlier version, and a fresh share set.
 */
export async function sealCredential(
  itemId: string,
  plaintext: string,
  approverCount: number,
  threshold: number,
  sealVersionId: string = newSealVersionId(),
): Promise<SealedCredential> {
  const key = generateKey();
  const header = await makeKeyHeader(key, aad.bgHeader(itemId, sealVersionId));
  const ciphertext = await aeadSeal(key, utf8(plaintext), aad.bgItem(itemId, sealVersionId));
  const shares = await splitKey(key, approverCount, threshold);
  key.fill(0);
  return { sealVersionId, header, ciphertext, shares };
}

/** Header check first; the credential is decrypted only if it passes. */
export async function openCredential(
  key: Uint8Array,
  itemId: string,
  sealVersionId: string,
  header: Uint8Array,
  ciphertext: Uint8Array,
): Promise<string> {
  await checkKeyHeader(key, header, aad.bgHeader(itemId, sealVersionId));
  return fromUtf8(await aeadOpen(key, ciphertext, aad.bgItem(itemId, sealVersionId)));
}

// ---------------------------------------------------------------------------
// Last Light: vault key and its items

export interface SealedVaultKey {
  vaultKey: Bytes;
  header: Bytes;
  shares: Bytes[];
}

export async function sealVaultKey(vaultId: string, trusteeCount: number, threshold: number): Promise<SealedVaultKey> {
  const vaultKey = generateKey();
  const header = await makeKeyHeader(vaultKey, aad.llHeader(vaultId));
  const shares = await splitKey(vaultKey, trusteeCount, threshold);
  return { vaultKey, header, shares };
}

export interface SealedItem {
  wrappedKey: Bytes;
  ciphertext: Bytes;
}

export async function sealVaultItem(vaultKey: Uint8Array, vaultId: string, itemId: string, body: string): Promise<SealedItem> {
  const itemKey = generateKey();
  const ciphertext = await aeadSeal(itemKey, utf8(body), aad.llItem(vaultId, itemId));
  const wrappedKey = await aeadSeal(vaultKey, itemKey, aad.llWrap(vaultId, itemId));
  itemKey.fill(0);
  return { wrappedKey, ciphertext };
}

export function checkVaultKey(vaultKey: Uint8Array, vaultId: string, header: Uint8Array): Promise<void> {
  return checkKeyHeader(vaultKey, header, aad.llHeader(vaultId));
}

/** Caller must have passed checkVaultKey first. */
export async function openVaultItem(
  vaultKey: Uint8Array,
  vaultId: string,
  itemId: string,
  item: SealedItem,
): Promise<string> {
  const itemKey = await aeadOpen(vaultKey, item.wrappedKey, aad.llWrap(vaultId, itemId));
  try {
    return fromUtf8(await aeadOpen(itemKey, item.ciphertext, aad.llItem(vaultId, itemId)));
  } finally {
    itemKey.fill(0);
  }
}
