// RFC 4648 base32 codec, tailored for KL-43C ciphertext display and entry.
// Alphabet: A-Z + 2-7 (32 symbols, digits 0/1 excluded to avoid O/0 and
// I/1/L confusion when operators read ciphertext aloud).
//
// Per SPEC Appendix A §6.7: ciphertext is grouped into 3-char groups separated
// by single spaces, both on display and over the wire. The device's editor
// auto-inserts group spaces; only A-Z and 2-7 are accepted in cipher-text
// entry mode (all other characters are silently ignored).
//
// Byte alignment: 5 plaintext bytes → 8 base32 chars. We use the standard
// `=` pad character on encode; decoder tolerates missing padding (operators
// re-entering hand-copied text often drop trailing `=`).

export const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const BASE32_PAD = "=";
export const GROUP_SIZE = 3;

const DECODE_TABLE: Readonly<Record<string, number>> = (() => {
  const out: Record<string, number> = {};
  for (let i = 0; i < BASE32_ALPHABET.length; i++) out[BASE32_ALPHABET[i]!] = i;
  return out;
})();

export class Base32Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Base32Error";
  }
}

export function base32Encode(bytes: Uint8Array): string {
  let bitBuf = 0;
  let bitCount = 0;
  let out = "";
  for (const b of bytes) {
    bitBuf = (bitBuf << 8) | b;
    bitCount += 8;
    while (bitCount >= 5) {
      const v = (bitBuf >>> (bitCount - 5)) & 0x1f;
      out += BASE32_ALPHABET[v];
      bitCount -= 5;
    }
  }
  if (bitCount > 0) {
    const v = (bitBuf << (5 - bitCount)) & 0x1f;
    out += BASE32_ALPHABET[v];
  }
  // RFC 4648 pads to a multiple of 8 base32 chars.
  while (out.length % 8 !== 0) out += BASE32_PAD;
  return out;
}

export function base32Decode(text: string): Uint8Array {
  // Accept either the grouped-with-spaces form or raw. Normalize by
  // stripping spaces and trailing padding.
  const cleaned = text.replace(/\s+/g, "").replace(/=+$/, "");
  if (cleaned.length === 0) return new Uint8Array(0);

  const out: number[] = [];
  let bitBuf = 0;
  let bitCount = 0;
  for (const ch of cleaned) {
    const v = DECODE_TABLE[ch];
    if (v === undefined) {
      throw new Base32Error(`invalid base32 character: ${JSON.stringify(ch)}`);
    }
    bitBuf = (bitBuf << 5) | v;
    bitCount += 5;
    if (bitCount >= 8) {
      out.push((bitBuf >>> (bitCount - 8)) & 0xff);
      bitCount -= 8;
    }
  }
  return Uint8Array.from(out);
}

/** Insert a space every GROUP_SIZE chars for on-device display. */
export function groupForDisplay(base32: string, groupSize = GROUP_SIZE): string {
  if (groupSize <= 0) throw new RangeError(`group size must be positive, got ${groupSize}`);
  const chunks: string[] = [];
  for (let i = 0; i < base32.length; i += groupSize) {
    chunks.push(base32.slice(i, i + groupSize));
  }
  return chunks.join(" ");
}

/** Silently drop anything that isn't an allowed base32 char (editor filter). */
export function filterToBase32(input: string): string {
  let out = "";
  for (const ch of input.toUpperCase()) {
    if (DECODE_TABLE[ch] !== undefined) out += ch;
  }
  return out;
}

/**
 * Marker character used by the receiver to flag a byte the modem could
 * not decode (UART framing error or missed clock-lock edge). See
 * [src/host/modem.ts](src/host/modem.ts) LOCKED state. The receive-side
 * base32 filter maps this marker to 'A' (= 5 zero bits) so codeword
 * alignment is preserved for Reed–Solomon — the erasure shows up as a
 * small, bounded substitution rather than a stream shift.
 */
export const BASE32_ERASURE_MARKER = "?";

/**
 * Receive-side filter: keep A-Z + 2-7, map the erasure marker and any
 * other non-alphabet, non-formatting character to 'A' (base32 symbol
 * for 0b00000). Spaces, newlines/CR, tabs, and the `=` pad character
 * are the only things dropped silently.
 *
 * Position preservation is the whole point. `filterToBase32` (used by
 * the interactive cipher-text editor) silently drops unknown characters,
 * which on the wire would turn a single lost byte into a 5-bit shift
 * for every subsequent base32 symbol in the codeword — Reed–Solomon
 * doesn't recover from shifts. By mapping '?' (and any other stray
 * printable character the host may have let through) to 'A' here, one
 * lost UART byte corrupts at most two adjacent codeword bytes (5 bits
 * lands on a byte boundary, so it disturbs the byte it overlaps plus
 * possibly the next), which is comfortably inside RS(255,223)'s
 * 16-error budget.
 *
 * Defensive mapping of unknown chars → 'A' matters because the host-
 * side `mapRxByteToReviewChar` is supposed to catch off-alphabet bytes
 * upstream, but any future code path that writes into the Review buffer
 * (clipboard paste, share-link import, manual edit) could reintroduce
 * a `\`, `;`, `!`, etc. Silently dropping those would resurrect the
 * bit-shift failure mode we worked so hard to eliminate.
 */
export function filterToBase32PreservingErasures(input: string): string {
  let out = "";
  for (const ch of input.toUpperCase()) {
    if (DECODE_TABLE[ch] !== undefined) {
      out += ch;
      continue;
    }
    // Formatting / structural characters: these are either emitted by
    // `groupForDisplay` (spaces, padding), tolerated by base32Decode,
    // or conventionally used by operators hand-copying ciphertext on
    // paper (dashes between groups — "ABC-DEF-GHI"). They carry no
    // positional information so dropping them doesn't cause a shift.
    //
    // Any byte received over the modem that was originally one of these
    // separators would have been translated upstream by
    // `mapRxByteToReviewChar` (host-side RX handler) — spaces survive
    // as spaces, and '-' (0x2D) would have been turned into '?' since
    // it's not in the TX alphabet. So dropping '-' here is only ever
    // reached on the hand-entry / paste code path.
    if (
      ch === " " ||
      ch === "\n" ||
      ch === "\r" ||
      ch === "\t" ||
      ch === "-" ||
      ch === BASE32_PAD
    ) {
      continue;
    }
    // Explicit erasure marker from the UART, OR any other character
    // the host somehow let through. Treat both as a position-preserving
    // erasure (zero-bit base32 symbol) rather than dropping.
    out += "A";
  }
  return out;
}
