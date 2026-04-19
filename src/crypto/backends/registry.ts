// Factory + catalogue for the runtime-selectable cipher backends.
// The UI (top-bar picker) iterates `ALL_BACKENDS` to render its radio list;
// `createBackend(id)` materialises the instance that the Machine consumes.

import { BackendId, CryptoBackend } from "../CryptoBackend.js";
import { AesCtrBackend } from "./AesCtrBackend.js";
import { DesCbcBackend } from "./DesCbcBackend.js";
import { LfsrNlcBackend } from "./LfsrNlcBackend.js";

export const DEFAULT_BACKEND_ID: BackendId = "lfsr-nlc";

export function createBackend(id: BackendId): CryptoBackend {
  switch (id) {
    case "lfsr-nlc": return new LfsrNlcBackend();
    case "aes-ctr":  return new AesCtrBackend();
    case "des-cbc":  return new DesCbcBackend();
  }
}

export const ALL_BACKENDS: readonly CryptoBackend[] = [
  new LfsrNlcBackend(),
  new AesCtrBackend(),
  new DesCbcBackend(),
];
