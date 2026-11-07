// Encrypt-to-public-key envelopes with bound associated data.
// Spec 05: BG-03.3 (six-field AAD), BG-03.4 (reject under any other binding).
// Design section 4 fixes the byte formats below.

import { concatBytes, lengthPrefixed, utf8 } from "./bytes.ts";
import {
  fingerprint,
  generateEphemeralKeyPair,
  exportRawPublicKey,
  importRawPublicKey,
  P256_RAW_PUBLIC_KEY_LENGTH,
} from "./keys.ts";

const subtle = globalThis.crypto.subtle;

export const ENVELOPE_VERSION = 0x01;
const NONCE_LENGTH = 12;
const GCM_TAG_LENGTH = 16;
const HEADER_LENGTH = 1 + P256_RAW_PUBLIC_KEY_LENGTH + NONCE_LENGTH;
const MAX_PLAINTEXT_LENGTH = 4096;

export class EnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvelopeError";
  }
}

/** Fields an approval envelope is bound to, besides the requester key fingerprint. */
export interface ApprovalBinding {
  petitionId: string;
  itemId: string;
  sealVersionId: string;
  requesterId: string;
  approverId: string;
}

/** Fields an approver share blob is bound to. */
export interface ApproverShareBinding {
  itemId: string;
  sealVersionId: string;
  approverId: string;
}

const APPROVAL_DOMAIN = "coven/v1/approval";
const APPROVAL_INFO = "coven/v1/approval-key";
const SHARE_DOMAIN = "coven/v1/approver-share";
const SHARE_INFO = "coven/v1/approver-share-key";

function domainTag(domain: string): Uint8Array {
  return concatBytes(utf8(domain), new Uint8Array([0x00]));
}

/** Canonical approval AAD (design section 4). */
export function encodeApprovalAad(binding: ApprovalBinding, requesterKeyFingerprint: Uint8Array): Uint8Array {
  if (requesterKeyFingerprint.length !== 32) throw new EnvelopeError("fingerprint must be 32 bytes");
  return concatBytes(
    domainTag(APPROVAL_DOMAIN),
    lengthPrefixed(binding.petitionId),
    lengthPrefixed(binding.itemId),
    lengthPrefixed(binding.sealVersionId),
    lengthPrefixed(binding.requesterId),
    requesterKeyFingerprint,
    lengthPrefixed(binding.approverId),
  );
}

/** Canonical approver-share AAD (design section 4, last paragraph). */
export function encodeApproverShareAad(binding: ApproverShareBinding): Uint8Array {
  return concatBytes(
    domainTag(SHARE_DOMAIN),
    lengthPrefixed(binding.itemId),
    lengthPrefixed(binding.sealVersionId),
    lengthPrefixed(binding.approverId),
  );
}

async function deriveAesKey(
  privateKey: CryptoKey,
  publicKey: CryptoKey,
  salt: Uint8Array,
  info: string,
): Promise<CryptoKey> {
  const shared = await subtle.deriveBits({ name: "ECDH", public: publicKey }, privateKey, 256);
  const base = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: utf8(info) },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function sealToPublicKey(
  plaintext: Uint8Array,
  recipientRawPublicKey: Uint8Array,
  aad: Uint8Array,
  salt: Uint8Array,
  info: string,
): Promise<Uint8Array> {
  if (plaintext.length === 0 || plaintext.length > MAX_PLAINTEXT_LENGTH) {
    throw new EnvelopeError("plaintext length out of range");
  }
  const recipient = await importRawPublicKey(recipientRawPublicKey);
  const ephemeral = await generateEphemeralKeyPair();
  const ephemeralRaw = await exportRawPublicKey(ephemeral.publicKey);
  const key = await deriveAesKey(ephemeral.privateKey, recipient, salt, info);
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(NONCE_LENGTH));
  const ct = new Uint8Array(
    await subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad }, key, plaintext),
  );
  return concatBytes(new Uint8Array([ENVELOPE_VERSION]), ephemeralRaw, nonce, ct);
}

/** Structural check only; it cannot tell whether the envelope decrypts. */
export function isWellFormedEnvelope(envelope: Uint8Array): boolean {
  return (
    envelope instanceof Uint8Array &&
    envelope.length > HEADER_LENGTH + GCM_TAG_LENGTH &&
    envelope.length <= HEADER_LENGTH + GCM_TAG_LENGTH + MAX_PLAINTEXT_LENGTH &&
    envelope[0] === ENVELOPE_VERSION &&
    envelope[1] === 0x04
  );
}

async function openWithPrivateKey(
  envelope: Uint8Array,
  recipientPrivateKey: CryptoKey,
  aad: Uint8Array,
  salt: Uint8Array,
  info: string,
): Promise<Uint8Array> {
  if (!isWellFormedEnvelope(envelope)) throw new EnvelopeError("malformed envelope");
  const ephemeralRaw = envelope.slice(1, 1 + P256_RAW_PUBLIC_KEY_LENGTH);
  const nonce = envelope.slice(1 + P256_RAW_PUBLIC_KEY_LENGTH, HEADER_LENGTH);
  const ct = envelope.slice(HEADER_LENGTH);
  let ephemeral: CryptoKey;
  try {
    ephemeral = await importRawPublicKey(ephemeralRaw);
  } catch {
    throw new EnvelopeError("malformed envelope");
  }
  const key = await deriveAesKey(recipientPrivateKey, ephemeral, salt, info);
  try {
    return new Uint8Array(
      await subtle.decrypt({ name: "AES-GCM", iv: nonce, additionalData: aad }, key, ct),
    );
  } catch {
    throw new EnvelopeError("envelope authentication failed");
  }
}

/**
 * Approver side: encrypt a share to the petition's requester key.
 * The fingerprint is computed here from the key itself, never taken from the server.
 */
export async function sealApproval(
  share: Uint8Array,
  requesterRawPublicKey: Uint8Array,
  binding: ApprovalBinding,
): Promise<Uint8Array> {
  const fp = await fingerprint(requesterRawPublicKey);
  return sealToPublicKey(share, requesterRawPublicKey, encodeApprovalAad(binding, fp), fp, APPROVAL_INFO);
}

/**
 * Requester side: open an approval envelope. The binding must come from the
 * requester's own local petition record plus the envelope's claimed approver ID.
 * Throws EnvelopeError on any mismatch; the caller must then discard the envelope.
 */
export async function openApproval(
  envelope: Uint8Array,
  requesterPrivateKey: CryptoKey,
  requesterRawPublicKey: Uint8Array,
  binding: ApprovalBinding,
): Promise<Uint8Array> {
  const fp = await fingerprint(requesterRawPublicKey);
  return openWithPrivateKey(envelope, requesterPrivateKey, encodeApprovalAad(binding, fp), fp, APPROVAL_INFO);
}

/** Sealing side: encrypt one approver's share to that approver's long-term key. */
export async function sealApproverShare(
  share: Uint8Array,
  approverRawPublicKey: Uint8Array,
  binding: ApproverShareBinding,
): Promise<Uint8Array> {
  const salt = await fingerprint(approverRawPublicKey);
  return sealToPublicKey(share, approverRawPublicKey, encodeApproverShareAad(binding), salt, SHARE_INFO);
}

/** Approver side: open one's own share blob. */
export async function openApproverShare(
  blob: Uint8Array,
  approverPrivateKey: CryptoKey,
  approverRawPublicKey: Uint8Array,
  binding: ApproverShareBinding,
): Promise<Uint8Array> {
  const salt = await fingerprint(approverRawPublicKey);
  return openWithPrivateKey(blob, approverPrivateKey, encodeApproverShareAad(binding), salt, SHARE_INFO);
}
