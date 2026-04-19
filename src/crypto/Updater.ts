// Key-update chain. The real KL-43 allows up to 35 successive updates of a
// TEK without reloading fresh key material (MANUAL p.41). Each update
// advances the chain by one step along a one-way function. The operator
// sees only the update counter (0–35); the derived key replaces the
// working copy transparently.
//
// The real algorithm is classified. Substitute (spec §6.5):
//
//   update_key(k_raw, level):
//     k = k_raw
//     for i in 1..level:
//       k = HMAC-SHA-256(k, "KL43-UPDATE-" || byte(i))[:15]
//     return k
//
// Properties we preserve from the spec:
//   - Deterministic: same (k_raw, level) → same derived key on both sides.
//   - One-way: compromise of k_{level=N} does not reveal k_{level<N}.
//   - Bounded: level 35 is the last; level 36+ is refused.

import { K_RAW_LENGTH } from "./KeyCodec.js";
import { hmacSha256 } from "./primitives.js";

export const MAX_UPDATE_LEVEL = 35;
export const UPDATE_SALT_PREFIX = "KL43-UPDATE-";

export class UpdateLevelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpdateLevelError";
  }
}

/**
 * Derive the working key at the given update level. Level 0 returns K_raw
 * unchanged. Each subsequent level applies one HMAC-SHA-256 step.
 */
export function updateKey(kRaw: Uint8Array, level: number): Uint8Array {
  if (kRaw.length !== K_RAW_LENGTH) {
    throw new RangeError(`K_raw must be ${K_RAW_LENGTH} bytes, got ${kRaw.length}`);
  }
  if (!Number.isInteger(level) || level < 0 || level > MAX_UPDATE_LEVEL) {
    throw new UpdateLevelError(
      `update level must be an integer in [0, ${MAX_UPDATE_LEVEL}], got ${level}`,
    );
  }
  let k = new Uint8Array(kRaw);
  for (let i = 1; i <= level; i++) {
    const salt = saltForStep(i);
    k = hmacSha256(k, salt).slice(0, K_RAW_LENGTH);
  }
  return k;
}

/**
 * Advance an existing derived key by one step. Equivalent to
 * updateKey(k_raw, level+1) but cheaper when caching the current key.
 * The caller passes the *current* derived key and the *next* level number.
 */
export function advanceOneStep(currentKey: Uint8Array, nextLevel: number): Uint8Array {
  if (currentKey.length !== K_RAW_LENGTH) {
    throw new RangeError(`current key must be ${K_RAW_LENGTH} bytes, got ${currentKey.length}`);
  }
  if (!Number.isInteger(nextLevel) || nextLevel < 1 || nextLevel > MAX_UPDATE_LEVEL) {
    throw new UpdateLevelError(
      `next level must be an integer in [1, ${MAX_UPDATE_LEVEL}], got ${nextLevel}`,
    );
  }
  return hmacSha256(currentKey, saltForStep(nextLevel)).slice(0, K_RAW_LENGTH);
}

function saltForStep(i: number): Uint8Array {
  // "KL43-UPDATE-" || byte(i). We encode the prefix as ASCII and append the
  // single byte of step index.
  const prefix = new TextEncoder().encode(UPDATE_SALT_PREFIX);
  const out = new Uint8Array(prefix.length + 1);
  out.set(prefix, 0);
  out[prefix.length] = i & 0xff;
  return out;
}
