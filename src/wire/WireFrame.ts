// Over-the-air ciphertext framing: ties together EncryptedMessage (CBC bytes
// + MI) and ReedSolomon (RS(255,223) FEC) into a single representation that
// survives hand-copy transcription and low-rate burst errors.
//
// Layer order on outbound:
//   plaintext
//     → [CBC-encrypt under (sessionKey, IV=derive(MI,sessionKey))]
//     → ciphertext bytes C
//     → payload P = [len_hi, len_lo, C...] + zero-pad to 223*N
//     → RS-encode each 223-byte chunk → concatenate 255-byte codewords
//     → base32-encode the whole codeword stream → body
//     → display: MI (12 A-Z) then group3(body), single-space separated
//
// The 2-byte big-endian length prefix tells the receiver how many of the
// decoded payload bytes are real ciphertext (the rest are zero padding to
// complete the final RS data block). This is our substitute for the real
// KL-43C framing convention — unknown from open sources, so pick a simple
// self-describing one. Spec §6.7 explicitly marks any terminator convention
// as [SUBSTITUTE].
//
// Inbound is the mirror: group spaces are stripped (editor already filters
// to A-Z + 2-7), base32-decoded, split into 255-byte codewords, each
// RS-decoded (correcting up to 16 symbol errors per codeword), then the
// length prefix tells us how many real ciphertext bytes to return.

import { ReedSolomon, type RsParams, DEFAULT_K, DEFAULT_N } from "../fec/ReedSolomon.js";
import { base32Decode, base32Encode, filterToBase32, groupForDisplay } from "./Base32.js";
import { MI_TOTAL_LENGTH, parseMi } from "../crypto/Mi.js";

export const LENGTH_PREFIX_BYTES = 2;
/** Largest ciphertext payload representable under the 2-byte length prefix. */
export const MAX_PAYLOAD_BYTES = 0xffff;

export class WireFrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WireFrameError";
  }
}

export interface WireFrame {
  /** 12-letter MI (A-Z only). */
  readonly mi: string;
  /** Base32 body (A-Z + 2-7), ungrouped, includes FEC parity. */
  readonly body: string;
}

export interface UnframeResult {
  readonly ciphertextBytes: Uint8Array;
  /** Total symbol errors corrected across all codewords. */
  readonly errorsCorrected: number;
}

export function defaultRs(): ReedSolomon {
  return new ReedSolomon();
}

/**
 * Wrap ciphertext bytes + MI into a framed, FEC-protected wire form. The
 * caller is responsible for having already derived the ciphertext via
 * CryptoBackend; this function only handles framing.
 */
export function frameOutgoing(mi: string, ciphertextBytes: Uint8Array, rs?: ReedSolomon): WireFrame {
  parseMi(mi); // rejects any non-A-Z or wrong length up front
  if (ciphertextBytes.length > MAX_PAYLOAD_BYTES) {
    throw new WireFrameError(
      `payload too large for 2-byte length prefix: ${ciphertextBytes.length} > ${MAX_PAYLOAD_BYTES}`,
    );
  }
  const codec = rs ?? defaultRs();
  const { k, n } = codec;

  // Build payload: [len_hi, len_lo, ciphertext, pad-to-multiple-of-k].
  const trueLen = ciphertextBytes.length;
  const prefixed = trueLen + LENGTH_PREFIX_BYTES;
  const blocks = Math.max(1, Math.ceil(prefixed / k));
  const payloadLen = blocks * k;
  const payload = new Uint8Array(payloadLen);
  payload[0] = (trueLen >> 8) & 0xff;
  payload[1] = trueLen & 0xff;
  payload.set(ciphertextBytes, LENGTH_PREFIX_BYTES);

  // RS-encode each k-byte block to n bytes; concatenate.
  const encoded = new Uint8Array(blocks * n);
  for (let b = 0; b < blocks; b++) {
    const dataBlock = payload.subarray(b * k, (b + 1) * k);
    const codeword = codec.encode(dataBlock);
    encoded.set(codeword, b * n);
  }

  return { mi, body: base32Encode(encoded) };
}

/**
 * Inverse of `frameOutgoing`. Returns the recovered ciphertext bytes (ready
 * to feed into `backend.decrypt`) plus the count of corrected symbol errors
 * for telemetry / the `UNCORRECTABLE ERRORS` display path.
 */
export function unframeIncoming(frame: WireFrame, rs?: ReedSolomon): UnframeResult {
  parseMi(frame.mi);
  const codec = rs ?? defaultRs();
  const { k, n } = codec;

  const encoded = base32Decode(frame.body);
  if (encoded.length === 0 || encoded.length % n !== 0) {
    throw new WireFrameError(
      `encoded length ${encoded.length} is not a positive multiple of n=${n}`,
    );
  }
  const blocks = encoded.length / n;

  const payload = new Uint8Array(blocks * k);
  let errorsCorrected = 0;
  for (let b = 0; b < blocks; b++) {
    const codeword = encoded.subarray(b * n, (b + 1) * n);
    const { data, corrected } = codec.decode(codeword);
    payload.set(data, b * k);
    errorsCorrected += corrected;
  }

  const trueLen = (payload[0]! << 8) | payload[1]!;
  if (trueLen + LENGTH_PREFIX_BYTES > payload.length) {
    throw new WireFrameError(
      `length prefix ${trueLen} exceeds decoded payload ${payload.length - LENGTH_PREFIX_BYTES}`,
    );
  }
  const ciphertextBytes = payload.slice(LENGTH_PREFIX_BYTES, LENGTH_PREFIX_BYTES + trueLen);
  return { ciphertextBytes, errorsCorrected };
}

/**
 * Format a frame as the operator sees it: `MI-in-3-groups body-in-3-groups`
 * with a single space separating the MI from the body. Matches the example
 * layout on MANUAL p.12.
 */
export function formatWireFrameForDisplay(frame: WireFrame): string {
  const mi = groupForDisplay(frame.mi);
  const body = groupForDisplay(frame.body);
  return body.length === 0 ? mi : `${mi} ${body}`;
}

/**
 * Parse a hand-copied display form back into a WireFrame. Silently tolerates
 * extra whitespace and any characters outside the alphabets (the device
 * ignores them during cipher-text-entry mode).
 *
 * The first MI_TOTAL_LENGTH A-Z characters form the MI; everything after,
 * filtered to base32, is the body.
 */
export function parseWireFrameFromDisplay(text: string): WireFrame {
  let mi = "";
  let i = 0;
  while (i < text.length && mi.length < MI_TOTAL_LENGTH) {
    const ch = text[i]!.toUpperCase();
    if (ch >= "A" && ch <= "Z") mi += ch;
    i++;
  }
  if (mi.length !== MI_TOTAL_LENGTH) {
    throw new WireFrameError(
      `expected ${MI_TOTAL_LENGTH}-letter MI header, found ${mi.length}`,
    );
  }
  const body = filterToBase32(text.slice(i));
  return { mi, body };
}

/** Re-export for consumers that want to configure a non-default RS. */
export type { RsParams };
export { DEFAULT_K, DEFAULT_N };
