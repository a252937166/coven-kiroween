// Last Light client flows. The vault key, item keys, shares and plaintext stay
// in the calling browser. Share cards are rendered locally; their QR payload
// and word code are never sent to the service.

import { fromBase64, toBase64 } from "@coven/core-ts/bytes";
import { openTrusteeShare, sealRecoveryShare, sealTrusteeShare } from "@coven/core-ts/envelope";
import { exportRawPublicKey, generateEphemeralKeyPair } from "@coven/core-ts/keys";
import type { Receipt } from "@coven/core-ts/records";
import { openRecovery, type LocalRecovery, type OpenedRecovery, type RecoveryPackage } from "@coven/core-ts/release";
import { decodeShareFor, encodeQrPayload, encodeWordCode, shareTag } from "@coven/core-ts/shares";
import { sealVaultItem, sealVaultKey } from "@coven/core-ts/vault";
import { ApiError, type Api } from "./api.ts";
import {
  checkedFingerprint,
  definitelyRejected,
  directory,
  dropPending,
  ensureEnrolled,
  ensureLive,
  findPending,
  FlowError,
  keepPending,
  requireKey,
  StaleFlowError,
  type Guard,
} from "./common.ts";
import { longTermKey, type KeyStore } from "./keystore.ts";

export const OWNER = "user:mara";
export const TRUSTEES = ["user:ada", "user:bram", "user:cleo", "user:dov", "user:esme"];

export interface VaultStatus {
  vault_id: string;
  name: string;
  owner_id: string;
  role: "owner" | "trustee";
  threshold: number;
  trustee_ids: string[];
  state: "Lit" | "Flicker" | "Vigil" | "Handover" | "Released";
  last_checkin_at: string;
  next_due_at: string;
  vigil_starts_at: string;
  handover_at: string;
  cadence_days: number;
  vigil_days: number;
  server_now: string;
  items: { item_id: string; label: string; deliver_to: string[]; earliest_release: string | null }[];
  recovery: null | {
    recovery_id: string;
    recoverer_id: string;
    public_key: string;
    fingerprint: string;
    state: "Open" | "Complete" | "Cancelled";
    submitted_by: string[];
    created_at: string;
  };
  receipt: Receipt;
}

export interface NewItem {
  label: string;
  deliverTo: string[];
  earliestRelease: string | null;
  body: string;
}

export const DEMO_ITEMS: NewItem[] = [
  { label: "Letter to the family", deliverTo: ["Ada", "Bram"], earliestRelease: null, body: "Dear Ada and Bram,\n\nThe spare house key is in the blue pumpkin by the door. Please feed Biscuit the cat.\n\nWith love, Mara (fictional)" },
  { label: "Home Wi-Fi and router", deliverTo: ["Cleo"], earliestRelease: null, body: "Network: hollow-house\nPassword: candle-and-moth-22 (fictional)" },
  { label: "Letter for Esme's 18th birthday", deliverTo: ["Esme"], earliestRelease: "2031-06-01", body: "Happy birthday, Esme. (fictional)" },
];

export const DEMO_VAULT_NAME = "The Hollow family vault (fictional)";

const ownerBinding = (vaultId: string, owner: string) => ({ vaultId, trusteeId: `owner:${owner}` });
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "item";
/** Demo letters get fixed IDs, so a retried setup cannot add the same letter twice. */
const demoItemId = (it: NewItem) => `demo-${slug(it.label)}`;

/** How far demo setup got. Ready only when the vault holds every demo letter. */
export function demoProgress(v: Pick<VaultStatus, "items"> | undefined): { sealed: number; total: number; ready: boolean } {
  const sealed = v ? DEMO_ITEMS.filter((d) => v.items.some((i) => i.label === d.label)).length : 0;
  return { sealed, total: DEMO_ITEMS.length, ready: sealed === DEMO_ITEMS.length };
}

export interface CreatedVault {
  vaultId: string;
  /** Raw shares in trustee order, for printing cards right now. The caller must drop them. */
  shares: Uint8Array[];
}

export async function createVault(
  api: Api,
  ks: KeyStore,
  owner: string,
  name: string,
  trusteeIds: string[],
  threshold: number,
  cadenceDays: number,
  vigilDays: number,
  items: NewItem[],
  itemId?: (it: NewItem) => string,
): Promise<CreatedVault> {
  const dir = await directory(api);
  const ownerKey = await requireKey(ks, owner);
  const vaultId = globalThis.crypto.randomUUID();
  const { vaultKey, header, shares } = await sealVaultKey(vaultId, trusteeIds.length, threshold);
  try {
    const trustee_shares: Record<string, string> = {};
    for (let i = 0; i < trusteeIds.length; i++) {
      const pub = dir.get(trusteeIds[i]);
      if (!pub) throw new FlowError(`${trusteeIds[i]} has not enrolled a key`);
      trustee_shares[trusteeIds[i]] = toBase64(await sealTrusteeShare(shares[i], pub, { vaultId, trusteeId: trusteeIds[i] }));
    }
    const owner_key_blob = toBase64(await sealTrusteeShare(vaultKey, ownerKey.publicKey, ownerBinding(vaultId, owner)));
    await api.post("/api/ll/vaults", {
      vault_id: vaultId,
      name,
      threshold,
      trustee_ids: trusteeIds,
      header: toBase64(header),
      owner_key_blob,
      trustee_shares,
      cadence_days: cadenceDays,
      vigil_days: vigilDays,
    });
    for (const it of items) await addItemWithKey(api, vaultKey, vaultId, it, itemId?.(it));
    return { vaultId, shares };
  } finally {
    vaultKey.fill(0);
  }
}

/**
 * Seal one letter and send it. With a fixed `fixedId` (demo letters), an
 * "item exists" answer means an earlier attempt already stored this letter.
 */
async function addItemWithKey(api: Api, vaultKey: Uint8Array, vaultId: string, it: NewItem, fixedId?: string) {
  const itemId = fixedId ?? `${slug(it.label)}-${globalThis.crypto.randomUUID().slice(0, 8)}`;
  const sealed = await sealVaultItem(vaultKey, vaultId, itemId, it.body);
  try {
    await api.post(`/api/ll/vaults/${vaultId}/items`, {
      item_id: itemId,
      label: it.label,
      deliver_to: it.deliverTo,
      earliest_release: it.earliestRelease,
      wrapped_key: toBase64(sealed.wrappedKey),
      ciphertext: toBase64(sealed.ciphertext),
    });
  } catch (e) {
    if (!(fixedId && e instanceof ApiError && e.code === "item_exists")) throw e;
  }
}

/** Owner adds a letter later: unwrap the vault key with the owner's key, in this browser. */
export async function addItem(api: Api, ks: KeyStore, owner: string, vaultId: string, it: NewItem, fixedId?: string) {
  const ownerKey = await requireKey(ks, owner);
  const { owner_key_blob } = await api.get<{ owner_key_blob: string }>(`/api/ll/vaults/${vaultId}/owner-key`);
  const vaultKey = await openTrusteeShare(fromBase64(owner_key_blob), ownerKey.privateKey, ownerKey.publicKey, ownerBinding(vaultId, owner));
  try {
    await addItemWithKey(api, vaultKey, vaultId, it, fixedId);
  } finally {
    vaultKey.fill(0);
  }
}

/**
 * Enroll the fictional family, then create the demo vault and its letters.
 * Resumable: an interrupted run (or one whose answer was lost) is finished by
 * running it again. It reuses the demo vault if it exists and adds only the
 * missing letters, so a retry never creates a second vault or letter.
 */
export async function setupDemo(api: Api, ks: KeyStore, onStep: (s: string) => void = () => {}) {
  for (const u of [OWNER, ...TRUSTEES]) {
    await api.signIn(u);
    await ensureEnrolled(api, ks, u);
    onStep(`Enrolled ${u}`);
  }
  await api.signIn(OWNER);
  const found = (await listVaults(api)).find((v) => v.owner_id === OWNER && v.name === DEMO_VAULT_NAME);
  if (!found) {
    const v = await createVault(api, ks, OWNER, DEMO_VAULT_NAME, TRUSTEES, 3, 30, 14, DEMO_ITEMS, demoItemId);
    v.shares.forEach((s) => s.fill(0));
    onStep("Created the vault and sealed three items");
    return v.vaultId;
  }
  const missing = DEMO_ITEMS.filter((d) => !found.items.some((i) => i.label === d.label));
  if (missing.length > 0 && !(await longTermKey(ks, OWNER))) {
    throw new FlowError(
      "The demo vault was started in another browser, or this browser's demo keys were cleared, so its letters cannot be added here. Use \"Reset demo\" to start over.",
    );
  }
  for (const it of missing) {
    await addItem(api, ks, OWNER, found.vault_id, it, demoItemId(it));
    onStep(`Sealed ${it.label}`);
  }
  onStep(missing.length > 0 ? "Finished the demo vault" : "The demo vault was already complete");
  return found.vault_id;
}

export function listVaults(api: Api) {
  return api.get<VaultStatus[]>("/api/ll/vaults");
}

export function vault(api: Api, vaultId: string) {
  return api.get<VaultStatus>(`/api/ll/vaults/${vaultId}`);
}

export function checkIn(api: Api, vaultId: string) {
  return api.post<VaultStatus>(`/api/ll/vaults/${vaultId}/checkin`);
}

export interface CardContent {
  qr: string;
  words: string;
}

/** Encode a share for printing. Runs locally; nothing here is sent anywhere. */
export async function cardFor(vaultId: string, share: Uint8Array): Promise<CardContent> {
  const tag = await shareTag(vaultId);
  return { qr: encodeQrPayload(tag, share), words: encodeWordCode(tag, share) };
}

/** Trustee: decrypt my own share in this browser and encode it for a card. */
export async function myCard(api: Api, ks: KeyStore, me: string, vaultId: string, guard?: Guard): Promise<CardContent> {
  const share = await myShare(api, ks, me, vaultId);
  if (guard && !guard()) {
    share.fill(0);
    ensureLive(guard);
  }
  try {
    return await cardFor(vaultId, share);
  } finally {
    share.fill(0);
  }
}

async function myShare(api: Api, ks: KeyStore, me: string, vaultId: string): Promise<Uint8Array> {
  const key = await requireKey(ks, me);
  const { share_blob } = await api.get<{ share_blob: string }>(`/api/ll/vaults/${vaultId}/my-share`);
  return openTrusteeShare(fromBase64(share_blob), key.privateKey, key.publicKey, { vaultId, trusteeId: me });
}

/** Record that a card was issued. The request body is empty: no share, no encoding. */
export function recordCardIssued(api: Api, vaultId: string) {
  return api.post<{ receipt: Receipt }>(`/api/ll/vaults/${vaultId}/card-issued`);
}

const pendingRecoverySlot = (vaultId: string, me: string) => `recovery-pending:${vaultId}:${me}`;

/**
 * Adopt a recovery that the service bound to a one-time key made in this
 * browser, when the answer to the open request was lost. It matches the
 * listed recovery's public key exactly, for this vault, with `me` as both a
 * trustee and the recovering trustee. Returns true when this browser holds
 * the key for the listed recovery (already, or now).
 */
export async function reconcileRecovery(ks: KeyStore, me: string, status: VaultStatus): Promise<boolean> {
  const r = status.recovery;
  if (!r || r.recoverer_id !== me || !status.trustee_ids.includes(me) || (r.state !== "Open" && r.state !== "Complete")) return false;
  if (await hasRecoveryKey(ks, r.recovery_id)) return true;
  const slot = pendingRecoverySlot(status.vault_id, me);
  const { raw } = await checkedFingerprint(r.public_key, r.fingerprint);
  const hit = await findPending(ks, slot, raw);
  // No pending key: another view of this page may have just adopted it.
  if (!hit) return hasRecoveryKey(ks, r.recovery_id);
  const local: LocalRecovery = { recoveryId: r.recovery_id, vaultId: status.vault_id, recovererId: me, publicKey: hit.publicKey, privateKey: hit.privateKey };
  await ks.put(`recovery:${r.recovery_id}`, local);
  await dropPending(ks, slot, hit.publicKey);
  return true;
}

/**
 * Open a recovery. The one-time private key is stored here before the request,
 * so if the service commits but the answer is lost, a read-back (now, or on
 * the next load) adopts the recovery instead of stranding it without a key.
 */
export async function beginRecovery(api: Api, ks: KeyStore, me: string, vaultId: string, guard?: Guard) {
  const before = await vault(api, vaultId);
  ensureLive(guard);
  if (await reconcileRecovery(ks, me, before)) return before; // an earlier attempt's lost answer
  const pair = await generateEphemeralKeyPair();
  const publicKey = await exportRawPublicKey(pair.publicKey);
  const slot = pendingRecoverySlot(vaultId, me);
  await keepPending(ks, slot, { publicKey, privateKey: pair.privateKey });
  ensureLive(guard);
  let status: VaultStatus;
  try {
    status = await api.post<VaultStatus>(`/api/ll/vaults/${vaultId}/recoveries`, { public_key: toBase64(publicKey) });
  } catch (e) {
    if (definitelyRejected(e)) {
      await dropPending(ks, slot, publicKey); // the service refused; this key was never bound
      throw e;
    }
    if (e instanceof StaleFlowError || (guard && !guard())) throw e;
    const after = await vault(api, vaultId).catch(() => null);
    if (after && (await reconcileRecovery(ks, me, after))) return after;
    throw e; // still ambiguous: the key stays here, and the next load can adopt it
  }
  const r = status.recovery;
  if (!r || r.recoverer_id !== me) throw new FlowError("service did not bind this recovery to you");
  if (!(await reconcileRecovery(ks, me, status))) throw new FlowError("the service bound a different key to this recovery; refusing");
  return status;
}

/**
 * Trustee: send my share to the recovering trustee's key. The share comes from
 * my digital copy, or from the word code / QR text I read off my printed card.
 * Either way it is sealed here; only the envelope reaches the service.
 */
export async function submitShare(api: Api, ks: KeyStore, me: string, status: VaultStatus, printedText?: string, guard?: Guard) {
  const r = status.recovery;
  // "Complete" means the package was served; trustees may still add a share.
  if (!r || (r.state !== "Open" && r.state !== "Complete")) throw new FlowError("no open recovery");
  const { raw } = await checkedFingerprint(r.public_key, r.fingerprint);
  const share = printedText ? await decodeShareFor(printedText, status.vault_id) : await myShare(api, ks, me, status.vault_id);
  try {
    const envelope = await sealRecoveryShare(share, raw, {
      recoveryId: r.recovery_id,
      vaultId: status.vault_id,
      recovererId: r.recoverer_id,
      trusteeId: me,
    });
    ensureLive(guard);
    return api.post<{ counted: boolean; vault: VaultStatus }>(`/api/ll/recoveries/${r.recovery_id}/shares`, { envelope: toBase64(envelope) });
  } finally {
    share.fill(0);
  }
}

export async function hasRecoveryKey(ks: KeyStore, rid: string) {
  return (await ks.get(`recovery:${rid}`)) !== undefined;
}

/**
 * Recovering trustee: fetch the encrypted package, then rebuild and verify the
 * vault key here. The service marks the vault Released when it serves the
 * package, before this browser has verified anything. If a contribution does
 * not decrypt, openRecovery throws RecoveryIncompleteError naming it; another
 * trustee can add a share to the same recovery and this can be called again.
 * The recovery key stays in this browser for that retry.
 */
/** `onPackage` is metadata only: it fires once the encrypted package has arrived in this browser, before any decryption. */
export async function completeRecovery(
  api: Api,
  ks: KeyStore,
  rid: string,
  guard?: Guard,
  onPackage?: () => void,
): Promise<OpenedRecovery & { receipt: Receipt }> {
  const local = await ks.get<LocalRecovery>(`recovery:${rid}`);
  if (!local) throw new FlowError("this browser does not hold the key for this recovery");
  ensureLive(guard);
  const pkg = await api.get<RecoveryPackage & { receipt: Receipt }>(`/api/ll/recoveries/${rid}/package`);
  ensureLive(guard);
  onPackage?.();
  const opened = await openRecovery(local, pkg);
  return { ...opened, receipt: pkg.receipt };
}

export function bundle(api: Api, vaultId: string) {
  return api.get<unknown>(`/api/ll/vaults/${vaultId}/bundle`);
}
