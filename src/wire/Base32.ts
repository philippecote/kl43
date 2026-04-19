// RFC 4648 base32 codec, tailored for KL-43C ciphertext display and entry.
// Alphabet: A-Z + 2-7 (32 symbols, digits 0/1 excluded to avoid O/0 and
// I/1/L confusion when operators read ciphertext aloud).
//
// Per SPEC_DELTA §6.7: ciphertext is grouped into 3-char groups separated
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
