// Ephemeral and long-term P-256 ECDH keys, validation and fingerprints.
// Spec 05: BG-03.1 (validated ephemeral key, fingerprint as a label).

const subtle = globalThis.crypto.subtle;

export const P256_RAW_PUBLIC_KEY_LENGTH = 65;
const EC_PARAMS = { name: "ECDH", namedCurve: "P-256" } as const;

export class KeyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyValidationError";
  }
}

/** Generate a P-256 ECDH key pair whose private key cannot be exported. */
export async function generateEphemeralKeyPair(): Promise<CryptoKeyPair> {
  return (await subtle.generateKey(EC_PARAMS, false, ["deriveBits"])) as CryptoKeyPair;
}

/** Uncompressed point encoding 0x04 || X || Y (65 bytes). */
export async function exportRawPublicKey(publicKey: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await subtle.exportKey("raw", publicKey));
}

/**
 * Accept only a 65-byte uncompressed P-256 point that lies on the curve.
 * WebCrypto import rejects off-curve points; the identity point has no
 * uncompressed encoding, so the length and prefix checks exclude it.
 */
export async function importRawPublicKey(raw: Uint8Array): Promise<CryptoKey> {
  if (!(raw instanceof Uint8Array) || raw.length !== P256_RAW_PUBLIC_KEY_LENGTH) {
    throw new KeyValidationError("public key must be 65 bytes");
  }
  if (raw[0] !== 0x04) {
    throw new KeyValidationError("public key must be an uncompressed point");
  }
  try {
    return await subtle.importKey("raw", raw, EC_PARAMS, true, []);
  } catch {
    throw new KeyValidationError("public key is not a valid P-256 point");
  }
}

/** SHA-256 of the raw public key encoding. A label for the key, not an identity proof. */
export async function fingerprint(rawPublicKey: Uint8Array): Promise<Uint8Array> {
  if (rawPublicKey.length !== P256_RAW_PUBLIC_KEY_LENGTH) {
    throw new KeyValidationError("public key must be 65 bytes");
  }
  return new Uint8Array(await subtle.digest("SHA-256", rawPublicKey));
}

/** Short human label: first 16 bytes of the fingerprint as grouped hex. */
export function fingerprintLabel(fp: Uint8Array): string {
  const hex = Array.from(fp.slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
  return hex.match(/.{4}/g)!.join(" ");
}
