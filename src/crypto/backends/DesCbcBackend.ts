// Tertiary backend — 56-bit DES in CBC mode.
// Reference: KL43_emulator_spec_addendum_A_cipher.md §A.5.
//
// "XMP-500 compatibility mode" — matches what the Datotek XMP-500 export
// variant actually did. 56-bit DES is broken; the backend UI shows an
// explicit warning when this is selected.
//
// Unlike LFSR-NLC and AES-CTR, this is not a stream cipher: output length
// is padded up to a multiple of 8 bytes with PKCS#7, and encrypt/decrypt
// are distinct operations.

import {
  CryptoBackend,
  CryptoStream,
  assertKRawShape,
  miToBytes,
} from "../CryptoBackend.js";
import { desCbcDecrypt, desCbcEncrypt, sha256 } from "../primitives.js";

const DES_BLOCK_BYTES = 8;
const DES_KEY_BYTES = 7;

class DesCbcStream implements CryptoStream {
  private readonly key: Uint8Array;
  private readonly iv: Uint8Array;

  constructor(kRaw: Uint8Array, mi: string) {
    assertKRawShape(kRaw);
    const miBytes = miToBytes(mi);

    // Key: SHA-256(K_raw || 0x02)[:7] (§A.5.2). 0x02 is the DES-backend
    // domain tag, distinct from AES's 0x01.
    const keyMat = new Uint8Array(kRaw.length + 1);
    keyMat.set(kRaw);
    keyMat[kRaw.length] = 0x02;
    this.key = sha256(keyMat).slice(0, DES_KEY_BYTES);

    // IV: SHA-256(MI)[:8] (§A.5.2). MI-only — no key mixed in. This is
    // weaker than mixing the session key, but it's what the addendum
    // specifies and gives deterministic recovery from MI alone.
    this.iv = sha256(miBytes).slice(0, DES_BLOCK_BYTES);
  }

  transform(input: Uint8Array, mode: "encrypt" | "decrypt"): Uint8Array {
    if (mode === "encrypt") {
      const padded = pkcs7Pad(input, DES_BLOCK_BYTES);
      return desCbcEncrypt(this.key, this.iv, padded);
    }
    if (input.length === 0 || input.length % DES_BLOCK_BYTES !== 0) {
      throw new RangeError(
        `ciphertext must be a positive multiple of ${DES_BLOCK_BYTES} bytes, got ${input.length}`,
      );
    }
    const padded = desCbcDecrypt(this.key, this.iv, input);
    return pkcs7Unpad(padded, DES_BLOCK_BYTES);
  }
}

export class DesCbcBackend implements CryptoBackend {
  readonly id = "des-cbc" as const;
  readonly label = "DES-56 CBC (XMP-500 mode)";
  readonly description =
    "Historical 56-bit DES — matches the Datotek XMP-500 export variant. Known to be breakable since the 1990s; included for period authenticity only. Do not use for anything that matters.";

  init(kRaw: Uint8Array, mi: string): CryptoStream {
    return new DesCbcStream(kRaw, mi);
  }
}

export function pkcs7Pad(data: Uint8Array, blockBytes: number): Uint8Array {
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
