// Over-the-air ciphertext framing: ties together EncryptedMessage (CBC bytes
// + MI) and ReedSolomon (RS(255,223) FEC) into a single representation that
// survives hand-copy transcription and low-rate burst errors.
//
// Layer order on outbound:
//   plaintext
//     → [CBC-encrypt under (sessionKey, IV=derive(MI,sessionKey))]
//     → ciphertext bytes C
//     → payload P = [len_hi, len_lo, C...] + virtual zero-pad to 223*N
//     → RS-encode each 223-byte chunk → 255-byte codeword per chunk
//     → SHORTENED wire form: first N-1 codewords are full (255 bytes), but
//       the last codeword drops its trailing zero-pad run from the data
//       portion — transmit (real_data_bytes + 32 parity) instead of the
//       full 255. Earlier versions transmitted the full 255 verbatim, which
//       (a) tripled the audio length for short messages and (b) forced the
//       operator to voice a long string of 'A's (base32 of 0x00) when
//       hand-copying/reading the ciphertext over a voice channel. Padding
//       is a known-zero sentinel value on both sides, so it's wasted
//       airtime; this is standard "shortened RS" (well-established in
//       CCSDS / DVB / QR-code practice).
//     → base32-encode the whole wire byte stream → body
//     → display: MI (12 A-Z) then group3(body), single-space separated
//
// The 2-byte big-endian length prefix tells the receiver how many of the
// decoded payload bytes are real ciphertext. The wire-byte count tells the
// receiver how many bytes of virtual zero-pad to reinsert in the last
// codeword before decoding. Both are derived quantities — no additional
// framing header is needed.
//
// Inbound is the mirror:
//   - Group spaces stripped (editor already filters to A-Z + 2-7).
//   - Base32-decoded into wire bytes W.
//   - Block count m = ceil(|W| / 255); first m-1 blocks are full, last
//     block is reconstructed by inserting (255 - tail_bytes) zero bytes
//     between its data portion and its parity portion.
//   - Each reconstructed 255-byte codeword is RS-decoded (corrects up to
//     16 symbol errors per codeword).
//   - The 2-byte length prefix tells us how many real ciphertext bytes to
//     return.

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
 *
 * Applies "shortened RS" to the final block: computes the full RS codeword
 * against a zero-padded k-byte data block, but transmits only the real
 * data bytes followed by the 32 parity bytes, omitting the zero tail.
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
  const parityLen = n - k;

  // Build payload: [len_hi, len_lo, ciphertext, virtual-zero-pad-to-k*N].
  const trueLen = ciphertextBytes.length;
  const prefixed = trueLen + LENGTH_PREFIX_BYTES;
  const blocks = Math.max(1, Math.ceil(prefixed / k));
  const payloadLen = blocks * k;
  const payload = new Uint8Array(payloadLen);
  payload[0] = (trueLen >> 8) & 0xff;
  payload[1] = trueLen & 0xff;
  payload.set(ciphertextBytes, LENGTH_PREFIX_BYTES);

  // Real data bytes in the last block — everything after this is zero pad
  // that we can safely skip on the wire. The RS codec lays the codeword
  // out parity-first: codeword = [parity(parityLen), data(k)]. Shortening
  // simply truncates the codeword at (parityLen + lastBlockDataLen) bytes,
  // dropping the zero tail of the data portion.
  const lastBlockDataLen = prefixed - (blocks - 1) * k; // 1..k
  const wireSize = (blocks - 1) * n + parityLen + lastBlockDataLen;
  const wire = new Uint8Array(wireSize);
  let out = 0;
  for (let b = 0; b < blocks; b++) {
    const dataBlock = payload.subarray(b * k, (b + 1) * k);
    const codeword = codec.encode(dataBlock); // [parity(parityLen), data(k)]
    const isLast = b === blocks - 1;
    const dataToSend = isLast ? lastBlockDataLen : k;
    wire.set(codeword.subarray(0, parityLen + dataToSend), out);
    out += parityLen + dataToSend;
  }

  // Strip RFC 4648 `=` padding from the wire body. The KL-43 alphabet is
  // A-Z + 2-7; `=` is not in that set and would force operators to type
  // (or voice) a character that doesn't exist on the device. Base32Decode
  // tolerates missing padding so this is lossless.
  return { mi, body: base32Encode(wire).replace(/=+$/, "") };
}

/**
 * Inverse of `frameOutgoing`. Returns the recovered ciphertext bytes (ready
 * to feed into `backend.decrypt`) plus the count of corrected symbol errors
 * for telemetry / the `UNCORRECTABLE ERRORS` display path.
 *
 * Reconstructs the full n-byte codeword for the shortened last block by
 * re-inserting the virtual zero pad between the received data bytes and
 * the received parity bytes, so the RS decoder sees a standard codeword.
 */
export function unframeIncoming(frame: WireFrame, rs?: ReedSolomon): UnframeResult {
  parseMi(frame.mi);
  const codec = rs ?? defaultRs();
  const { k, n } = codec;
  const parityLen = n - k;

  const wire = base32Decode(frame.body);
  if (wire.length === 0) {
    throw new WireFrameError("encoded body is empty");
  }
  // Block layout: first m-1 blocks are full (n wire bytes), last block is
  // (data + parity) wire bytes where data ≤ k. m = ceil(|wire| / n).
  // The last block must carry at least one data byte plus the full parity
  // block, otherwise we can't decode it.
  const blocks = Math.ceil(wire.length / n);
  const lastBlockWire = wire.length - (blocks - 1) * n;
  if (lastBlockWire < parityLen + 1 || lastBlockWire > n) {
    throw new WireFrameError(
      `last block wire size ${lastBlockWire} out of range [${parityLen + 1}, ${n}]`,
    );
  }
  const lastBlockData = lastBlockWire - parityLen; // 1..k

  const payload = new Uint8Array(blocks * k);
  let errorsCorrected = 0;
  let inp = 0;
  for (let b = 0; b < blocks; b++) {
    const isLast = b === blocks - 1;
    const dataLen = isLast ? lastBlockData : k;
    // Rebuild the full n-byte codeword: codeword = [parity(parityLen),
    // received_data(dataLen), implicit_zero_pad(k - dataLen)].
    const codeword = new Uint8Array(n);
    codeword.set(wire.subarray(inp, inp + parityLen + dataLen), 0);
    inp += parityLen + dataLen;
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
