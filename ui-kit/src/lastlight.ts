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
import type { Api } from "./api.ts";
import { checkedFingerprint, directory, ensureEnrolled, ensureLive, FlowError, requireKey, type Guard } from "./common.ts";
import type { KeyStore } from "./keystore.ts";

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

const ownerBinding = (vaultId: string, owner: string) => ({ vaultId, trusteeId: `owner:${owner}` });
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "item";

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
    for (const it of items) await addItemWithKey(api, vaultKey, vaultId, it);
    return { vaultId, shares };
  } finally {
    vaultKey.fill(0);
  }
}

async function addItemWithKey(api: Api, vaultKey: Uint8Array, vaultId: string, it: NewItem) {
  const itemId = `${slug(it.label)}-${globalThis.crypto.randomUUID().slice(0, 8)}`;
  const sealed = await sealVaultItem(vaultKey, vaultId, itemId, it.body);
  await api.post(`/api/ll/vaults/${vaultId}/items`, {
    item_id: itemId,
    label: it.label,
    deliver_to: it.deliverTo,
    earliest_release: it.earliestRelease,
    wrapped_key: toBase64(sealed.wrappedKey),
    ciphertext: toBase64(sealed.ciphertext),
  });
}

/** Owner adds a letter later: unwrap the vault key with the owner's key, in this browser. */
export async function addItem(api: Api, ks: KeyStore, owner: string, vaultId: string, it: NewItem) {
  const ownerKey = await requireKey(ks, owner);
  const { owner_key_blob } = await api.get<{ owner_key_blob: string }>(`/api/ll/vaults/${vaultId}/owner-key`);
  const vaultKey = await openTrusteeShare(fromBase64(owner_key_blob), ownerKey.privateKey, ownerKey.publicKey, ownerBinding(vaultId, owner));
  try {
    await addItemWithKey(api, vaultKey, vaultId, it);
  } finally {
    vaultKey.fill(0);
  }
}

export async function setupDemo(api: Api, ks: KeyStore, onStep: (s: string) => void = () => {}) {
  for (const u of [OWNER, ...TRUSTEES]) {
    await api.signIn(u);
    await ensureEnrolled(api, ks, u);
    onStep(`Enrolled ${u}`);
  }
  await api.signIn(OWNER);
  const v = await createVault(api, ks, OWNER, "The Hollow family vault (fictional)", TRUSTEES, 3, 30, 14, DEMO_ITEMS);
  v.shares.forEach((s) => s.fill(0));
  onStep("Created the vault and sealed three items");
  return v.vaultId;
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

export async function beginRecovery(api: Api, ks: KeyStore, me: string, vaultId: string, guard?: Guard) {
  const pair = await generateEphemeralKeyPair();
  const publicKey = await exportRawPublicKey(pair.publicKey);
  ensureLive(guard);
  const status = await api.post<VaultStatus>(`/api/ll/vaults/${vaultId}/recoveries`, { public_key: toBase64(publicKey) });
  const r = status.recovery;
  if (!r || r.recoverer_id !== me) throw new FlowError("service did not bind this recovery to you");
  const local: LocalRecovery = { recoveryId: r.recovery_id, vaultId, recovererId: me, publicKey, privateKey: pair.privateKey };
  await ks.put(`recovery:${r.recovery_id}`, local);
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
export async function completeRecovery(api: Api, ks: KeyStore, rid: string, guard?: Guard): Promise<OpenedRecovery & { receipt: Receipt }> {
  const local = await ks.get<LocalRecovery>(`recovery:${rid}`);
  if (!local) throw new FlowError("this browser does not hold the key for this recovery");
  ensureLive(guard);
  const pkg = await api.get<RecoveryPackage & { receipt: Receipt }>(`/api/ll/recoveries/${rid}/package`);
  ensureLive(guard);
  const opened = await openRecovery(local, pkg);
  return { ...opened, receipt: pkg.receipt };
}

export function bundle(api: Api, vaultId: string) {
  return api.get<unknown>(`/api/ll/vaults/${vaultId}/bundle`);
}
