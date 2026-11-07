// Client-side verification of release packages (spec 05 design section 6).
//
// The binding for every envelope comes from the client's OWN local record
// (petition or recovery), never from the response body, plus the approver or
// trustee ID attached to each envelope. A share is passed to combine only
// after its envelope authenticates under that binding.

import { fromBase64, type Bytes } from "./bytes.ts";
import { EnvelopeError, HeaderCheckError, openApproval, openRecoveryShare } from "./envelope.ts";
import { combineShares, shareIndex } from "./shares.ts";
import { checkVaultKey, openCredential, openVaultItem } from "./vault.ts";

export class ReleaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReleaseError";
  }
}

/** What the requester's browser stored when it opened the petition. */
export interface LocalPetition {
  petitionId: string;
  itemId: string;
  sealVersionId: string;
  requesterId: string;
  publicKey: Uint8Array;
  privateKey: CryptoKey;
}

export interface ReleasePackage {
  seal_version_id: string;
  threshold: number;
  item_header: string;
  item_ciphertext: string;
  envelopes: { approver_id: string; envelope: string }[];
}

async function openAll<T extends { id: string; envelope: string }>(
  entries: T[],
  threshold: number,
  open: (env: Bytes, id: string) => Promise<Bytes>,
): Promise<Bytes[]> {
  const ids = entries.map((e) => e.id);
  if (new Set(ids).size !== ids.length) throw new ReleaseError("two envelopes name the same approver");
  if (entries.length < threshold) throw new ReleaseError(`need ${threshold} envelopes, got ${entries.length}`);
  const shares: Bytes[] = [];
  for (const e of entries) {
    try {
      shares.push(await open(fromBase64(e.envelope), e.id));
    } catch (err) {
      if (err instanceof EnvelopeError) throw new ReleaseError(`envelope from ${e.id} does not match this request; rejected`);
      throw err;
    }
  }
  const xs = shares.map(shareIndex);
  if (new Set(xs).size !== xs.length) throw new ReleaseError("duplicate share indices");
  return shares;
}

/** BG-03.4 and BG-02.4: verify every envelope, combine, check the header, then decrypt. */
export async function openRelease(local: LocalPetition, pkg: ReleasePackage): Promise<string> {
  if (pkg.seal_version_id !== local.sealVersionId) throw new ReleaseError("package is for a different seal version");
  const shares = await openAll(
    pkg.envelopes.map((e) => ({ id: e.approver_id, envelope: e.envelope })),
    pkg.threshold,
    (env, approverId) =>
      openApproval(env, local.privateKey, local.publicKey, {
        petitionId: local.petitionId,
        itemId: local.itemId,
        sealVersionId: local.sealVersionId,
        requesterId: local.requesterId,
        approverId,
      }),
  );
  const key = await combineShares(shares, pkg.threshold);
  try {
    return await openCredential(key, local.itemId, local.sealVersionId, fromBase64(pkg.item_header), fromBase64(pkg.item_ciphertext));
  } catch (e) {
    if (e instanceof HeaderCheckError) throw new ReleaseError("shares do not rebuild this version's key; nothing was decrypted");
    throw e;
  } finally {
    key.fill(0);
  }
}

// ---------------------------------------------------------------------------
// Last Light online recovery

export interface LocalRecovery {
  recoveryId: string;
  vaultId: string;
  recovererId: string;
  publicKey: Uint8Array;
  privateKey: CryptoKey;
}

export interface RecoveryPackage {
  vault_id: string;
  threshold: number;
  header: string;
  envelopes: { trustee_id: string; envelope: string }[];
  items: {
    item_id: string;
    label: string;
    deliver_to: string[];
    earliest_release: string | null;
    wrapped_key?: string;
    ciphertext?: string;
    withheld?: boolean;
  }[];
}

export interface OpenedVaultItem {
  itemId: string;
  label: string;
  deliverTo: string[];
  earliestRelease: string | null;
  body: string | null;
  withheld: boolean;
}

/**
 * Fewer than k trustee contributions could be used. The service has already
 * served the encrypted package, so the fix is more shares, not a new release:
 * another trustee adds a share to the same recovery and the recoverer retries,
 * or the trustees recover offline from printed cards and the bundle.
 */
export class RecoveryIncompleteError extends ReleaseError {
  readonly failed: string[];
  readonly usable: number;
  readonly needed: number;
  constructor(failed: string[], usable: number, needed: number) {
    super(
      failed.length > 0
        ? `could not use the contributions from ${failed.join(", ")}; ${usable} usable of ${needed} needed`
        : `${usable} usable contributions of ${needed} needed`,
    );
    this.name = "RecoveryIncompleteError";
    this.failed = failed;
    this.usable = usable;
    this.needed = needed;
  }
}

export interface OpenedRecovery {
  items: OpenedVaultItem[];
  /** Trustees whose shares rebuilt the verified key. */
  used: string[];
  /** Trustees whose contribution did not decrypt here or did not fit the key. */
  failed: string[];
}

const MAX_SUBSETS = 500;

function* subsets<T>(xs: T[], k: number, start = 0, acc: T[] = []): Generator<T[]> {
  if (acc.length === k) {
    yield acc.slice();
    return;
  }
  for (let i = start; i <= xs.length - (k - acc.length); i++) {
    acc.push(xs[i]);
    yield* subsets(xs, k, i + 1, acc);
    acc.pop();
  }
}

/**
 * Last Light: unlike Break Glass, a recovery may carry more than k
 * contributions, and one bad contribution must not block the others. Each
 * envelope is opened under this browser's own binding; ones that fail are set
 * aside. Then k-subsets are tried until one passes the vault header check.
 * Nothing is decrypted before that check passes.
 */
export async function openRecovery(local: LocalRecovery, pkg: RecoveryPackage): Promise<OpenedRecovery> {
  if (pkg.vault_id !== local.vaultId) throw new ReleaseError("package is for a different vault");
  const ids = pkg.envelopes.map((e) => e.trustee_id);
  if (new Set(ids).size !== ids.length) throw new ReleaseError("two envelopes name the same trustee");
  const opened: { id: string; share: Bytes }[] = [];
  const failed: string[] = [];
  for (const e of pkg.envelopes) {
    try {
      const share = await openRecoveryShare(fromBase64(e.envelope), local.privateKey, local.publicKey, {
        recoveryId: local.recoveryId,
        vaultId: local.vaultId,
        recovererId: local.recovererId,
        trusteeId: e.trustee_id,
      });
      if (opened.some((o) => shareIndex(o.share) === shareIndex(share) || o.share.length !== share.length)) failed.push(e.trustee_id);
      else opened.push({ id: e.trustee_id, share });
    } catch (err) {
      if (!(err instanceof EnvelopeError)) throw err;
      failed.push(e.trustee_id);
    }
  }
  if (opened.length < pkg.threshold) throw new RecoveryIncompleteError(failed, opened.length, pkg.threshold);

  const header = fromBase64(pkg.header);
  let key: Bytes | undefined;
  let used: string[] = [];
  let tried = 0;
  for (const subset of subsets(opened, pkg.threshold)) {
    if (++tried > MAX_SUBSETS) break;
    const candidate = await combineShares(subset.map((s) => s.share), pkg.threshold);
    try {
      await checkVaultKey(candidate, local.vaultId, header);
      key = candidate;
      used = subset.map((s) => s.id);
      break;
    } catch (e) {
      candidate.fill(0);
      if (!(e instanceof HeaderCheckError)) throw e;
    }
  }
  for (const o of opened) o.share.fill(0);
  if (!key) {
    // Every contribution decrypted, but no k of them rebuild the key.
    throw new RecoveryIncompleteError([...failed, ...opened.map((o) => o.id)], 0, pkg.threshold);
  }
  try {
    const out: OpenedVaultItem[] = [];
    for (const it of pkg.items) {
      const base = { itemId: it.item_id, label: it.label, deliverTo: it.deliver_to, earliestRelease: it.earliest_release };
      if (it.withheld || !it.wrapped_key || !it.ciphertext) {
        out.push({ ...base, body: null, withheld: true });
        continue;
      }
      const body = await openVaultItem(key, local.vaultId, it.item_id, {
        wrappedKey: fromBase64(it.wrapped_key),
        ciphertext: fromBase64(it.ciphertext),
      });
      out.push({ ...base, body, withheld: false });
    }
    return { items: out, used, failed };
  } finally {
    key.fill(0);
  }
}
