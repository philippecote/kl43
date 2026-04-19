import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  MAX_PAYLOAD_BYTES,
  WireFrameError,
  formatWireFrameForDisplay,
  frameOutgoing,
  parseWireFrameFromDisplay,
  unframeIncoming,
} from "./WireFrame.js";
import { ReedSolomon } from "../fec/ReedSolomon.js";
import { makeMi, miChecksum } from "../crypto/Mi.js";
import { base32Decode } from "./Base32.js";
import { KeyCompartmentStore } from "../state/KeyCompartment.js";
import { appendChecksum, decodeKey } from "../crypto/KeyCodec.js";
import { LfsrNlcBackend } from "../crypto/backends/LfsrNlcBackend.js";
import { decryptMessage, encryptMessage } from "./EncryptedMessage.js";

const fixedRandom = (seed: number) => (n: number): Uint8Array => {
  const out = new Uint8Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out[i] = s & 0xff;
  }
  return out;
};

function keyLetters(seed: number): string {
  const raw = new Uint8Array(16);
  let s = seed || 1;
  for (let i = 0; i < raw.length; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    raw[i] = s & 0xff;
  }
  return appendChecksum(decodeKey(raw).slice(0, 30));
}

describe("WireFrame round-trip (noise-free)", () => {
  it("frames and unframes a short payload", () => {
    const mi = makeMi(fixedRandom(1));
    const ct = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const frame = frameOutgoing(mi, ct);
    const { ciphertextBytes, errorsCorrected } = unframeIncoming(frame);
    expect(Array.from(ciphertextBytes)).toEqual(Array.from(ct));
    expect(errorsCorrected).toBe(0);
  });

  it("round-trips arbitrary byte payloads up to 600 bytes", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 600 }), (payload) => {
        const mi = makeMi(fixedRandom(payload.length + 7));
        const frame = frameOutgoing(mi, payload);
        const { ciphertextBytes } = unframeIncoming(frame);
        expect(Array.from(ciphertextBytes)).toEqual(Array.from(payload));
      }),
      { numRuns: 15 },
    );
  });

  it("produces a single codeword for payloads that fit in k-2 bytes", () => {
    const rs = new ReedSolomon();
    const mi = makeMi(fixedRandom(42));
    const payload = new Uint8Array(rs.k - 2).fill(0xaa);
    const frame = frameOutgoing(mi, payload, rs);
    // One codeword = n base32-encoded; n=255 → ceil(255*8/5) = 408 chars
    // rounded up to a multiple of 8 → 408.
    expect(base32Decode(frame.body).length).toBe(rs.n);
  });

  it("produces two codewords when the prefixed payload spills past k", () => {
    const rs = new ReedSolomon();
    const mi = makeMi(fixedRandom(99));
    const payload = new Uint8Array(rs.k - 1); // +2 bytes prefix = k+1 → 2 blocks
    const frame = frameOutgoing(mi, payload, rs);
    expect(base32Decode(frame.body).length).toBe(2 * rs.n);
  });
});

describe("FEC error correction over the wire", () => {
  const rs = new ReedSolomon();
  const mi = makeMi(fixedRandom(7));
  const payload = new Uint8Array(rs.k - 2).map((_, i) => (i * 13 + 1) & 0xff);

  it("corrects up to 16 byte errors in a single codeword", () => {
    const frame = frameOutgoing(mi, payload, rs);
    // Decode to raw bytes, flip 16 bytes, re-encode.
    const bytes = Uint8Array.from(base32Decode(frame.body));
    for (let p = 0; p < 16; p++) bytes[p * 10]! ^= 0xff;
    const damagedFrame = { mi, body: framedBase32(bytes) };
    const { ciphertextBytes, errorsCorrected } = unframeIncoming(damagedFrame, rs);
    expect(Array.from(ciphertextBytes)).toEqual(Array.from(payload));
    expect(errorsCorrected).toBe(16);
  });

  it("rejects a codeword with >16 errors", () => {
    const frame = frameOutgoing(mi, payload, rs);
    const bytes = Uint8Array.from(base32Decode(frame.body));
    for (let p = 0; p < 17; p++) bytes[p * 10]! ^= 0xaa;
    const damagedFrame = { mi, body: framedBase32(bytes) };
    // Either throws or produces wrong data; WireFrame propagates the throw.
    expect(() => unframeIncoming(damagedFrame, rs)).toThrow();
  });

  it("corrects errors independently in each codeword of a multi-block frame", () => {
    const big = new Uint8Array(rs.k * 2 - 2).map((_, i) => (i * 17 + 5) & 0xff);
    const f = frameOutgoing(mi, big, rs);
    const bytes = Uint8Array.from(base32Decode(f.body));
    // Corrupt 10 bytes in the first codeword and 10 in the second.
    for (let p = 0; p < 10; p++) bytes[p]! ^= 0x5a;
    for (let p = 0; p < 10; p++) bytes[rs.n + p * 3]! ^= 0xa5;
    const { ciphertextBytes, errorsCorrected } = unframeIncoming(
      { mi, body: framedBase32(bytes) },
      rs,
    );
    expect(Array.from(ciphertextBytes)).toEqual(Array.from(big));
    expect(errorsCorrected).toBe(20);
  });
});

describe("display formatting", () => {
  it("groups MI and body into 3-char chunks with single spaces", () => {
    const body = "A".repeat(10);
    const mi = body + miChecksum(body);
    const frame = frameOutgoing(mi, new Uint8Array([0, 1, 2, 3]));
    const display = formatWireFrameForDisplay(frame);
    // First three groups of MI are "AAA AAA AAA"; the 4th group is "A" +
    // 2-letter checksum.
    expect(display.startsWith("AAA AAA AAA A")).toBe(true);
    // Exactly one space between groups; never two in a row.
    expect(/ {2,}/.test(display)).toBe(false);
  });

  it("parseWireFrameFromDisplay undoes formatWireFrameForDisplay", () => {
    const mi = makeMi(fixedRandom(100));
    const frame = frameOutgoing(mi, new Uint8Array([9, 8, 7, 6, 5]));
    const display = formatWireFrameForDisplay(frame);
    const parsed = parseWireFrameFromDisplay(display);
    expect(parsed.mi).toBe(frame.mi);
    expect(parsed.body).toBe(frame.body);
  });

  it("parser silently tolerates hand-copy whitespace and stray punctuation", () => {
    const mi = makeMi(fixedRandom(101));
    const frame = frameOutgoing(mi, new Uint8Array([1, 2, 3, 4]));
    // Simulate an operator re-typing: extra whitespace, line breaks,
    // dashes between groups.
    const messy = frame.mi.replace(/(.{3})/g, "$1-")
      + "\n"
      + frame.body.replace(/(.{3})/g, "$1   ");
    const parsed = parseWireFrameFromDisplay(messy);
    expect(parsed.mi).toBe(frame.mi);
    expect(parsed.body).toBe(frame.body);
  });
});

describe("parameter validation", () => {
  it("rejects non-12-letter MI", () => {
    expect(() => frameOutgoing("TOOSHORT", new Uint8Array(4))).toThrow();
  });

  it("rejects payload > 65535 bytes", () => {
    const hugePayload = new Uint8Array(MAX_PAYLOAD_BYTES + 1);
    const mi = makeMi(fixedRandom(55));
    expect(() => frameOutgoing(mi, hugePayload)).toThrow(WireFrameError);
  });

  it("rejects encoded body whose length isn't a multiple of n", () => {
    const mi = makeMi(fixedRandom(66));
    // 255-byte codeword has 408 base32 chars padded to 408; strip the last
    // 8 chars so the decoded length is wrong.
    const frame = frameOutgoing(mi, new Uint8Array([1, 2, 3]));
    const truncated = { mi, body: frame.body.slice(0, frame.body.length - 8) };
    expect(() => unframeIncoming(truncated)).toThrow(WireFrameError);
  });
});

describe("integration: encrypt → frame → (wire) → unframe → decrypt", () => {
  it("station A encrypts + frames; station B unframes + decrypts", () => {
    const store = new KeyCompartmentStore();
    const comp = store.load(1, "INTEG", keyLetters(777));
    const backend = new LfsrNlcBackend();

    const plaintext = "THE EAGLE HAS LANDED AT 0100Z. POSITION UNCHANGED. OVER.";
    const msg = encryptMessage(comp, backend, plaintext, fixedRandom(321));
    const cipherBytes = base32Decode(msg.cipherBase32);

    // Frame for transmission.
    const frame = frameOutgoing(msg.mi, cipherBytes);
    const onWire = formatWireFrameForDisplay(frame);

    // Hand-copied at the far end.
    const received = parseWireFrameFromDisplay(onWire);
    const { ciphertextBytes, errorsCorrected } = unframeIncoming(received);
    expect(errorsCorrected).toBe(0);

    // Re-materialise as EncryptedMessage for the existing decrypt path.
    const rebuilt = {
      mi: received.mi,
      cipherBase32: buildBase32(ciphertextBytes),
    };
    const recovered = decryptMessage(comp, backend, rebuilt);
    expect(recovered).toBe(plaintext);
  });

  it("recovers plaintext after a single-byte burst corrupts the wire", () => {
    const store = new KeyCompartmentStore();
    const comp = store.load(1, "BURST", keyLetters(42));
    const backend = new LfsrNlcBackend();

    const plaintext = "SPARE PARTS REQ: BATT X12, RADIO ACK.";
    const msg = encryptMessage(comp, backend, plaintext, fixedRandom(11));
    const cipherBytes = base32Decode(msg.cipherBase32);

    const rs = new ReedSolomon();
    const frame = frameOutgoing(msg.mi, cipherBytes, rs);
    // Corrupt one byte in the encoded codeword.
    const bytes = Uint8Array.from(base32Decode(frame.body));
    bytes[17]! ^= 0xff;
    const noisy = { mi: frame.mi, body: framedBase32(bytes) };
    const { ciphertextBytes, errorsCorrected } = unframeIncoming(noisy, rs);
    expect(errorsCorrected).toBe(1);

    const rebuilt = { mi: noisy.mi, cipherBase32: buildBase32(ciphertextBytes) };
    expect(decryptMessage(comp, backend, rebuilt)).toBe(plaintext);
  });
});

// Re-encode a byte buffer back to base32. Local helper: the WireFrame API
// takes an already-base32 body because that's what an operator types, but
// these tests splice in damaged bytes, so we need to go back through base32.
function framedBase32(bytes: Uint8Array): string {
  return buildBase32(bytes);
}

function buildBase32(bytes: Uint8Array): string {
  // Inline minimal copy of base32Encode (avoids importing to keep test
  // self-describing — same alphabet, same padding rules).
  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bitBuf = 0;
  let bitCount = 0;
  let out = "";
  for (const b of bytes) {
    bitBuf = (bitBuf << 8) | b;
    bitCount += 8;
    while (bitCount >= 5) {
      out += ALPHABET[(bitBuf >>> (bitCount - 5)) & 0x1f];
      bitCount -= 5;
    }
  }
  if (bitCount > 0) out += ALPHABET[(bitBuf << (5 - bitCount)) & 0x1f];
  while (out.length % 8 !== 0) out += "=";
  return out;
}
