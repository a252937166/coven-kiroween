// Break Glass client flows (spec 05). Every key, share and plaintext stays in
// the calling browser; the service receives public keys and ciphertext only.

import { fromBase64, toBase64 } from "@coven/core-ts/bytes";
import { openApproverShare, sealApproval, sealApproverShare } from "@coven/core-ts/envelope";
import { exportRawPublicKey, generateEphemeralKeyPair } from "@coven/core-ts/keys";
import { openRelease, type LocalPetition, type ReleasePackage } from "@coven/core-ts/release";
import { sealCredential } from "@coven/core-ts/vault";
import type { Api } from "./api.ts";
import { checkedFingerprint, directory, ensureEnrolled, FlowError, requireKey } from "./common.ts";
import type { KeyStore } from "./keystore.ts";

export interface BgItem {
  item_id: string;
  name: string;
  admin_id: string;
  rotation_state: "none" | "rotation_required" | "rotated";
  seal_version_id: string | null;
  threshold: number | null;
  approver_ids: string[];
  sealed_at: string | null;
}

export interface PetitionStatus {
  petition_id: string;
  item_id: string;
  item_name: string;
  seal_version_id: string;
  seal_version_current: boolean;
  requester_id: string;
  requester_public_key: string;
  fingerprint: string;
  reason: string;
  state: "Open" | "Approved" | "Released" | "Expired" | "Denied" | "Invalidated";
  threshold: number;
  approvals: number;
  approved_by: string[];
  self_approved: boolean;
  eligible_approvers: string[];
  created_at: string;
  expires_at: string;
  server_now: string;
  rotation_state: string;
  retrieval_notice: string;
}

export const ADMIN = "user:quinn";
export const APPROVERS = ["user:sage", "user:rowan", "user:ash", "user:wren"];
export const ENGINEERS = ["user:robin", "user:kit"];

export const DEMO_ITEMS = [
  { item_id: "aws-root", name: "AWS root account (fictional)", secret: "root@hollow-example.test / Pumpkin-Lantern-4417 (fictional)" },
  { item_id: "registrar-codes", name: "Domain registrar recovery codes (fictional)", secret: "8F2K-QX7M  3LPT-9WZD  R6YH-2NCB (fictional)" },
  { item_id: "release-signing", name: "Release signing key passphrase (fictional)", secret: "moonlit-cauldron-velvet-71 (fictional)" },
];

/** Seal a credential as a NEW version: fresh key, fresh shares, one blob per approver. */
export async function sealItem(api: Api, itemId: string, plaintext: string, approverIds: string[], threshold: number) {
  const dir = await directory(api);
  const sealed = await sealCredential(itemId, plaintext, approverIds.length, threshold);
  const approver_shares: Record<string, string> = {};
  for (let i = 0; i < approverIds.length; i++) {
    const pub = dir.get(approverIds[i]);
    if (!pub) throw new FlowError(`${approverIds[i]} has not enrolled a key`);
    approver_shares[approverIds[i]] = toBase64(
      await sealApproverShare(sealed.shares[i], pub, { itemId, sealVersionId: sealed.sealVersionId, approverId: approverIds[i] }),
    );
    sealed.shares[i].fill(0);
  }
  return api.post<{ seal_version_id: string; invalidated_petitions: string[] }>(`/api/bg/items/${itemId}/seal-versions`, {
    seal_version_id: sealed.sealVersionId,
    threshold,
    approver_ids: approverIds,
    header: toBase64(sealed.header),
    ciphertext: toBase64(sealed.ciphertext),
    approver_shares,
  });
}

/** Enroll every fictional persona in this browser, then seal the demo items as Quinn. */
export async function setupDemo(api: Api, ks: KeyStore, onStep: (s: string) => void = () => {}) {
  for (const u of [ADMIN, ...APPROVERS, ...ENGINEERS]) {
    await api.signIn(u);
    await ensureEnrolled(api, ks, u);
    onStep(`Enrolled ${u}`);
  }
  await api.signIn(ADMIN);
  for (const it of DEMO_ITEMS) {
    await api.post("/api/bg/items", { item_id: it.item_id, name: it.name });
    await sealItem(api, it.item_id, it.secret, APPROVERS, 2);
    onStep(`Sealed ${it.name}`);
  }
}

export function listItems(api: Api) {
  return api.get<BgItem[]>("/api/bg/items");
}

export function listPetitions(api: Api) {
  return api.get<PetitionStatus[]>("/api/bg/petitions");
}

export function petition(api: Api, pid: string) {
  return api.get<PetitionStatus>(`/api/bg/petitions/${pid}`);
}

/** Requester: generate a non-extractable ephemeral key for this petition and keep it locally. */
export async function openPetition(api: Api, ks: KeyStore, me: string, itemId: string, reason: string, windowSeconds: number) {
  const pair = await generateEphemeralKeyPair();
  const publicKey = await exportRawPublicKey(pair.publicKey);
  const status = await api.post<PetitionStatus>("/api/bg/petitions", {
    item_id: itemId,
    reason,
    requested_window_seconds: windowSeconds,
    requester_public_key: toBase64(publicKey),
  });
  if (status.requester_id !== me || status.item_id !== itemId) throw new FlowError("service bound a different requester or item");
  const local: LocalPetition = {
    petitionId: status.petition_id,
    itemId,
    sealVersionId: status.seal_version_id,
    requesterId: me,
    publicKey,
    privateKey: pair.privateKey,
  };
  await ks.put(`petition:${status.petition_id}`, local);
  return status;
}

/** Approver: open my own share blob, re-encrypt it to the requester key with the six-field binding. */
export async function approvePetition(api: Api, ks: KeyStore, me: string, pid: string) {
  const res = await api.get<{ status: PetitionStatus; approver_share: string }>(`/api/bg/petitions/${pid}/approver-share`);
  const s = res.status;
  const { raw: requesterKey } = await checkedFingerprint(s.requester_public_key, s.fingerprint);
  const mine = await requireKey(ks, me);
  const share = await openApproverShare(fromBase64(res.approver_share), mine.privateKey, mine.publicKey, {
    itemId: s.item_id,
    sealVersionId: s.seal_version_id,
    approverId: me,
  });
  try {
    const envelope = await sealApproval(share, requesterKey, {
      petitionId: s.petition_id,
      itemId: s.item_id,
      sealVersionId: s.seal_version_id,
      requesterId: s.requester_id,
      approverId: me,
    });
    return api.post<{ counted: boolean; status: PetitionStatus }>(`/api/bg/petitions/${pid}/approvals`, { envelope: toBase64(envelope) });
  } finally {
    share.fill(0);
  }
}

export function denyPetition(api: Api, pid: string) {
  return api.post<{ state: string }>(`/api/bg/petitions/${pid}/deny`);
}

export async function hasLocalKey(ks: KeyStore, pid: string) {
  return (await ks.get(`petition:${pid}`)) !== undefined;
}

/** Requester: fetch the package, verify every envelope against MY local record, rebuild, decrypt. */
export async function retrieve(api: Api, ks: KeyStore, pid: string): Promise<{ secret: string; notice: string; expiresAt: string }> {
  const local = await ks.get<LocalPetition>(`petition:${pid}`);
  if (!local) throw new FlowError("this browser no longer holds the petition key (already opened, or a different browser)");
  const pkg = await api.get<ReleasePackage & { retrieval_notice: string; expires_at: string }>(`/api/bg/petitions/${pid}/release`);
  const secret = await openRelease(local, pkg);
  await ks.delete(`petition:${pid}`);
  return { secret, notice: pkg.retrieval_notice, expiresAt: pkg.expires_at };
}

/** Drop the ephemeral key of a petition that is terminal. */
export async function forgetIfTerminal(ks: KeyStore, s: PetitionStatus) {
  if (["Expired", "Denied", "Invalidated"].includes(s.state)) await ks.delete(`petition:${s.petition_id}`);
}

export function confirmRotation(api: Api, itemId: string) {
  return api.post(`/api/bg/items/${itemId}/rotation-confirmed`);
}
