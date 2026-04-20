// End-to-end: two independent KL-43C "stations" (each with its own
// KeyCompartmentStore + CryptoBackend) exchange an encrypted message
// through the display form only. The only thing that crosses the boundary
// is a string — exactly what operators would read aloud over the radio.

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { randomBytes } from "../crypto/primitives.js";
import { CryptoBackend } from "../crypto/CryptoBackend.js";
import { LfsrNlcBackend } from "../crypto/backends/LfsrNlcBackend.js";
import { AesCtrBackend } from "../crypto/backends/AesCtrBackend.js";
import { DesCbcBackend } from "../crypto/backends/DesCbcBackend.js";
import { KeyCompartmentStore } from "../state/KeyCompartment.js";
import { appendChecksum } from "../crypto/KeyCodec.js";
import {
  decryptMessage,
  encryptMessage,
  formatForDisplay,
  parseDisplayForm,
} from "../wire/EncryptedMessage.js";
import { InvalidMiError } from "../crypto/Mi.js";
import { MAX_BUFFER_CHARS, MAX_PLAINTEXT_CHARS } from "../editor/TextBuffer.js";

function makeStation(slot: number, name: string, keyLetters: string) {
  const store = new KeyCompartmentStore();
  const compartment = store.load(slot, name, keyLetters);
  return { store, compartment, backend: new LfsrNlcBackend() };
}

function makeStationWithBackend(
  slot: number,
  name: string,
  keyLetters: string,
  backend: CryptoBackend,
) {
  const store = new KeyCompartmentStore();
  const compartment = store.load(slot, name, keyLetters);
  return { store, compartment, backend };
}

// Generate a random valid 32-letter key body — 30 letters + 2-letter
// appended checksum. Used to vary crypto material across property runs.
const KEY_BODY_ARB = fc
  .array(fc.constantFrom(..."ABCDEFGHIJKLMNOP".split("")), { minLength: 30, maxLength: 30 })
  .map((a) => appendChecksum(a.join("")));

describe("station pair — A encrypts, B decrypts", () => {
  it("round-trips a short plaintext through display form", () => {
    const keyLetters = appendChecksum("ABCDEFGHIJKLMNOPABCDEFGHIJKLMN");
    const a = makeStation(1, "STATION-A", keyLetters);
    const b = makeStation(1, "STATION-B", keyLetters);

    const encrypted = encryptMessage(a.compartment, a.backend, "HELLO, WORLD!", randomBytes);
    const wire = formatForDisplay(encrypted);
    // What hits the wire is purely A-Z + 2-7 + space.
    expect(wire).toMatch(/^[A-Z2-7= ]+$/);

    const received = parseDisplayForm(wire);
    expect(decryptMessage(b.compartment, b.backend, received)).toBe("HELLO, WORLD!");
  });

  it("round-trips arbitrary plaintext under arbitrary keys (property)", () => {
    fc.assert(
      fc.property(
        KEY_BODY_ARB,
        fc.string({ minLength: 0, maxLength: 200 }),
        (keyLetters, plaintext) => {
          const a = makeStation(1, "A", keyLetters);
          const b = makeStation(1, "B", keyLetters);
          const encrypted = encryptMessage(a.compartment, a.backend, plaintext, randomBytes);
          const wire = formatForDisplay(encrypted);
          const received = parseDisplayForm(wire);
          expect(decryptMessage(b.compartment, b.backend, received)).toBe(plaintext);
        },
      ),
      { numRuns: 30 },
    );
  });

  it("each message uses a fresh MI (IV diversity across sends)", () => {
    const keyLetters = appendChecksum("ABCDEFGHIJKLMNOPABCDEFGHIJKLMN");
    const a = makeStation(1, "A", keyLetters);
    const plaintext = "SAME PLAINTEXT EVERY TIME";
    const messages = [
      encryptMessage(a.compartment, a.backend, plaintext, randomBytes),
      encryptMessage(a.compartment, a.backend, plaintext, randomBytes),
      encryptMessage(a.compartment, a.backend, plaintext, randomBytes),
    ];
    const mis = new Set(messages.map((m) => m.mi));
    expect(mis.size).toBe(3);
    const bodies = new Set(messages.map((m) => m.cipherBase32));
    expect(bodies.size).toBe(3);
  });

  it("decryption fails when update levels diverge", () => {
    const keyLetters = appendChecksum("ABCDEFGHIJKLMNOPABCDEFGHIJKLMN");
    const a = makeStation(1, "A", keyLetters);
    const b = makeStation(1, "B", keyLetters);
    // A advances to update 1; B stays at 0.
    a.store.update(1);
    const aCompartment = a.store.peek(1)!;
    const encrypted = encryptMessage(aCompartment, a.backend, "SECRET", randomBytes);
    // Either PKCS#7 unpad throws, or the garbled output is wrong text.
    let result: { ok: true; text: string } | { ok: false };
    try {
      const plain = decryptMessage(b.compartment, b.backend, encrypted);
      result = { ok: true, text: plain };
    } catch {
      result = { ok: false };
    }
    if (result.ok) {
      expect(result.text).not.toBe("SECRET");
    }
  });

  it("decryption fails when keys differ", () => {
    const a = makeStation(1, "A", appendChecksum("ABCDEFGHIJKLMNOPABCDEFGHIJKLMN"));
    const b = makeStation(1, "B", appendChecksum("PONMLKJIHGFEDCBAPONMLKJIHGFEDC"));
    const encrypted = encryptMessage(a.compartment, a.backend, "HELLO", randomBytes);
    let result: { ok: true; text: string } | { ok: false };
    try {
      const plain = decryptMessage(b.compartment, b.backend, encrypted);
      result = { ok: true, text: plain };
    } catch {
      result = { ok: false };
    }
    if (result.ok) expect(result.text).not.toBe("HELLO");
  });

  it("corrupted MI header is rejected before attempting decryption", () => {
    const keyLetters = appendChecksum("ABCDEFGHIJKLMNOPABCDEFGHIJKLMN");
    const a = makeStation(1, "A", keyLetters);
    const b = makeStation(1, "B", keyLetters);
    const encrypted = encryptMessage(a.compartment, a.backend, "HELLO", randomBytes);
    // Flip the last checksum letter so parseMi fails.
    const badMi = encrypted.mi.slice(0, 11) + (encrypted.mi.charAt(11) === "A" ? "B" : "A");
    expect(() =>
      decryptMessage(b.compartment, b.backend, { mi: badMi, cipherBase32: encrypted.cipherBase32 }),
    ).toThrow(InvalidMiError);
  });

  // Regression: a maxed plaintext expands roughly 2.5× through
  // (MI + RS parity + base32 + 3-char grouping). Before splitting the
  // plaintext-entry cap (MAX_PLAINTEXT_CHARS) from the physical buffer cap
  // (MAX_BUFFER_CHARS), the display form silently clipped at 2600 chars and
  // the receiver hit an uncorrectable-RS error on the last block. This
  // asserts the spec §9.5 / §11 requirement that a 2600-char round-trip
  // must succeed end-to-end through the display form, for every backend.
  it.each<[string, () => CryptoBackend]>([
    ["lfsr-nlc", () => new LfsrNlcBackend()],
    ["aes-ctr", () => new AesCtrBackend()],
    ["des-cbc", () => new DesCbcBackend()],
  ])("round-trips a maxed %s plaintext through the display form", (_name, make) => {
    const keyLetters = appendChecksum("ABCDEFGHIJKLMNOPABCDEFGHIJKLMN");
    const a = makeStationWithBackend(1, "A", keyLetters, make());
    const b = makeStationWithBackend(1, "B", keyLetters, make());
    // Pseudo-random printable ASCII so the test exercises a wide byte
    // range (not just one letter).
    const plaintext = Array.from({ length: MAX_PLAINTEXT_CHARS }, (_, i) => {
      const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789";
      return alphabet[i % alphabet.length]!;
    }).join("");
    expect(plaintext.length).toBe(MAX_PLAINTEXT_CHARS);
    const encrypted = encryptMessage(a.compartment, a.backend, plaintext, randomBytes);
    const wire = formatForDisplay(encrypted);
    // Must fit in the physical buffer so the receiver can hand-type it
    // back in via the CIPHER-mode editor.
    expect(wire.length).toBeLessThanOrEqual(MAX_BUFFER_CHARS);
    const received = parseDisplayForm(wire);
    expect(decryptMessage(b.compartment, b.backend, received)).toBe(plaintext);
  });

  it("updated keys on both sides still round-trip at matching level", () => {
    const keyLetters = appendChecksum("ABCDEFGHIJKLMNOPABCDEFGHIJKLMN");
    const a = makeStation(1, "A", keyLetters);
    const b = makeStation(1, "B", keyLetters);
    for (let i = 0; i < 5; i++) {
      a.store.update(1);
      b.store.update(1);
    }
    const aNow = a.store.peek(1)!;
    const bNow = b.store.peek(1)!;
    expect(aNow.updateLevel).toBe(5);
    expect(bNow.updateLevel).toBe(5);
    const encrypted = encryptMessage(aNow, a.backend, "DAY 5", randomBytes);
    expect(decryptMessage(bNow, b.backend, encrypted)).toBe("DAY 5");
  });
});
