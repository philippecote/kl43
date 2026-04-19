// Secondary backend — AES-128 in CTR mode.
// Reference: KL43_emulator_spec_addendum_A_cipher.md §A.4.
//
// Operationally indistinguishable from the LFSR-NLC backend (same interface,
// stream-cipher semantics, no padding). The point is cryptographic strength:
// if you actually need secrecy beyond "it looks enciphered", pick this one.
//
// We use the pure-JS `aes-js` library rather than WebCrypto because the
// upper layer (Machine.press) is synchronous and Subtle.encrypt is
// unconditionally async. Reliability > not having a dep.

import aesjs from "aes-js";
import {
  CryptoBackend,
  CryptoStream,
  assertKRawShape,
  miToBytes,
} from "../CryptoBackend.js";
import { sha256 } from "../primitives.js";

const AES_KEY_BYTES = 16; // AES-128
const AES_BLOCK_BYTES = 16;

class AesCtrStream implements CryptoStream {
  private readonly aes: { encrypt(data: Uint8Array): Uint8Array };

  constructor(kRaw: Uint8Array, mi: string) {
    assertKRawShape(kRaw);
    const miBytes = miToBytes(mi);

    // Key expansion: SHA-256(K_raw || 0x01)[:16] (§A.4.2). The 0x01 domain
    // tag keeps this distinct from the DES backend's SHA-256(K_raw || 0x02).
    const keyMat = new Uint8Array(kRaw.length + 1);
    keyMat.set(kRaw);
    keyMat[kRaw.length] = 0x01;
    const key = sha256(keyMat).slice(0, AES_KEY_BYTES);

    // Initial counter: first 12 bytes = MI, last 4 bytes = counter starting
    // at 0 (big-endian). aes-js increments the full 128-bit counter but for
    // any KL-43-sized message the high bits never carry.
    const iv = new Uint8Array(AES_BLOCK_BYTES);
    iv.set(miBytes, 0);
    // last 4 bytes already zeroed by allocation

    const counter = new aesjs.Counter(iv);
    this.aes = new aesjs.ModeOfOperation.ctr(key, counter);
  }

  /** CTR is symmetric — `mode` is ignored. */
  transform(input: Uint8Array): Uint8Array {
    return this.aes.encrypt(input);
  }
}

export class AesCtrBackend implements CryptoBackend {
  readonly id = "aes-ctr" as const;
  readonly label = "AES-128 CTR";
  readonly description =
    "AES-128 in counter mode. The cipher itself is strong, but this mode has no integrity check — a tampered ciphertext decrypts to modified plaintext without warning. For fun and education only, not for real secrets.";

  init(kRaw: Uint8Array, mi: string): CryptoStream {
    return new AesCtrStream(kRaw, mi);
  }
}
