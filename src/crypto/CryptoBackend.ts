// Abstraction over the symmetric cipher used by the KL-43C protocol.
// See KL43_emulator_spec_addendum_A_cipher.md for the design decision.
//
// The real device runs a classified SAVILLE-family algorithm. We ship three
// runtime-selectable stand-ins, all consuming the same 15-byte K_raw and
// 12-char MI:
//
//   - lfsr-nlc  — SAVILLE-shaped LFSR nonlinear combiner (default, most
//                 architecturally faithful: stream cipher, irregular
//                 clocking, Geffe-style combiner). Toy cipher.
//   - aes-ctr   — AES-128-CTR. The primitive is strong, but CTR alone gives
//                 confidentiality only — there is no message authentication,
//                 so a tampered ciphertext decrypts to modified plaintext
//                 silently. Faithful to the real KL-43 (which also had no
//                 per-message MAC) but NOT a "secure channel" in the modern
//                 AEAD sense.
//   - des-cbc   — DES-56-CBC, historical XMP-500 export mode. Broken since
//                 the 1990s; for period flavour only.
//
// None of these backends is appropriate for protecting real information.
// This project is a historical re-creation, not a secrets tool.
//
// Interface shape (addendum A.2): `init(kRaw, mi) → CryptoStream`, and the
// stream does a single whole-buffer `transform(input, mode)` per message.
// Stream ciphers (LFSR, AES-CTR) ignore `mode` since encrypt = decrypt; DES
// honours it because CBC is direction-asymmetric.
//
// Keeping the call synchronous: the Machine's `press()` returns `Effect[]`
// synchronously and splitting it into start/complete states would be a
// massive refactor. We avoid WebCrypto (async-only) for AES and use a
// pure-JS implementation instead.
//
// The backend owns its own key/IV/nonce derivation from K_raw and MI. The
// upper layer (EncryptedMessage) just hands over the raw material.

import { K_RAW_LENGTH } from "./KeyCodec.js";
import { MI_TOTAL_LENGTH } from "./Mi.js";

export type BackendId = "lfsr-nlc" | "aes-ctr" | "des-cbc";

export interface CryptoBackend {
  readonly id: BackendId;
  /** Short human-readable label, shown in the picker UI. */
  readonly label: string;
  /** One-line rationale, shown under the radio button. */
  readonly description: string;
  /**
   * Initialize a stream with a 15-byte K_raw and a 12-char MI. The returned
   * stream is single-use: call `transform` exactly once with the whole
   * message buffer.
   */
  init(kRaw: Uint8Array, mi: string): CryptoStream;
}

export interface CryptoStream {
  transform(input: Uint8Array, mode: "encrypt" | "decrypt"): Uint8Array;
}

export function assertKRawShape(kRaw: Uint8Array): void {
  if (kRaw.length !== K_RAW_LENGTH) {
    throw new RangeError(`K_raw must be ${K_RAW_LENGTH} bytes, got ${kRaw.length}`);
  }
}

export function assertMiShape(mi: string): void {
  if (mi.length !== MI_TOTAL_LENGTH) {
    throw new RangeError(`MI must be ${MI_TOTAL_LENGTH} letters, got ${mi.length}`);
  }
  if (!/^[A-Z]+$/.test(mi)) {
    throw new RangeError(`MI must be uppercase A-Z, got ${JSON.stringify(mi)}`);
  }
}

export function miToBytes(mi: string): Uint8Array {
  assertMiShape(mi);
  return new TextEncoder().encode(mi);
}
