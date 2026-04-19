// Backend round-trip + per-backend invariant tests.
//
// Coverage matrix (per addendum A):
//   - Round-trip at 1, 64, 2600 bytes for every backend (A.3.11 V3 equivalent).
//   - Different key → different ciphertext.
//   - Different MI  → different ciphertext.
//   - Frozen LFSR-NLC vectors from A.3.11 so any change to key-schedule /
//     combiner / clocking must intentionally break the tests.

import { describe, expect, it } from "vitest";
import { CryptoBackend } from "../CryptoBackend.js";
import { LfsrNlcBackend } from "./LfsrNlcBackend.js";
import { AesCtrBackend } from "./AesCtrBackend.js";
import { DesCbcBackend } from "./DesCbcBackend.js";
import { ALL_BACKENDS, createBackend, DEFAULT_BACKEND_ID } from "./registry.js";
import { K_RAW_LENGTH, appendChecksum, encodeKey } from "../KeyCodec.js";
import { MI_BODY_LENGTH, miChecksum } from "../Mi.js";

function hex(u8: Uint8Array): string {
  return Array.from(u8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function mkMi(body: string): string {
  const b = body.toUpperCase().padEnd(MI_BODY_LENGTH, "A").slice(0, MI_BODY_LENGTH);
  return b + miChecksum(b);
}

function seededKey(seed: number): Uint8Array {
  const k = new Uint8Array(K_RAW_LENGTH);
  let s = seed >>> 0 || 1;
  for (let i = 0; i < k.length; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    k[i] = s & 0xff;
  }
  return k;
}

function seededBytes(seed: number, n: number): Uint8Array {
  const out = new Uint8Array(n);
  let s = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) >>> 0;
    out[i] = s & 0xff;
  }
  return out;
}

const ALL: [string, () => CryptoBackend][] = [
  ["lfsr-nlc", () => new LfsrNlcBackend()],
  ["aes-ctr", () => new AesCtrBackend()],
  ["des-cbc", () => new DesCbcBackend()],
];

describe.each(ALL)("%s: round-trip invariants", (_name, make) => {
  const key = seededKey(0x4b4c3433);
  const mi = mkMi("TESTMI");

  it.each([1, 8, 15, 64, 127, 2600])("round-trips %i bytes", (n) => {
    const pt = seededBytes(n * 37 + 1, n);
    const enc = make().init(key, mi).transform(pt, "encrypt");
    const dec = make().init(key, mi).transform(enc, "decrypt");
    expect(Array.from(dec)).toEqual(Array.from(pt));
  });

  it("produces different ciphertext under a different key", () => {
    const pt = seededBytes(99, 64);
    const k2 = seededKey(0xdeadbeef);
    const c1 = make().init(key, mi).transform(pt, "encrypt");
    const c2 = make().init(k2, mi).transform(pt, "encrypt");
    expect(hex(c1)).not.toBe(hex(c2));
  });

  it("produces different ciphertext under a different MI", () => {
    const pt = seededBytes(77, 64);
    const c1 = make().init(key, mkMi("AAAAAAAAAA")).transform(pt, "encrypt");
    const c2 = make().init(key, mkMi("BBBBBBBBBB")).transform(pt, "encrypt");
    expect(hex(c1)).not.toBe(hex(c2));
  });
});

describe("LfsrNlcBackend — frozen addendum A.3.11 vectors", () => {
  // Any divergence here means the keystream changed — which breaks interop
  // with everyone running an older build. Don't update casually.

  it("Vector 1: zero key, MI=AAAAAAAAAA+checksum, PT='HELLO'", () => {
    const key = new Uint8Array(15);
    const mi = mkMi("AAAAAAAAAA");
    const pt = new TextEncoder().encode("HELLO");
    const ct = new LfsrNlcBackend().init(key, mi).transform(pt, "encrypt");
    expect(hex(ct)).toBe("4e44104fa8");
  });

  it("Vector 2: pangram-derived key, MI=RANDOMGROU+checksum, PT=MIDNIGHT line", () => {
    const letters = appendChecksum("ABCDEFGHIJKLMNOPABCDEFGHIJKLMN");
    const key = encodeKey(letters).slice(0, 15);
    const mi = mkMi("RANDOMGROU");
    const pt = new TextEncoder().encode("MEET AT MIDNIGHT BEHIND THE MOTEL");
    const ct = new LfsrNlcBackend().init(key, mi).transform(pt, "encrypt");
    expect(hex(ct)).toBe(
      "fbbd8e53ad01f0a13d4b9d4f3d53641620c04758088f66227f588920694547716e",
    );
  });
});

describe("DesCbcBackend — padding-aware behaviour", () => {
  const backend = new DesCbcBackend();
  const key = seededKey(1);
  const mi = mkMi("DESTEST");

  it("pads to the next 8-byte boundary on encrypt", () => {
    const ct = backend.init(key, mi).transform(new Uint8Array([1, 2, 3]), "encrypt");
    expect(ct.length).toBe(8);
  });

  it("appends a full pad block for 8-byte aligned plaintext", () => {
    const pt = new Uint8Array(8).fill(0x55);
    const ct = backend.init(key, mi).transform(pt, "encrypt");
    expect(ct.length).toBe(16);
  });

  it("rejects a truncated ciphertext on decrypt", () => {
    const ct = backend.init(key, mi).transform(new Uint8Array([1, 2]), "encrypt");
    const truncated = ct.slice(0, 7);
    expect(() => backend.init(key, mi).transform(truncated, "decrypt")).toThrow(RangeError);
  });
});

describe("AesCtrBackend — stream invariants", () => {
  const backend = new AesCtrBackend();
  const key = seededKey(2);
  const mi = mkMi("AESTEST");

  it("preserves plaintext length (no padding)", () => {
    for (const n of [0, 1, 15, 16, 17, 64]) {
      const pt = seededBytes(n + 7, n);
      const ct = backend.init(key, mi).transform(pt, "encrypt");
      expect(ct.length).toBe(n);
    }
  });

  it("encrypt/decrypt is symmetric (mode argument is ignored)", () => {
    const pt = seededBytes(123, 32);
    const ct = backend.init(key, mi).transform(pt, "encrypt");
    const again = backend.init(key, mi).transform(pt, "decrypt");
    expect(hex(ct)).toBe(hex(again));
  });
});

describe("registry", () => {
  it("default ID resolves to LfsrNlcBackend", () => {
    expect(createBackend(DEFAULT_BACKEND_ID).id).toBe("lfsr-nlc");
  });

  it("every catalogue entry is dispatchable by id", () => {
    for (const b of ALL_BACKENDS) {
      expect(createBackend(b.id).id).toBe(b.id);
    }
  });

  it("all three backends produce distinct ciphertexts for the same input", () => {
    const key = seededKey(42);
    const mi = mkMi("CMPARE");
    const pt = new TextEncoder().encode("COMPARE THIS ACROSS BACKENDS");
    const outs = ALL_BACKENDS.map((b) => hex(b.init(key, mi).transform(pt, "encrypt")));
    expect(new Set(outs).size).toBe(3);
  });
});
