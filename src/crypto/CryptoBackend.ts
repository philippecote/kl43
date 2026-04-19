// Abstraction over the block-cipher-in-CBC-mode used by the KL-43C protocol.
// The real device uses a classified SAVILLE-family algorithm. The canonical
// substitute is 56-bit DES (matching the Datotek XMP-500 export variant).
// 3DES or AES-128 backends can replace DesBackend without affecting upper
// layers — the protocol is agnostic to block size beyond "small enough to
// fit inside a 300-baud frame budget."
//
// Keys are always derived from the 120-bit K_raw (see KeyCodec.ts).
// Derivation is backend-specific so that a 56-bit or 128-bit backend each
// pulls the right number of bits from the same master key material.

import { K_RAW_LENGTH } from "./KeyCodec.js";

export interface CryptoBackend {
  /** Human-readable tag: "DES-CBC", "3DES-CBC", "AES-128-CBC". */
  readonly algorithm: string;
  /** Block size in bytes. DES: 8, AES: 16. */
  readonly blockBytes: number;
  /** IV size in bytes (always equal to blockBytes for CBC). */
  readonly ivBytes: number;

  /**
   * Derive the session key used by this backend from 15 bytes of raw key
   * material. Derivation is deterministic; same K_raw + same backend →
   * same session key.
   */
  deriveSessionKey(kRaw: Uint8Array): Uint8Array;

  /** CBC-encrypt with PKCS#7 padding. */
  encrypt(sessionKey: Uint8Array, iv: Uint8Array, plaintext: Uint8Array): Uint8Array;

  /** CBC-decrypt with PKCS#7 unpadding. Throws on bad padding. */
  decrypt(sessionKey: Uint8Array, iv: Uint8Array, ciphertext: Uint8Array): Uint8Array;
}

export function assertKRawShape(kRaw: Uint8Array): void {
  if (kRaw.length !== K_RAW_LENGTH) {
    throw new RangeError(`K_raw must be ${K_RAW_LENGTH} bytes, got ${kRaw.length}`);
  }
}
