// 56-bit DES in CBC mode with PKCS#7 padding. This is the canonical
// substitute cipher for the KL-43C emulator, matching the Datotek XMP-500
// export variant (spec §6.1).
//
// Session-key derivation (spec §6.2, final paragraph):
//   K_session = SHA-256(K_raw)[0..7)    // 56 bits, discarding the parity byte
//
// The remaining 113 bits of K_raw are intentionally unused by this backend
// so a future 3DES or AES backend can pull its longer key from the same
// master material without requiring operators to re-key.

import { CryptoBackend, assertKRawShape } from "./CryptoBackend.js";
import { desCbcDecrypt, desCbcEncrypt, sha256 } from "./primitives.js";

export const DES_BLOCK_BYTES = 8;
export const DES_KEY_BYTES = 7;

export class DesBackend implements CryptoBackend {
  readonly algorithm = "DES-CBC";
  readonly blockBytes = DES_BLOCK_BYTES;
  readonly ivBytes = DES_BLOCK_BYTES;

  deriveSessionKey(kRaw: Uint8Array): Uint8Array {
    assertKRawShape(kRaw);
    return sha256(kRaw).slice(0, DES_KEY_BYTES);
  }

  encrypt(sessionKey: Uint8Array, iv: Uint8Array, plaintext: Uint8Array): Uint8Array {
    this.assertShapes(sessionKey, iv);
    const padded = pkcs7Pad(plaintext, DES_BLOCK_BYTES);
    return desCbcEncrypt(sessionKey, iv, padded);
  }

  decrypt(sessionKey: Uint8Array, iv: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    this.assertShapes(sessionKey, iv);
    if (ciphertext.length === 0 || ciphertext.length % DES_BLOCK_BYTES !== 0) {
      throw new RangeError(
        `ciphertext must be a positive multiple of ${DES_BLOCK_BYTES} bytes, got ${ciphertext.length}`,
      );
    }
    const padded = desCbcDecrypt(sessionKey, iv, ciphertext);
    return pkcs7Unpad(padded, DES_BLOCK_BYTES);
  }

  private assertShapes(sessionKey: Uint8Array, iv: Uint8Array): void {
    if (sessionKey.length !== DES_KEY_BYTES) {
      throw new RangeError(`session key must be ${DES_KEY_BYTES} bytes, got ${sessionKey.length}`);
    }
    if (iv.length !== DES_BLOCK_BYTES) {
      throw new RangeError(`IV must be ${DES_BLOCK_BYTES} bytes, got ${iv.length}`);
    }
  }
}

export function pkcs7Pad(data: Uint8Array, blockBytes: number): Uint8Array {
  if (blockBytes <= 0 || blockBytes > 255) {
    throw new RangeError(`block size must be in (0, 255], got ${blockBytes}`);
  }
  const padLen = blockBytes - (data.length % blockBytes);
  const out = new Uint8Array(data.length + padLen);
  out.set(data, 0);
  out.fill(padLen, data.length);
  return out;
}

export function pkcs7Unpad(data: Uint8Array, blockBytes: number): Uint8Array {
  if (data.length === 0 || data.length % blockBytes !== 0) {
    throw new RangeError(`padded length ${data.length} not a positive multiple of ${blockBytes}`);
  }
  const padLen = data[data.length - 1]!;
  if (padLen === 0 || padLen > blockBytes) {
    throw new RangeError(`invalid PKCS#7 pad length ${padLen}`);
  }
  for (let i = data.length - padLen; i < data.length; i++) {
    if (data[i] !== padLen) throw new RangeError("invalid PKCS#7 padding");
  }
  return data.slice(0, data.length - padLen);
}
