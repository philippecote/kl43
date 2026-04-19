// Shareable-key links: lets an operator bootstrap a second device by
// opening a URL that pre-packages a key + cipher choice.
//
//   https://…/kl43/?key=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&cipher=aes-ctr&name=DEMO
//
// On load we validate the key (32 letters, checksum), and if everything
// parses we pop a small confirmation modal. The user can Load or Dismiss.
// Load drops the key into slot 1, selects it, and strips the params from
// the URL so a refresh doesn't re-prompt.
//
// Because the selected backend is injected into the Machine at
// construction time, switching ciphers mid-run is not safe — we reload
// the page if the link's cipher differs from the currently-active one,
// and use sessionStorage to carry the key across the reload.
//
// This is a fun/demo affordance. The share URL is NOT a secure
// distribution channel — it lands in browser history, server logs, link
// previewers, etc. The KL-43 operator doctrine was always out-of-band
// key delivery (MANUAL pp.2–3 cite NACSI 4005); this feature exists so
// two browser tabs or phones can bootstrap each other without retyping.

import type { BackendId } from "../crypto/CryptoBackend.js";
import { KEY_LENGTH, parseKey, InvalidKeyError } from "../crypto/KeyCodec.js";
import type { KeyCompartmentStore } from "../state/KeyCompartment.js";

const CIPHER_STORAGE = "kl43.cipher.v1";
const KEY_STORAGE = "kl43.keyStore.v1";
const PENDING_KEY = "kl43.pendingSharedKey.v1";
const VALID_CIPHERS: readonly BackendId[] = ["lfsr-nlc", "aes-ctr", "des-cbc"];

export type SharePayload = {
  key: string;
  cipher: BackendId;
  name: string;
};

type ParsedShare =
  | { ok: true; payload: SharePayload }
  | { ok: false; reason: string };

function normalizeName(raw: string | null): string {
  const upper = (raw ?? "").toUpperCase().replace(/[^A-Z0-9 -]/g, "").slice(0, 10);
  return upper.length > 0 ? upper : "SHARED";
}

function parseParams(search: string): ParsedShare {
  const params = new URLSearchParams(search);
  const keyRaw = params.get("key");
  if (!keyRaw) return { ok: false, reason: "no key in URL" };
  const key = keyRaw.toUpperCase().replace(/\s+/g, "");
  if (key.length !== KEY_LENGTH) {
    return { ok: false, reason: `key must be ${KEY_LENGTH} letters, got ${key.length}` };
  }
  if (!/^[A-Z]+$/.test(key)) {
    return { ok: false, reason: "key must be A-Z only" };
  }
  try {
    parseKey(key); // checksum validation
  } catch (err) {
    if (err instanceof InvalidKeyError) {
      return { ok: false, reason: "key checksum does not validate" };
    }
    throw err;
  }
  const cipherRaw = (params.get("cipher") ?? "").toLowerCase();
  const cipher = (VALID_CIPHERS as readonly string[]).includes(cipherRaw)
    ? (cipherRaw as BackendId)
    : ("lfsr-nlc" as BackendId);
  const name = normalizeName(params.get("name"));
  return { ok: true, payload: { key, cipher, name } };
}

/**
 * Build a share URL pointing at the current page with the given payload.
 * The base is the current location sans query/hash, so it works identically
 * on localhost and on the deployed GitHub Pages URL.
 */
export function buildShareUrl(payload: SharePayload): string {
  const base = window.location.origin + window.location.pathname;
  const params = new URLSearchParams();
  params.set("key", payload.key);
  params.set("cipher", payload.cipher);
  params.set("name", payload.name);
  return `${base}?${params.toString()}`;
}

function stripShareParams(): void {
  const url = new URL(window.location.href);
  let changed = false;
  for (const k of ["key", "cipher", "name"]) {
    if (url.searchParams.has(k)) {
      url.searchParams.delete(k);
      changed = true;
    }
  }
  if (changed) window.history.replaceState({}, "", url.toString());
}

function loadKeyInto(keyStore: KeyCompartmentStore, payload: SharePayload): void {
  // Prefer slot 1 so the key-select UI shows it immediately; overwrite is
  // explicit and documented.
  const slotId = 1;
  keyStore.load(slotId, payload.name, payload.key);
  keyStore.select(slotId);
  try {
    localStorage.setItem(KEY_STORAGE, JSON.stringify(keyStore.snapshot()));
  } catch {
    /* non-fatal: best-effort persistence */
  }
}

function showConfirmDialog(payload: SharePayload): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "share-confirm-overlay";
    const label = VALID_CIPHERS.includes(payload.cipher) ? payload.cipher : "lfsr-nlc";
    const grouped = payload.key.match(/.{1,8}/g)?.join(" ") ?? payload.key;
    overlay.innerHTML = `
      <div class="share-confirm" role="dialog" aria-modal="true" aria-labelledby="share-confirm-title">
        <h2 id="share-confirm-title">Load shared key?</h2>
        <p>This link includes a KL-43 key that can be loaded into
           compartment 01, replacing anything already there.</p>
        <dl class="share-confirm-grid">
          <dt>Name</dt><dd>${escapeHtml(payload.name)}</dd>
          <dt>Cipher</dt><dd>${escapeHtml(label)}</dd>
          <dt>Key</dt><dd class="share-confirm-key">${escapeHtml(grouped)}</dd>
        </dl>
        <p class="share-confirm-warn">
          Keys sent over a URL are not secure — they live in browser
          history, link previewers, and server logs. For fun only.
        </p>
        <div class="share-confirm-actions">
          <button type="button" class="share-confirm-cancel">Dismiss</button>
          <button type="button" class="share-confirm-ok">Load key</button>
        </div>
      </div>
    `;
    const finish = (ok: boolean) => {
      overlay.remove();
      resolve(ok);
    };
    overlay.querySelector(".share-confirm-ok")!.addEventListener("click", () => finish(true));
    overlay.querySelector(".share-confirm-cancel")!.addEventListener("click", () => finish(false));
    overlay.addEventListener("click", (e) => { if (e.target === overlay) finish(false); });
    document.body.appendChild(overlay);
    (overlay.querySelector(".share-confirm-ok") as HTMLButtonElement).focus();
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&#39;";
    }
  });
}

/**
 * Top-level entry called by main.ts during boot. Handles both the
 * "pending across reload" case (carried in sessionStorage after we
 * reloaded to switch ciphers) and the "fresh URL arrival" case.
 *
 * Returns a short user-facing toast string when a key was loaded
 * automatically, so the host can surface it. Returns null otherwise.
 */
export async function handleShareOnBoot(
  keyStore: KeyCompartmentStore,
  currentCipher: BackendId,
): Promise<string | null> {
  // Post-reload: honour the pending payload written before the reload.
  const pending = sessionStorage.getItem(PENDING_KEY);
  if (pending) {
    sessionStorage.removeItem(PENDING_KEY);
    try {
      const payload = JSON.parse(pending) as SharePayload;
      loadKeyInto(keyStore, payload);
      return `Loaded shared key ${payload.name} into 01`;
    } catch {
      return null;
    }
  }

  // Fresh arrival via URL.
  const parsed = parseParams(window.location.search);
  if (!parsed.ok) {
    // Strip noise if someone typed a junk `?key=` param.
    if (window.location.search.includes("key=")) stripShareParams();
    return null;
  }

  const ok = await showConfirmDialog(parsed.payload);
  if (!ok) {
    stripShareParams();
    return null;
  }

  if (parsed.payload.cipher !== currentCipher) {
    // Persist the payload, switch cipher, and reload. The backend is only
    // plumbed into the Machine at construction time (see topbar.ts:
    // "mid-session swaps aren't safe"), so reload is the honest path.
    sessionStorage.setItem(PENDING_KEY, JSON.stringify(parsed.payload));
    localStorage.setItem(CIPHER_STORAGE, parsed.payload.cipher);
    stripShareParams();
    window.location.reload();
    // Never returns — this await below is effectively unreachable.
    return null;
  }

  loadKeyInto(keyStore, parsed.payload);
  stripShareParams();
  return `Loaded shared key ${parsed.payload.name} into 01`;
}
