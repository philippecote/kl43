// Transmittable form of a KL-43C ciphertext: the 12-char MI followed by a
// base32-encoded, Reed-Solomon-protected ciphertext body. The canonical
// on-display form groups both components into 3-char chunks separated by
// single spaces (SPEC Appendix A §6.7). On the wire the same grouped form
// is sent verbatim so hand-copy transcription from voice radio is
// byte-identical to the source.
//
// Layering (MANUAL p.53 Appendix B — "THERE WERE UNCORRECTABLE ERRORS":
// the real device has a built-in FEC that surfaces this message when the
// line is too noisy to recover):
//
//   plaintext
//     → CBC/CTR/combiner under the selected CryptoBackend
//     → ciphertext bytes
//     → frameOutgoing() prepends a 2-byte length, pads to 223, and runs
//       Reed-Solomon RS(255,223) per block  →  ~14% parity overhead,
//       corrects up to 16 symbol errors per 255-byte codeword
//     → base32 → 3-char groups on the LCD
//
// On receive we mirror the stack: base32 decode → RS decode (counting
// corrected errors + distinguishing "uncorrectable" from "decrypt failed")
// → cipher decrypt. An `UncorrectableError` from `decryptMessage` means
// the noise exceeded RS capacity; the Machine surfaces the Appendix B
// `THERE WERE UNCORRECTABLE / ERRORS PRESS EXIT.` screen. Anything else
// (MI parse, key-checksum mismatch, PKCS#7 unpad, UTF-8) falls through to
// the generic `MESSAGE DOES NOT DECRYPT PROPERLY` path.

import { Compartment } from "../state/KeyCompartment.js";
import { CryptoBackend } from "../crypto/CryptoBackend.js";
import { MI_TOTAL_LENGTH, makeMi, parseMi } from "../crypto/Mi.js";
import { base32Encode, groupForDisplay } from "./Base32.js";
import { filterToBase32PreservingErasures } from "./Base32.js";
import { frameOutgoing, unframeIncoming, WireFrameError } from "./WireFrame.js";
import { ReedSolomonError } from "../fec/ReedSolomon.js";

/** Thrown when received ciphertext has more symbol errors than RS can fix. */
export class UncorrectableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UncorrectableError";
  }
}

export interface EncryptedMessage {
  /** The 12-letter MI (A-Z only). */
  readonly mi: string;
  /** Base32 ciphertext body, RS-protected, no grouping. */
  readonly cipherBase32: string;
}

/** Diagnostic info from a successful decrypt. */
export interface DecryptResult {
  readonly plaintext: string;
  /** Symbol errors the RS decoder silently corrected. 0 = clean line. */
  readonly errorsCorrected: number;
}

/**
 * Encrypt a UTF-8 plaintext under the given compartment + backend,
 * returning MI + RS-protected base32 body. Callers render via
 * `formatForDisplay`.
 */
export function encryptMessage(
  compartment: Compartment,
  backend: CryptoBackend,
  plaintext: string,
  randomSource: (n: number) => Uint8Array,
): EncryptedMessage {
  const mi = makeMi(randomSource);
  const stream = backend.init(compartment.currentKey, mi);
  const plainBytes = new TextEncoder().encode(plaintext);
  const cipherBytes = stream.transform(plainBytes, "encrypt");
  const frame = frameOutgoing(mi, cipherBytes);
  return { mi, cipherBase32: frame.body };
}

/**
 * Decrypt a received message. Throws:
 *   - `UncorrectableError` when the RS decoder gives up (→ Appendix B
 *     `THERE WERE UNCORRECTABLE / ERRORS PRESS EXIT.` screen);
 *   - any other error when MI parse, key-checksum, PKCS#7 unpad, or UTF-8
 *     fails (→ generic `MESSAGE DOES NOT DECRYPT PROPERLY`).
 */
export function decryptMessage(
  compartment: Compartment,
  backend: CryptoBackend,
  message: EncryptedMessage,
): string {
  return decryptMessageWithStats(compartment, backend, message).plaintext;
}

/** Same as `decryptMessage` but returns the RS error-correction count. */
export function decryptMessageWithStats(
  compartment: Compartment,
  backend: CryptoBackend,
  message: EncryptedMessage,
): DecryptResult {
  parseMi(message.mi); // explicit validation up-front
  let cipherBytes: Uint8Array;
  let errorsCorrected: number;
  try {
    const unframed = unframeIncoming({ mi: message.mi, body: message.cipherBase32 });
    cipherBytes = unframed.ciphertextBytes;
    errorsCorrected = unframed.errorsCorrected;
  } catch (err) {
    if (err instanceof ReedSolomonError) {
      throw new UncorrectableError(err.message);
    }
    // WireFrameError covers non-multiple-of-n length and a length prefix
    // that overruns the decoded payload — both really are "the line so
    // mangled we can't even assemble a codeword", which is operationally
    // the same as uncorrectable. Route there.
    if (err instanceof WireFrameError) {
      throw new UncorrectableError(err.message);
    }
    throw err;
  }
  const stream = backend.init(compartment.currentKey, message.mi);
  const plainBytes = stream.transform(cipherBytes, "decrypt");
  return { plaintext: new TextDecoder().decode(plainBytes), errorsCorrected };
}

/**
 * Render a message as operators see it on the LCD: `MI body` + space +
 * grouped ciphertext. Both components use 3-char groups.
 */
export function formatForDisplay(message: EncryptedMessage): string {
  const mi = groupForDisplay(message.mi);
  const body = groupForDisplay(message.cipherBase32);
  return body.length === 0 ? mi : `${mi} ${body}`;
}

/**
 * Parse a display-form string back to an EncryptedMessage. Silently
 * filters out characters outside the allowed alphabets (matching the
 * editor's cipher-text-entry mode behavior).
 *
 * Receive-path erasure handling: '?' characters anywhere in the body
 * are treated as position-preserving erasure markers (emitted by the
 * modem when its bit-clock detected a lost byte) and mapped to 'A' (5
 * zero bits) via `filterToBase32PreservingErasures`. The MI header,
 * however, is extracted with the strict A-Z scan — a '?' inside the
 * first 12 characters will push body characters into the header slot,
 * fail the MI checksum, and surface as a normal "does not decrypt"
 * error. That's the intended outcome: a drop in the 12-byte header
 * cannot be recovered without a retransmit.
 */
export function parseDisplayForm(text: string): EncryptedMessage {
  // First extract the MI body: take the first 12 A-Z characters, ignoring
  // spaces and anything else (digits and '?' aren't valid in the MI).
  let mi = "";
  let i = 0;
  while (i < text.length && mi.length < MI_TOTAL_LENGTH) {
    const ch = text[i]!.toUpperCase();
    if (ch >= "A" && ch <= "Z") mi += ch;
    i++;
  }
  if (mi.length !== MI_TOTAL_LENGTH) {
    throw new Error(`expected ${MI_TOTAL_LENGTH}-letter MI header, found ${mi.length}`);
  }
  // Remainder is ciphertext body; keep erasure markers so Reed–Solomon
  // sees byte-aligned substitutions instead of a shifted stream.
  const cipherBase32 = filterToBase32PreservingErasures(text.slice(i));
  return { mi, cipherBase32 };
}
