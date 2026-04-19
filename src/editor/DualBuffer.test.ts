import { describe, expect, it } from "vitest";
import {
  DualBuffer,
  InvalidClassificationError,
  MAX_CLASSIFICATION_LENGTH,
  TransmitDeniedError,
} from "./DualBuffer.js";

describe("DualBuffer slots", () => {
  it("starts with two empty PLAIN/TYPED slots", () => {
    const d = new DualBuffer();
    for (const id of ["A", "B"] as const) {
      const s = d.get(id);
      expect(s.form).toBe("PLAIN");
      expect(s.origin).toBe("TYPED");
      expect(s.classification).toBe("");
      expect(s.buffer.length).toBe(0);
    }
  });

  it("slot A and slot B are independent", () => {
    const d = new DualBuffer();
    d.get("A").buffer.insertString("HELLO A");
    d.get("B").buffer.insertString("HELLO B");
    expect(d.get("A").buffer.toString()).toBe("HELLO A");
    expect(d.get("B").buffer.toString()).toBe("HELLO B");
  });

  it("reset clears the slot and resets state", () => {
    const d = new DualBuffer();
    d.get("A").buffer.insertString("data");
    d.markReceived("A");
    d.reset("A");
    const s = d.get("A");
    expect(s.buffer.length).toBe(0);
    expect(s.form).toBe("PLAIN");
    expect(s.origin).toBe("TYPED");
  });
});

describe("classification", () => {
  it("accepts ≤20 chars of A-Z/0-9/space/dash (uppercased)", () => {
    const d = new DualBuffer();
    d.setClassification("A", "TOP SECRET-1");
    expect(d.get("A").classification).toBe("TOP SECRET-1");
  });

  it("uppercases and trims", () => {
    const d = new DualBuffer();
    d.setClassification("A", "  secret ");
    expect(d.get("A").classification).toBe("SECRET");
  });

  it("rejects >20 chars", () => {
    const d = new DualBuffer();
    expect(() => d.setClassification("A", "A".repeat(MAX_CLASSIFICATION_LENGTH + 1))).toThrow(
      InvalidClassificationError,
    );
  });

  it("rejects punctuation", () => {
    const d = new DualBuffer();
    expect(() => d.setClassification("A", "HELLO!")).toThrow(InvalidClassificationError);
  });
});

describe("form transitions", () => {
  it("markEncrypted sets form=CIPHER and origin=ENCRYPTED, preserving classification", () => {
    const d = new DualBuffer();
    d.setClassification("A", "SECRET");
    d.markEncrypted("A");
    const s = d.get("A");
    expect(s.form).toBe("CIPHER");
    expect(s.origin).toBe("ENCRYPTED");
    expect(s.classification).toBe("SECRET");
  });

  it("markDecrypted sets form=PLAIN, origin=DECRYPTED, and clears classification", () => {
    const d = new DualBuffer();
    d.setClassification("A", "SECRET");
    d.markEncrypted("A");
    d.markDecrypted("A");
    const s = d.get("A");
    expect(s.form).toBe("PLAIN");
    expect(s.origin).toBe("DECRYPTED");
    expect(s.classification).toBe("");
  });

  it("markReceived sets form=CIPHER and origin=RECEIVED", () => {
    const d = new DualBuffer();
    d.markReceived("B");
    expect(d.get("B").form).toBe("CIPHER");
    expect(d.get("B").origin).toBe("RECEIVED");
  });

  it("markTyped lets the operator explicitly enter cipher-entry mode", () => {
    const d = new DualBuffer();
    d.markTyped("A", "CIPHER");
    const s = d.get("A");
    expect(s.form).toBe("CIPHER");
    expect(s.origin).toBe("TYPED");
  });
});

describe("assertTransmittable (MANUAL p.52 rule)", () => {
  it("allows transmission of RECEIVED ciphertext", () => {
    const d = new DualBuffer();
    d.markReceived("A");
    expect(() => d.assertTransmittable("A")).not.toThrow();
  });

  it("allows transmission of device-encrypted ciphertext (origin=ENCRYPTED)", () => {
    const d = new DualBuffer();
    d.markEncrypted("A");
    expect(() => d.assertTransmittable("A")).not.toThrow();
  });

  it("denies transmission of TYPED + CIPHER with exact device message", () => {
    const d = new DualBuffer();
    d.markTyped("A", "CIPHER");
    try {
      d.assertTransmittable("A");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(TransmitDeniedError);
      expect((err as Error).message).toBe(
        "CIPHER TEXT HAS BEEN LOCALLY ENTERED. COMMUNICATIONS DENIED.",
      );
    }
  });

  it("plain text is always transmittable (no rule)", () => {
    const d = new DualBuffer();
    expect(() => d.assertTransmittable("A")).not.toThrow();
    d.get("A").buffer.insertString("HELLO");
    expect(() => d.assertTransmittable("A")).not.toThrow();
  });
});
