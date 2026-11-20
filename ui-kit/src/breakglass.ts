// Break Glass client flows (spec 05). Every key, share and plaintext stays in
// the calling browser; the service receives public keys and ciphertext only.

import { bytesEqual, fromBase64, toBase64 } from "@coven/core-ts/bytes";
import { openApproverShare, sealApproval, sealApproverShare } from "@coven/core-ts/envelope";
import { exportRawPublicKey, generateEphemeralKeyPair } from "@coven/core-ts/keys";
import { openRelease, type LocalPetition, type ReleasePackage } from "@coven/core-ts/release";
import { sealCredential } from "@coven/core-ts/vault";
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
  /** This petition's release opened the item's current rotation obligation (its requester may record the rotation). */
  rotation_owed: boolean;
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

/** How far demo setup got. Ready only when every demo item exists and has a sealed version. */
export function demoProgress(items: BgItem[]): { sealed: number; total: number; ready: boolean } {
  const sealed = DEMO_ITEMS.filter((d) => items.some((i) => i.item_id === d.item_id && i.seal_version_id)).length;
  return { sealed, total: DEMO_ITEMS.length, ready: sealed === DEMO_ITEMS.length };
}

/**
 * Enroll every fictional persona in this browser, then seal the demo items as Quinn.
 * Resumable: an interrupted run (or one whose answer was lost) is finished by
 * running it again. It creates only missing items and seals only unsealed
 * ones, so a retry never duplicates an item or reseals a sealed one.
 */
export async function setupDemo(api: Api, ks: KeyStore, onStep: (s: string) => void = () => {}) {
  for (const u of [ADMIN, ...APPROVERS, ...ENGINEERS]) {
    await api.signIn(u);
    await ensureEnrolled(api, ks, u);
    onStep(`Enrolled ${u}`);
  }
  await api.signIn(ADMIN);
  const existing = new Map((await listItems(api)).map((i) => [i.item_id, i]));
  for (const it of DEMO_ITEMS) {
    const row = existing.get(it.item_id);
    if (row && row.admin_id !== ADMIN) throw new FlowError(`${it.item_id} belongs to another admin; use "Reset demo"`);
    if (!row) {
      try {
        await api.post("/api/bg/items", { item_id: it.item_id, name: it.name });
      } catch (e) {
        if (!(e instanceof ApiError && e.code === "item_exists")) throw e;
      }
    }
    if (row?.seal_version_id) {
      onStep(`Already sealed: ${it.name}`);
      continue;
    }
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

const pendingPetitionSlot = (me: string, itemId: string) => `petition-pending:${me}:${itemId}`;

/**
 * Adopt petitions the service bound to one-time keys made in this browser,
 * when the answer to the open request was lost. Each must be this requester's
 * own Open or Approved petition, and its listed public key must equal a key
 * kept for that same item. Returns the adopted petition IDs.
 */
export async function reconcilePetitions(ks: KeyStore, me: string, listed: PetitionStatus[]): Promise<string[]> {
  const adopted: string[] = [];
  for (const s of listed) {
    if (s.requester_id !== me || (s.state !== "Open" && s.state !== "Approved")) continue;
    if (await hasLocalKey(ks, s.petition_id)) continue;
    const slot = pendingPetitionSlot(me, s.item_id);
    if (!(await ks.get(slot))) continue;
    const { raw } = await checkedFingerprint(s.requester_public_key, s.fingerprint);
    const hit = await findPending(ks, slot, raw);
    if (!hit) continue;
    const local: LocalPetition = {
      petitionId: s.petition_id,
      itemId: s.item_id,
      sealVersionId: s.seal_version_id,
      requesterId: me,
      publicKey: hit.publicKey,
      privateKey: hit.privateKey,
    };
    await ks.put(`petition:${s.petition_id}`, local);
    await dropPending(ks, slot, hit.publicKey);
    adopted.push(s.petition_id);
  }
  return adopted;
}

/**
 * Requester: generate a non-extractable ephemeral key for this petition and keep it locally.
 * The key is stored before the request, so if the service commits but the
 * answer is lost, a read-back (now, or on the next load) adopts the petition.
 */
export async function openPetition(api: Api, ks: KeyStore, me: string, itemId: string, reason: string, windowSeconds: number, guard?: Guard) {
  const pair = await generateEphemeralKeyPair();
  const publicKey = await exportRawPublicKey(pair.publicKey);
  const slot = pendingPetitionSlot(me, itemId);
  await keepPending(ks, slot, { publicKey, privateKey: pair.privateKey });
  ensureLive(guard);
  let status: PetitionStatus;
  try {
    status = await api.post<PetitionStatus>("/api/bg/petitions", {
      item_id: itemId,
      reason,
      requested_window_seconds: windowSeconds,
      requester_public_key: toBase64(publicKey),
    });
  } catch (e) {
    if (definitelyRejected(e)) {
      await dropPending(ks, slot, publicKey); // the service refused; this key was never bound
      throw e;
    }
    if (e instanceof StaleFlowError || (guard && !guard())) throw e;
    const listed = await listPetitions(api).catch(() => null);
    if (listed) {
      await reconcilePetitions(ks, me, listed);
      const mine = listed.find((s) => s.requester_id === me && s.item_id === itemId && bytesEqual(fromBase64(s.requester_public_key), publicKey));
      if (mine && (await hasLocalKey(ks, mine.petition_id))) return mine;
    }
    throw e; // still ambiguous: the key stays here, and the next load can adopt it
  }
  if (status.requester_id !== me || status.item_id !== itemId) throw new FlowError("service bound a different requester or item");
  if (!bytesEqual(fromBase64(status.requester_public_key), publicKey)) throw new FlowError("service bound a different key to this petition; refusing");
  const local: LocalPetition = {
    petitionId: status.petition_id,
    itemId,
    sealVersionId: status.seal_version_id,
    requesterId: me,
    publicKey,
    privateKey: pair.privateKey,
  };
  await ks.put(`petition:${status.petition_id}`, local);
  await dropPending(ks, slot, publicKey);
  return status;
}

/** Approver: open my own share blob, re-encrypt it to the requester key with the six-field binding. */
export async function approvePetition(api: Api, ks: KeyStore, me: string, pid: string, guard?: Guard) {
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
    ensureLive(guard);
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
export async function retrieve(api: Api, ks: KeyStore, pid: string, guard?: Guard): Promise<{ secret: string; notice: string; expiresAt: string }> {
  const local = await ks.get<LocalPetition>(`petition:${pid}`);
  if (!local) throw new FlowError("this browser no longer holds the petition key (already opened, or a different browser)");
  ensureLive(guard);
  let pkg: ReleasePackage & { retrieval_notice: string; expires_at: string };
  try {
    pkg = await api.get(`/api/bg/petitions/${pid}/release`);
  } catch (e) {
    // 410: expired, denied or invalidated. The service will never serve this
    // petition again, so the petition key is no longer useful here.
    if (e instanceof ApiError && e.status === 410) await ks.delete(`petition:${pid}`);
    throw e;
  }
  // Do not decrypt for a persona that is no longer active. The key stays, so the
  // requester can retrieve again inside the window.
  ensureLive(guard);
  const secret = await openRelease(local, pkg);
  await ks.delete(`petition:${pid}`);
  // Local evidence only (no material): this browser opened the petition, so later
  // views can say so instead of guessing why the key is gone.
  await ks.put(`petition-opened:${pid}`, true);
  return { secret, notice: pkg.retrieval_notice, expiresAt: pkg.expires_at };
}

/** True when this browser decrypted the petition earlier (and then deleted its key). */
export async function openedHere(ks: KeyStore, pid: string) {
  return (await ks.get(`petition-opened:${pid}`)) !== undefined;
}

/**
 * Same-origin link to a petition. It carries only the opaque petition ID, in
 * the URL fragment (never sent in requests). It grants nothing by itself:
 * every retrieval is still checked against the signed-in session.
 */
export function petitionLink(origin: string, pathname: string, pid: string): string {
  return `${origin}${pathname}#petition=${encodeURIComponent(pid)}`;
}

export function petitionIdFromHash(hash: string): string | null {
  const m = /^#petition=([0-9a-f-]{36})$/.exec(hash);
  return m ? m[1] : null;
}

/** Drop the ephemeral key of a petition that is terminal. */
export async function forgetIfTerminal(ks: KeyStore, s: PetitionStatus) {
  if (["Expired", "Denied", "Invalidated"].includes(s.state)) await ks.delete(`petition:${s.petition_id}`);
}

export function confirmRotation(api: Api, itemId: string) {
  return api.post(`/api/bg/items/${itemId}/rotation-confirmed`);
}
