// Transmittable form of a KL-43C ciphertext: the 12-char MI followed by a
// base32-encoded CBC ciphertext body. The canonical on-display form groups
// both components into 3-char chunks separated by single spaces
// (SPEC Appendix A §6.7). On the wire the same grouped form is sent verbatim so hand-copy
// transcription from voice radio is byte-identical to the source.
//
// Framing is intentionally minimal — no length prefix, no version byte.
// The ciphertext is a PKCS#7-padded CBC stream; its length is implicit in
// the trailing group. This matches the KL-43C's "type the ciphertext until
// the operator signals end" model.

import { Compartment } from "../state/KeyCompartment.js";
import { CryptoBackend } from "../crypto/CryptoBackend.js";
import { MI_TOTAL_LENGTH, makeMi, parseMi } from "../crypto/Mi.js";
import { base32Decode, base32Encode, groupForDisplay } from "./Base32.js";
import { filterToBase32 } from "./Base32.js";

export interface EncryptedMessage {
  /** The 12-letter MI (A-Z only). */
  readonly mi: string;
  /** Base32 ciphertext body, no grouping, no padding stripped. */
  readonly cipherBase32: string;
}

/**
 * Encrypt a UTF-8 plaintext under the given compartment + backend,
 * returning MI + base32 body. Callers render via `formatForDisplay`.
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
  return { mi, cipherBase32: base32Encode(cipherBytes) };
}

/**
 * Decrypt a received message. Throws on MI parse failure (caller should
 * surface `BAD HEADER — CHECK KEY/UPDATE`), on malformed ciphertext, or on
 * PKCS#7 unpad failure (`Key is Invalid` / `Message Corrupt` are the
 * device's catch-alls).
 */
export function decryptMessage(
  compartment: Compartment,
  backend: CryptoBackend,
  message: EncryptedMessage,
): string {
  parseMi(message.mi); // explicit validation up-front
  const stream = backend.init(compartment.currentKey, message.mi);
  const cipherBytes = base32Decode(message.cipherBase32);
  const plainBytes = stream.transform(cipherBytes, "decrypt");
  return new TextDecoder().decode(plainBytes);
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
 */
export function parseDisplayForm(text: string): EncryptedMessage {
  // First extract the MI body: take the first 12 A-Z characters, ignoring
  // spaces and anything else (digits aren't valid in the MI).
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
  // Remainder is ciphertext body; filter to base32 alphabet.
  const cipherBase32 = filterToBase32(text.slice(i));
  return { mi, cipherBase32 };
}
