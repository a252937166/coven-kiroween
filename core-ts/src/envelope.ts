// Envelopes: AES-256-GCM with associated data on every ciphertext.
//
// Two families:
// 1. Encrypt-to-public-key envelopes (ECDH P-256 + HKDF-SHA-256 + AES-GCM) for
//    shares moving between people. Spec 05: BG-03.3 (six-field AAD), BG-03.4.
// 2. Symmetric envelopes under a raw 256-bit key, for items, wrapped item keys
//    and key headers. The header check runs before any item is decrypted.
// Design section 4 of spec 05 fixes the approval byte formats.

import { bytes, concatBytes, encodeAad, lengthPrefixed, randomBytes, utf8, type Bytes } from "./bytes.ts";
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
export const KEY_LENGTH = 32;

export class EnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvelopeError";
  }
}

/** Raised when a rebuilt key does not open its header. Nothing is decrypted after it. */
export class HeaderCheckError extends Error {
  constructor(message = "key header check failed: wrong, duplicate, malformed or foreign shares") {
    super(message);
    this.name = "HeaderCheckError";
  }
}

// ---------------------------------------------------------------------------
// Bindings and AAD

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

/** Last Light: a trustee's share submitted to the recovering trustee's ephemeral key. */
export interface RecoveryBinding {
  recoveryId: string;
  vaultId: string;
  recovererId: string;
  trusteeId: string;
}

/** Last Light: a trustee's digital share, encrypted to that trustee's long-term key. */
export interface TrusteeShareBinding {
  vaultId: string;
  trusteeId: string;
}

const APPROVAL_DOMAIN = "coven/v1/approval";
const APPROVAL_INFO = "coven/v1/approval-key";
const SHARE_DOMAIN = "coven/v1/approver-share";
const SHARE_INFO = "coven/v1/approver-share-key";
const RECOVERY_DOMAIN = "coven/v1/recovery";
const RECOVERY_INFO = "coven/v1/recovery-key";
const TRUSTEE_DOMAIN = "coven/v1/trustee-share";
const TRUSTEE_INFO = "coven/v1/trustee-share-key";

function domainTag(domain: string): Bytes {
  return concatBytes(utf8(domain), new Uint8Array([0x00]));
}

/** Canonical approval AAD (design section 4). */
export function encodeApprovalAad(binding: ApprovalBinding, requesterKeyFingerprint: Uint8Array): Bytes {
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
export function encodeApproverShareAad(binding: ApproverShareBinding): Bytes {
  return encodeAad(SHARE_DOMAIN, [binding.itemId, binding.sealVersionId, binding.approverId]);
}

export function encodeRecoveryAad(binding: RecoveryBinding, recovererKeyFingerprint: Uint8Array): Bytes {
  if (recovererKeyFingerprint.length !== 32) throw new EnvelopeError("fingerprint must be 32 bytes");
  return concatBytes(
    domainTag(RECOVERY_DOMAIN),
    lengthPrefixed(binding.recoveryId),
    lengthPrefixed(binding.vaultId),
    lengthPrefixed(binding.recovererId),
    recovererKeyFingerprint,
    lengthPrefixed(binding.trusteeId),
  );
}

export function encodeTrusteeShareAad(binding: TrusteeShareBinding): Bytes {
  return encodeAad(TRUSTEE_DOMAIN, [binding.vaultId, binding.trusteeId]);
}

// ---------------------------------------------------------------------------
// Encrypt to a public key

async function deriveAesKey(
  privateKey: CryptoKey,
  publicKey: CryptoKey,
  salt: Uint8Array,
  info: string,
): Promise<CryptoKey> {
  const shared = await subtle.deriveBits({ name: "ECDH", public: publicKey }, privateKey, 256);
  const base = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: bytes(salt), info: utf8(info) },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function sealToPublicKey(
  plaintext: Uint8Array,
  recipientRawPublicKey: Uint8Array,
  aad: Bytes,
  salt: Uint8Array,
  info: string,
): Promise<Bytes> {
  if (plaintext.length === 0 || plaintext.length > MAX_PLAINTEXT_LENGTH) {
    throw new EnvelopeError("plaintext length out of range");
  }
  const recipient = await importRawPublicKey(recipientRawPublicKey);
  const ephemeral = await generateEphemeralKeyPair();
  const ephemeralRaw = await exportRawPublicKey(ephemeral.publicKey);
  const key = await deriveAesKey(ephemeral.privateKey, recipient, salt, info);
  const nonce = randomBytes(NONCE_LENGTH);
  const ct = new Uint8Array(
    await subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad }, key, bytes(plaintext)),
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
  aad: Bytes,
  salt: Uint8Array,
  info: string,
): Promise<Bytes> {
  if (!isWellFormedEnvelope(envelope)) throw new EnvelopeError("malformed envelope");
  const ephemeralRaw = envelope.slice(1, 1 + P256_RAW_PUBLIC_KEY_LENGTH);
  const nonce = bytes(envelope.slice(1 + P256_RAW_PUBLIC_KEY_LENGTH, HEADER_LENGTH));
  const ct = bytes(envelope.slice(HEADER_LENGTH));
  let ephemeral: CryptoKey;
  try {
    ephemeral = await importRawPublicKey(ephemeralRaw);
  } catch {
    throw new EnvelopeError("malformed envelope");
  }
  const key = await deriveAesKey(recipientPrivateKey, ephemeral, salt, info);
  try {
    return new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: nonce, additionalData: aad }, key, ct));
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
): Promise<Bytes> {
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
): Promise<Bytes> {
  const fp = await fingerprint(requesterRawPublicKey);
  return openWithPrivateKey(envelope, requesterPrivateKey, encodeApprovalAad(binding, fp), fp, APPROVAL_INFO);
}

/** Sealing side: encrypt one approver's share to that approver's long-term key. */
export async function sealApproverShare(
  share: Uint8Array,
  approverRawPublicKey: Uint8Array,
  binding: ApproverShareBinding,
): Promise<Bytes> {
  const salt = await fingerprint(approverRawPublicKey);
  return sealToPublicKey(share, approverRawPublicKey, encodeApproverShareAad(binding), salt, SHARE_INFO);
}

/** Approver side: open one's own share blob. */
export async function openApproverShare(
  blob: Uint8Array,
  approverPrivateKey: CryptoKey,
  approverRawPublicKey: Uint8Array,
  binding: ApproverShareBinding,
): Promise<Bytes> {
  const salt = await fingerprint(approverRawPublicKey);
  return openWithPrivateKey(blob, approverPrivateKey, encodeApproverShareAad(binding), salt, SHARE_INFO);
}

/** Last Light trustee side: seal a share to the recovering trustee's ephemeral key. */
export async function sealRecoveryShare(
  share: Uint8Array,
  recovererRawPublicKey: Uint8Array,
  binding: RecoveryBinding,
): Promise<Bytes> {
  const fp = await fingerprint(recovererRawPublicKey);
  return sealToPublicKey(share, recovererRawPublicKey, encodeRecoveryAad(binding, fp), fp, RECOVERY_INFO);
}

export async function openRecoveryShare(
  envelope: Uint8Array,
  recovererPrivateKey: CryptoKey,
  recovererRawPublicKey: Uint8Array,
  binding: RecoveryBinding,
): Promise<Bytes> {
  const fp = await fingerprint(recovererRawPublicKey);
  return openWithPrivateKey(envelope, recovererPrivateKey, encodeRecoveryAad(binding, fp), fp, RECOVERY_INFO);
}

export async function sealTrusteeShare(
  share: Uint8Array,
  trusteeRawPublicKey: Uint8Array,
  binding: TrusteeShareBinding,
): Promise<Bytes> {
  const salt = await fingerprint(trusteeRawPublicKey);
  return sealToPublicKey(share, trusteeRawPublicKey, encodeTrusteeShareAad(binding), salt, TRUSTEE_INFO);
}

export async function openTrusteeShare(
  blob: Uint8Array,
  trusteePrivateKey: CryptoKey,
  trusteeRawPublicKey: Uint8Array,
  binding: TrusteeShareBinding,
): Promise<Bytes> {
  const salt = await fingerprint(trusteeRawPublicKey);
  return openWithPrivateKey(blob, trusteePrivateKey, encodeTrusteeShareAad(binding), salt, TRUSTEE_INFO);
}

// ---------------------------------------------------------------------------
// Symmetric envelopes under a raw 256-bit key

const SYM_VERSION = 0x02;
const HEADER_PLAINTEXT = "coven/v1/header-check";

export function generateKey(): Bytes {
  return randomBytes(KEY_LENGTH);
}

async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== KEY_LENGTH) throw new EnvelopeError("key must be 32 bytes");
  return subtle.importKey("raw", bytes(raw), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/** 0x02 || nonce (12) || AES-256-GCM ciphertext+tag. */
export async function aeadSeal(key: Uint8Array, plaintext: Uint8Array, aad: Bytes): Promise<Bytes> {
  const k = await importAesKey(key);
  const nonce = randomBytes(NONCE_LENGTH);
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad }, k, bytes(plaintext)));
  return concatBytes(new Uint8Array([SYM_VERSION]), nonce, ct);
}

export async function aeadOpen(key: Uint8Array, sealed: Uint8Array, aad: Bytes): Promise<Bytes> {
  if (!(sealed instanceof Uint8Array) || sealed.length < 1 + NONCE_LENGTH + GCM_TAG_LENGTH || sealed[0] !== SYM_VERSION) {
    throw new EnvelopeError("malformed envelope");
  }
  const k = await importAesKey(key);
  try {
    return new Uint8Array(
      await subtle.decrypt(
        { name: "AES-GCM", iv: bytes(sealed.slice(1, 1 + NONCE_LENGTH)), additionalData: aad },
        k,
        bytes(sealed.slice(1 + NONCE_LENGTH)),
      ),
    );
  } catch {
    throw new EnvelopeError("envelope authentication failed");
  }
}

/** Authenticated header for a protected key. Opening it proves the key is the right one. */
export function makeKeyHeader(key: Uint8Array, aad: Bytes): Promise<Bytes> {
  return aeadSeal(key, utf8(HEADER_PLAINTEXT), aad);
}

export async function checkKeyHeader(key: Uint8Array, header: Uint8Array, aad: Bytes): Promise<void> {
  if (key.length !== KEY_LENGTH) throw new HeaderCheckError();
  try {
    await aeadOpen(key, header, aad);
  } catch {
    throw new HeaderCheckError();
  }
}

// AAD builders for the two sharing modes. Each ciphertext names what it belongs to.

export const aad = {
  /** Break Glass: header of one seal version's item key. */
  bgHeader: (itemId: string, sealVersionId: string) => encodeAad("coven/v1/bg-header", [itemId, sealVersionId]),
  /** Break Glass: the credential, encrypted under one seal version's item key. */
  bgItem: (itemId: string, sealVersionId: string) => encodeAad("coven/v1/bg-item", [itemId, sealVersionId]),
  /** Last Light: header of the vault key. */
  llHeader: (vaultId: string) => encodeAad("coven/v1/ll-header", [vaultId]),
  /** Last Light: an item key wrapped by the vault key. */
  llWrap: (vaultId: string, itemId: string) => encodeAad("coven/v1/ll-wrap", [vaultId, itemId]),
  /** Last Light: an item body encrypted under its own item key. */
  llItem: (vaultId: string, itemId: string) => encodeAad("coven/v1/ll-item", [vaultId, itemId]),
};
