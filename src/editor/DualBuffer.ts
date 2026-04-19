// Dual message buffer: the KL-43C holds exactly two message slots, A and B.
// Each slot is a TextBuffer plus a small state header:
//
//   form   — "PLAIN" | "CIPHER"           what shape is in the buffer now
//   origin — "LOCAL" | "RECEIVED"         how it got there (MANUAL p.12, 22, 52:
//             locally-entered ciphertext cannot be transmitted)
//   classification — optional ≤20-char string prepended to a plaintext
//             message at Encrypt time (MANUAL p.12)
//
// Origin matters at transmit time: the device refuses to send ciphertext
// that was typed in via the keyboard. Tracking this on the slot itself is
// the simplest way to enforce that rule.

import { TextBuffer } from "./TextBuffer.js";

export type SlotId = "A" | "B";
export type MessageForm = "PLAIN" | "CIPHER";
// Origin tracks how the current bytes came to be in the slot. The
// transmit-denial rule (MANUAL p.52) fires only for operator-typed
// ciphertext — ciphertext produced by the device's own E operation is
// fully transmittable, as is ciphertext received via RECV.
export type MessageOrigin = "TYPED" | "ENCRYPTED" | "RECEIVED" | "DECRYPTED";

export const MAX_CLASSIFICATION_LENGTH = 20;
export const CLASSIFICATION_PATTERN = /^[A-Z0-9 \-]*$/;

export class InvalidClassificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidClassificationError";
  }
}

export class TransmitDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransmitDeniedError";
  }
}

export interface SlotState {
  readonly form: MessageForm;
  readonly origin: MessageOrigin;
  readonly classification: string;
  readonly buffer: TextBuffer;
}

function emptySlot(): SlotState {
  return { form: "PLAIN", origin: "TYPED", classification: "", buffer: new TextBuffer() };
}

export class DualBuffer {
  private slots: Record<SlotId, SlotState> = { A: emptySlot(), B: emptySlot() };

  get(id: SlotId): SlotState {
    return this.slots[id];
  }

  /** Clear a slot back to empty PLAIN/LOCAL state. */
  reset(id: SlotId): void {
    this.slots[id] = emptySlot();
  }

  /** Set the classification. Validates per MANUAL p.12 (≤20 chars, A-Z 0-9 space dash). */
  setClassification(id: SlotId, classification: string): void {
    const normalized = classification.trim().toUpperCase();
    if (normalized.length > MAX_CLASSIFICATION_LENGTH) {
      throw new InvalidClassificationError(
        `classification must be ≤${MAX_CLASSIFICATION_LENGTH} chars, got ${normalized.length}`,
      );
    }
    if (!CLASSIFICATION_PATTERN.test(normalized)) {
      throw new InvalidClassificationError(
        `classification must be A-Z/0-9/space/dash, got ${JSON.stringify(classification)}`,
      );
    }
    const cur = this.slots[id];
    this.slots[id] = {
      form: cur.form,
      origin: cur.origin,
      classification: normalized,
      buffer: cur.buffer,
    };
  }

  /** After E (encrypt): slot flips to CIPHER with ENCRYPTED provenance. */
  markEncrypted(id: SlotId): void {
    const cur = this.slots[id];
    this.slots[id] = {
      form: "CIPHER",
      origin: "ENCRYPTED",
      classification: cur.classification,
      buffer: cur.buffer,
    };
  }

  /** After D (decrypt): slot flips to PLAIN with DECRYPTED provenance. Classification clears. */
  markDecrypted(id: SlotId): void {
    const cur = this.slots[id];
    this.slots[id] = {
      form: "PLAIN",
      origin: "DECRYPTED",
      classification: "",
      buffer: cur.buffer,
    };
  }

  /** Called when RECV lands ciphertext into this slot. */
  markReceived(id: SlotId): void {
    const cur = this.slots[id];
    this.slots[id] = {
      form: "CIPHER",
      origin: "RECEIVED",
      classification: cur.classification,
      buffer: cur.buffer,
    };
  }

  /** Called when the operator types directly into the slot (plain or cipher). */
  markTyped(id: SlotId, form: MessageForm): void {
    const cur = this.slots[id];
    this.slots[id] = {
      form,
      origin: "TYPED",
      classification: cur.classification,
      buffer: cur.buffer,
    };
  }

  /**
   * Enforce MANUAL p.52: locally-entered (typed) ciphertext cannot be
   * transmitted. Encrypt-generated and received ciphertext are fine.
   */
  assertTransmittable(id: SlotId): void {
    const s = this.slots[id];
    if (s.form === "CIPHER" && s.origin === "TYPED") {
      throw new TransmitDeniedError(
        "CIPHER TEXT HAS BEEN LOCALLY ENTERED. COMMUNICATIONS DENIED.",
      );
    }
  }
}
