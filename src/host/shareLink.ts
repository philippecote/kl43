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
import {
  AVAILABLE,
  InvalidNameError,
  NAME_MAX_LENGTH,
  SLOT_COUNT,
  type KeyCompartmentStore,
} from "../state/KeyCompartment.js";

const CIPHER_STORAGE = "kl43.cipher.v1";
const KEY_STORAGE = "kl43.keyStore.v1";
const PENDING_KEY = "kl43.pendingSharedKey.v1";
const VALID_CIPHERS: readonly BackendId[] = ["lfsr-nlc", "aes-ctr", "des-cbc"];

/** The raw URL-encoded payload (key material + suggested metadata). */
export type SharePayload = {
  key: string;
  cipher: BackendId;
  name: string;
};

/**
 * A confirmed load request: the user has picked a destination slot and a
 * final name via the confirmation dialog. This is what we carry across the
 * cipher-switch reload and what we hand to `keyStore.load`.
 */
export type ConfirmedLoad = SharePayload & {
  slot: number;
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

/**
 * Find the first empty compartment, 1..SLOT_COUNT. Returns null if every
 * slot is already loaded — in that case the dialog forces the user to
 * pick one to overwrite explicitly.
 */
function findFirstEmptySlot(keyStore: KeyCompartmentStore): number | null {
  for (let id = 1; id <= SLOT_COUNT; id++) {
    if (keyStore.peek(id) === null) return id;
  }
  return null;
}

/**
 * Commit a confirmed load into the key store, selecting the new slot and
 * persisting the updated snapshot. Exported so the topbar's "Load locally"
 * button can reuse the exact same path shared-link intake takes.
 */
export function commitLoad(keyStore: KeyCompartmentStore, load: ConfirmedLoad): void {
  keyStore.load(load.slot, load.name, load.key);
  keyStore.select(load.slot);
  try {
    localStorage.setItem(KEY_STORAGE, JSON.stringify(keyStore.snapshot()));
  } catch {
    /* non-fatal: best-effort persistence */
  }
}

function loadKeyInto(keyStore: KeyCompartmentStore, load: ConfirmedLoad): void {
  commitLoad(keyStore, load);
}

export function slotLabel(id: number): string {
  return id.toString().padStart(2, "0");
}

/**
 * Render the slot-picker `<select>` options. Empty slots are listed first
 * as "05 — AVAILABLE" style entries; occupied slots follow, labelled with
 * the current key name so overwrite is explicit. `defaultId` is the
 * pre-selected option — normally the first empty slot, or slot 1 if none.
 */
function buildSlotOptions(keyStore: KeyCompartmentStore, defaultId: number): string {
  const options: string[] = [];
  for (let id = 1; id <= SLOT_COUNT; id++) {
    const comp = keyStore.peek(id);
    const label = comp
      ? `${slotLabel(id)} — ${comp.name} (overwrite)`
      : `${slotLabel(id)} — ${AVAILABLE}`;
    const selected = id === defaultId ? " selected" : "";
    options.push(
      `<option value="${id}"${selected}>${escapeHtml(label)}</option>`,
    );
  }
  return options.join("");
}

/**
 * Context for the confirm dialog. `shared-link` wording warns about URL
 * leakage; `local-keygen` is the same chrome reused by the key generator
 * to drop a freshly-made key into a chosen compartment without leaving
 * the app.
 */
export type LoadSource = "shared-link" | "local-keygen";

function dialogCopy(source: LoadSource): {
  title: string;
  intro: string;
  warn: string | null;
} {
  if (source === "shared-link") {
    return {
      title: "Load shared key?",
      intro: "This link includes a KL-43 key. Pick a compartment and give it a name before loading.",
      warn:
        "Keys sent over a URL are not secure — they live in browser " +
        "history, link previewers, and server logs. For fun only.",
    };
  }
  return {
    title: "Load key into device?",
    intro: "Pick a compartment and give the key a name. This is equivalent to typing it at the Key Change prompt.",
    warn: null,
  };
}

export function promptForKeyLoad(
  payload: SharePayload,
  keyStore: KeyCompartmentStore,
  source: LoadSource = "shared-link",
): Promise<ConfirmedLoad | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "share-confirm-overlay";
    const label = VALID_CIPHERS.includes(payload.cipher) ? payload.cipher : "lfsr-nlc";
    const grouped = payload.key.match(/.{1,8}/g)?.join(" ") ?? payload.key;
    const copy = dialogCopy(source);

    // Pick a sensible default destination: first empty slot, else slot 1.
    // When every slot is full we surface a warning — the user has to
    // deliberately choose which compartment to overwrite.
    const firstEmpty = findFirstEmptySlot(keyStore);
    const defaultSlot = firstEmpty ?? 1;
    const allFull = firstEmpty === null;

    overlay.innerHTML = `
      <div class="share-confirm" role="dialog" aria-modal="true" aria-labelledby="share-confirm-title">
        <h2 id="share-confirm-title">${escapeHtml(copy.title)}</h2>
        <p>${escapeHtml(copy.intro)}</p>
        <dl class="share-confirm-grid">
          <dt>Cipher</dt><dd>${escapeHtml(label)}</dd>
          <dt>Key</dt><dd class="share-confirm-key">${escapeHtml(grouped)}</dd>
        </dl>
        <div class="share-confirm-field">
          <label for="share-confirm-name">Name</label>
          <input type="text" id="share-confirm-name" class="share-confirm-input"
                 maxlength="${NAME_MAX_LENGTH}"
                 value="${escapeHtml(payload.name)}"
                 autocomplete="off" spellcheck="false" />
          <span class="share-confirm-hint">Up to ${NAME_MAX_LENGTH} chars: A–Z, 0–9, space, hyphen.</span>
        </div>
        <div class="share-confirm-field">
          <label for="share-confirm-slot">Compartment</label>
          <select id="share-confirm-slot" class="share-confirm-select">
            ${buildSlotOptions(keyStore, defaultSlot)}
          </select>
          <span class="share-confirm-hint" id="share-confirm-slot-hint"></span>
        </div>
        ${allFull ? `
        <p class="share-confirm-warn">
          Every compartment is already loaded. Pick one to overwrite — the
          existing key in that slot will be zeroized.
        </p>` : ""}
        ${copy.warn ? `<p class="share-confirm-warn">${escapeHtml(copy.warn)}</p>` : ""}
        <p class="share-confirm-error" id="share-confirm-error"></p>
        <div class="share-confirm-actions">
          <button type="button" class="share-confirm-cancel">Dismiss</button>
          <button type="button" class="share-confirm-ok">Load key</button>
        </div>
      </div>
    `;

    const nameInput = overlay.querySelector("#share-confirm-name") as HTMLInputElement;
    const slotSelect = overlay.querySelector("#share-confirm-slot") as HTMLSelectElement;
    const slotHint = overlay.querySelector("#share-confirm-slot-hint") as HTMLSpanElement;
    const errorEl = overlay.querySelector("#share-confirm-error") as HTMLParagraphElement;

    const updateSlotHint = () => {
      const id = Number(slotSelect.value);
      const comp = keyStore.peek(id);
      if (comp) {
        slotHint.textContent = `Will overwrite "${comp.name}" (update level ${comp.updateLevel}).`;
        slotHint.classList.add("share-confirm-hint-warn");
      } else {
        slotHint.textContent = "Slot is empty.";
        slotHint.classList.remove("share-confirm-hint-warn");
      }
    };
    slotSelect.addEventListener("change", updateSlotHint);
    updateSlotHint();

    // Uppercase name input in place so the preview matches what the key
    // store will actually persist (normalizeName uppercases too).
    nameInput.addEventListener("input", () => {
      const start = nameInput.selectionStart;
      nameInput.value = nameInput.value.toUpperCase();
      if (start !== null) nameInput.setSelectionRange(start, start);
      errorEl.textContent = "";
    });

    const finish = (result: ConfirmedLoad | null) => {
      overlay.remove();
      resolve(result);
    };

    const attemptLoad = () => {
      const chosenSlot = Number(slotSelect.value);
      const chosenName = nameInput.value.trim();
      if (chosenName.length === 0) {
        errorEl.textContent = "Name is required.";
        nameInput.focus();
        return;
      }
      // Surface a precise error rather than letting keyStore.load throw
      // after the dialog has already closed.
      try {
        // Mirror the KeyCompartmentStore validation up-front.
        if (chosenName.length > NAME_MAX_LENGTH) throw new InvalidNameError("too long");
        if (!/^[A-Z0-9 -]+$/.test(chosenName)) throw new InvalidNameError("bad chars");
      } catch (err) {
        if (err instanceof InvalidNameError) {
          errorEl.textContent = `Name must be 1..${NAME_MAX_LENGTH} chars: A–Z, 0–9, space, hyphen.`;
          nameInput.focus();
          return;
        }
        throw err;
      }
      finish({ ...payload, name: chosenName, slot: chosenSlot });
    };

    overlay.querySelector(".share-confirm-ok")!.addEventListener("click", attemptLoad);
    overlay.querySelector(".share-confirm-cancel")!.addEventListener("click", () => finish(null));
    overlay.addEventListener("click", (e) => { if (e.target === overlay) finish(null); });
    overlay.addEventListener("keydown", (e) => {
      const ke = e as KeyboardEvent;
      if (ke.key === "Enter" && document.activeElement !== slotSelect) {
        ke.preventDefault();
        attemptLoad();
      } else if (ke.key === "Escape") {
        ke.preventDefault();
        finish(null);
      }
    });
    document.body.appendChild(overlay);
    nameInput.focus();
    nameInput.select();
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
  // Post-reload: honour the confirmed load written before the reload (the
  // user already picked slot + name in the dialog pre-reload).
  const pending = sessionStorage.getItem(PENDING_KEY);
  if (pending) {
    sessionStorage.removeItem(PENDING_KEY);
    try {
      const load = JSON.parse(pending) as ConfirmedLoad;
      if (typeof load.slot !== "number") {
        // Older schema without a slot — fall through silently.
        return null;
      }
      loadKeyInto(keyStore, load);
      return `Loaded shared key ${load.name} into ${slotLabel(load.slot)}`;
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

  const confirmed = await promptForKeyLoad(parsed.payload, keyStore, "shared-link");
  if (!confirmed) {
    stripShareParams();
    return null;
  }

  if (confirmed.cipher !== currentCipher) {
    // Persist the confirmed load, switch cipher, and reload. The backend
    // is only plumbed into the Machine at construction time (see
    // topbar.ts: "mid-session swaps aren't safe"), so reload is the
    // honest path — and we carry the user's chosen slot + name through.
    sessionStorage.setItem(PENDING_KEY, JSON.stringify(confirmed));
    localStorage.setItem(CIPHER_STORAGE, confirmed.cipher);
    stripShareParams();
    window.location.reload();
    // Never returns — this await below is effectively unreachable.
    return null;
  }

  loadKeyInto(keyStore, confirmed);
  stripShareParams();
  return `Loaded shared key ${confirmed.name} into ${slotLabel(confirmed.slot)}`;
}
