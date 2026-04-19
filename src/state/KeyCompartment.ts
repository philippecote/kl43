// 16-key compartment store (MANUAL p.7: "Up to 16 keys may be loaded at any
// one time. Each is identified by ID# 01 through 16.") Each slot holds a
// loaded TEK plus metadata; empty slots report the name "AVAILABLE".
//
// The compartment owns the current update level (0–35) and a cached
// derived key refreshed whenever the level changes. Upper layers
// (Encrypt, Decrypt, Auth) read `deriveCurrentKey()` and never touch the
// raw K_raw directly.
//
// Zeroize paths:
//   - `clear(id)`: MANUAL p.43 "Which key is to be cleared?"
//   - `clearAll()`: MANUAL p.43 "A - ALL" / "Zeroing . . ."
//   - auto-zeroize on BIT failure (MANUAL p.54, driven from upper layer).
//
// The store is deliberately in-memory only. Persistence wraps this layer
// (IndexedDB; see src/persistence once built) and is responsible for
// encrypting the compartment at rest — spec §9.4.

import {
  InvalidKeyError,
  K_RAW_LENGTH,
  KEY_LENGTH,
  parseKey,
} from "../crypto/KeyCodec.js";
import { MAX_UPDATE_LEVEL, advanceOneStep, updateKey } from "../crypto/Updater.js";

export const SLOT_COUNT = 16;
export const MIN_SLOT = 1;
export const MAX_SLOT = SLOT_COUNT;
export const NAME_MAX_LENGTH = 10;
export const AVAILABLE = "AVAILABLE";
const NAME_PATTERN = /^[A-Z0-9 -]{1,10}$/;

export class SlotIndexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlotIndexError";
  }
}

export class SlotEmptyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlotEmptyError";
  }
}

export class InvalidNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidNameError";
  }
}

export class UpdateExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpdateExhaustedError";
  }
}

export interface Compartment {
  readonly id: number;
  readonly name: string;
  readonly kRaw: Uint8Array;
  readonly checksum: number;
  readonly updateLevel: number;
  readonly currentKey: Uint8Array;
}

interface Slot {
  compartment: Compartment | null;
}

export class KeyCompartmentStore {
  private readonly slots: Slot[];
  private selectedId: number | null = null;

  constructor() {
    this.slots = Array.from({ length: SLOT_COUNT }, () => ({ compartment: null }));
  }

  /**
   * Load a key into the given slot. Parses the 32-letter key (validating
   * checksum), caches the initial derived key, and resets update level to 0.
   * Overwriting an existing slot is allowed and zeroizes the previous
   * material before writing the new one.
   */
  load(id: number, name: string, keyLetters: string): Compartment {
    assertSlotRange(id);
    const normalized = normalizeName(name);
    if (keyLetters.length !== KEY_LENGTH) {
      throw new InvalidKeyError(`expected ${KEY_LENGTH} letters, got ${keyLetters.length}`);
    }
    const { kRaw, checksum } = parseKey(keyLetters);
    const slot = this.slots[id - 1]!;
    if (slot.compartment) zeroize(slot.compartment.kRaw, slot.compartment.currentKey);

    const compartment: Compartment = Object.freeze({
      id,
      name: normalized,
      kRaw,
      checksum,
      updateLevel: 0,
      currentKey: updateKey(kRaw, 0),
    });
    slot.compartment = compartment;
    return compartment;
  }

  /** Read-only view. */
  peek(id: number): Compartment | null {
    assertSlotRange(id);
    return this.slots[id - 1]!.compartment;
  }

  /** List every slot in order, with empty slots represented as null. */
  list(): ReadonlyArray<Compartment | null> {
    return this.slots.map((s) => s.compartment);
  }

  select(id: number): Compartment {
    assertSlotRange(id);
    const c = this.slots[id - 1]!.compartment;
    if (!c) throw new SlotEmptyError(`slot ${id} is empty (${AVAILABLE})`);
    this.selectedId = id;
    return c;
  }

  selected(): Compartment | null {
    if (this.selectedId === null) return null;
    return this.slots[this.selectedId - 1]!.compartment;
  }

  /**
   * Advance the selected slot's update chain by one step. Caches the new
   * derived key. Refuses past MAX_UPDATE_LEVEL.
   */
  update(id: number): Compartment {
    assertSlotRange(id);
    const slot = this.slots[id - 1]!;
    const c = slot.compartment;
    if (!c) throw new SlotEmptyError(`slot ${id} is empty`);
    if (c.updateLevel >= MAX_UPDATE_LEVEL) {
      throw new UpdateExhaustedError(
        `slot ${id}: update level ${c.updateLevel} is the last; load a new TEK`,
      );
    }
    const nextLevel = c.updateLevel + 1;
    const nextKey = advanceOneStep(c.currentKey, nextLevel);
    // Overwrite previous derived key in place so it doesn't linger.
    zeroize(c.currentKey);
    const next: Compartment = Object.freeze({
      id,
      name: c.name,
      kRaw: c.kRaw,
      checksum: c.checksum,
      updateLevel: nextLevel,
      currentKey: nextKey,
    });
    slot.compartment = next;
    return next;
  }

  /** Zeroize a single slot. Equivalent to MANUAL p.43 single-key clear. */
  clear(id: number): void {
    assertSlotRange(id);
    const slot = this.slots[id - 1]!;
    if (slot.compartment) {
      zeroize(slot.compartment.kRaw, slot.compartment.currentKey);
      slot.compartment = null;
    }
    if (this.selectedId === id) this.selectedId = null;
  }

  /** Zeroize every slot. Fired on `ZRO - A` or on BIT-detected malfunction. */
  clearAll(): void {
    for (const slot of this.slots) {
      if (slot.compartment) {
        zeroize(slot.compartment.kRaw, slot.compartment.currentKey);
        slot.compartment = null;
      }
    }
    this.selectedId = null;
  }

  /**
   * Serialize the compartment into a plain-JSON form. Excludes the cached
   * `currentKey` since it's derivable from `kRaw` + `updateLevel`. This is a
   * dev-mode persistence hook for localStorage; the spec §9.4 "encrypted at
   * rest" guarantee is out of scope here.
   */
  snapshot(): SlotSnapshot[] {
    return this.slots.map((s) => {
      const c = s.compartment;
      if (!c) return null;
      return {
        id: c.id,
        name: c.name,
        kRaw: Array.from(c.kRaw),
        checksum: c.checksum,
        updateLevel: c.updateLevel,
      };
    });
  }

  /** Restore from a `snapshot()` result. Existing contents are zeroized first. */
  loadSnapshot(snap: SlotSnapshot[]): void {
    this.clearAll();
    for (const entry of snap) {
      if (!entry) continue;
      const slot = this.slots[entry.id - 1]!;
      const kRaw = new Uint8Array(entry.kRaw);
      slot.compartment = Object.freeze({
        id: entry.id,
        name: entry.name,
        kRaw,
        checksum: entry.checksum,
        updateLevel: entry.updateLevel,
        currentKey: updateKey(kRaw, entry.updateLevel),
      });
    }
  }
}

export type SlotSnapshot =
  | { id: number; name: string; kRaw: number[]; checksum: number; updateLevel: number }
  | null;

export function formatSlotLine(id: number, c: Compartment | null): string {
  const idStr = id.toString().padStart(2, "0");
  if (!c) return `${idStr} - ${AVAILABLE}`;
  return `${idStr} - ${c.name} - ${c.updateLevel.toString().padStart(2, "0")}`;
}

function assertSlotRange(id: number): void {
  if (!Number.isInteger(id) || id < MIN_SLOT || id > MAX_SLOT) {
    throw new SlotIndexError(`slot id must be an integer in [${MIN_SLOT}, ${MAX_SLOT}], got ${id}`);
  }
}

function normalizeName(name: string): string {
  const trimmed = name.trim().toUpperCase();
  if (trimmed.length === 0 || trimmed.length > NAME_MAX_LENGTH) {
    throw new InvalidNameError(
      `key name must be 1..${NAME_MAX_LENGTH} chars, got ${trimmed.length}`,
    );
  }
  if (!NAME_PATTERN.test(trimmed)) {
    throw new InvalidNameError(
      `key name must be alphanumeric (plus space, hyphen), got ${JSON.stringify(name)}`,
    );
  }
  return trimmed;
}

function zeroize(...buffers: Uint8Array[]): void {
  for (const b of buffers) b.fill(0);
}

// Re-exports for upper layers that don't want to cross module boundaries.
export { K_RAW_LENGTH };
