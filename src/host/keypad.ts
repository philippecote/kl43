// Build the keypad as transparent hotspots overlaid on the device photograph.
// Each key is a position:absolute button whose top/left/width/height are
// percentages relative to the device container (which has the image as its
// background). Positions come from three sources, merged in order:
//
//   1. A computed grid from ROW_BANDS/COL_* (fallback for any missing key)
//   2. HOTSPOT_OVERRIDES at module scope (committed by calibration)
//   3. localStorage overrides (live-edited in calibration mode)
//
// In calibration mode (`?calibrate` on the URL), hotspots become draggable
// and resizable. Click selects; drag middle moves; drag corner resizes;
// arrow keys nudge (Shift ×10). Press `C` to copy the full override JSON to
// the clipboard, `R` to reset localStorage, `Escape` to deselect.
//
// Key → Machine event mapping (by id):
//   SRCH  → { kind: "key", key: "SRCH_ON" }
//   XIT/ENTER/ZRO/UP/DOWN/LEFT/RIGHT/BOT/EOT/BOL/EOL/DCH/DWD/CLK → key event
//   SPC   → { kind: "char", ch: " " }
//   digits D0..D9 → { kind: "char", ch: "0".."9" }
//   punctuation caps → { kind: "char", ch: <legend> }
//   alpha A..Z → { kind: "char", ch: <id> }

import layout from "../../KEYPAD_LAYOUT.json";
import type { KeyEvent } from "../machine/Machine.js";

type KeyDef = {
  id: string;
  legend: string;
  row: number;
  col: number;
  rowSpan?: number;
  category: "alpha" | "digit" | "punct" | "nav" | "edit" | "special";
};

type Rect = { top: number; left: number; width: number; height: number };

const KEYS = (layout as { keys: KeyDef[] }).keys;

// Initial grid geometry (fallback). Adjusted by hand via calibration.
type Band = { top: number; height: number };
const ROW_BANDS: Band[] = [
  { top: 44.50, height: 4.35 },
  { top: 57.68, height: 4.92 },
  { top: 65.71, height: 4.57 },
  { top: 73.44, height: 4.57 },
  { top: 81.24, height: 4.69 },
];
const COL_LEFT_START = 15.0;
const COL_PITCH = 6.10;
const COL_WIDTH = 5.20;

// Committed overrides — baked from a hand-calibration session against
// public/device.png. Values are percentages of the device container.
const HOTSPOT_OVERRIDES: Partial<Record<string, Rect>> = {
  BOT:   { top: 44.227, left: 16.364, width: 4.745, height: 3.122 },
  EOT:   { top: 44.227, left: 22.373, width: 4.745, height: 2.986 },
  DOWN:  { top: 44.364, left: 28.473, width: 4.745, height: 3.122 },
  UP:    { top: 44.364, left: 34.482, width: 4.745, height: 2.986 },
  LEFT:  { top: 44.227, left: 40.673, width: 4.655, height: 3.259 },
  RIGHT: { top: 44.364, left: 46.682, width: 4.745, height: 3.122 },
  BOL:   { top: 44.364, left: 52.782, width: 4.564, height: 2.986 },
  EOL:   { top: 44.364, left: 58.882, width: 4.655, height: 3.122 },
  DCH:   { top: 44.364, left: 64.982, width: 4.655, height: 2.986 },
  DWD:   { top: 44.500, left: 70.991, width: 4.745, height: 2.986 },
  SRCH:  { top: 44.364, left: 77.091, width: 4.745, height: 3.122 },

  D1:   { top: 50.041, left: 13.545, width: 4.836, height: 4.920 },
  D2:   { top: 50.177, left: 19.464, width: 4.745, height: 4.920 },
  D3:   { top: 50.041, left: 25.473, width: 4.836, height: 4.920 },
  D4:   { top: 50.041, left: 31.664, width: 4.564, height: 4.920 },
  D5:   { top: 50.041, left: 37.673, width: 4.655, height: 4.920 },
  D6:   { top: 50.041, left: 43.682, width: 4.836, height: 4.920 },
  D7:   { top: 49.904, left: 49.691, width: 4.745, height: 4.920 },
  D8:   { top: 50.041, left: 55.791, width: 4.745, height: 4.920 },
  D9:   { top: 50.041, left: 61.800, width: 4.836, height: 4.920 },
  D0:   { top: 49.904, left: 67.991, width: 4.745, height: 4.920 },
  LPAR: { top: 50.041, left: 74.000, width: 4.745, height: 4.920 },
  RPAR: { top: 50.041, left: 80.100, width: 4.655, height: 4.920 },

  Q:     { top: 58.071, left: 16.455, width: 4.655, height: 4.570 },
  W:     { top: 58.207, left: 22.555, width: 4.655, height: 4.570 },
  E:     { top: 58.071, left: 28.564, width: 4.745, height: 4.570 },
  R:     { top: 58.071, left: 34.573, width: 4.745, height: 4.570 },
  T:     { top: 57.934, left: 40.673, width: 4.564, height: 4.570 },
  Y:     { top: 58.071, left: 46.955, width: 4.473, height: 4.570 },
  U:     { top: 58.071, left: 52.964, width: 4.291, height: 4.570 },
  I:     { top: 57.934, left: 58.791, width: 4.745, height: 4.570 },
  O:     { top: 58.071, left: 64.982, width: 4.564, height: 4.570 },
  P:     { top: 58.071, left: 70.991, width: 4.745, height: 4.434 },
  DASH:  { top: 57.934, left: 77.091, width: 4.655, height: 4.979 },
  ENTER: { top: 57.934, left: 84.464, width: 3.200, height: 12.982 },

  ZRO:   { top: 65.801, left: 11.546, width: 4.655, height: 4.570 },
  A:     { top: 65.664, left: 17.464, width: 4.745, height: 4.570 },
  S:     { top: 65.664, left: 23.473, width: 4.745, height: 4.570 },
  D:     { top: 65.664, left: 29.482, width: 4.745, height: 4.570 },
  F:     { top: 65.664, left: 35.673, width: 4.745, height: 4.570 },
  G:     { top: 65.801, left: 41.591, width: 4.836, height: 4.570 },
  H:     { top: 65.664, left: 47.782, width: 4.655, height: 4.570 },
  J:     { top: 65.664, left: 53.791, width: 4.745, height: 4.570 },
  K:     { top: 65.801, left: 59.891, width: 4.564, height: 4.570 },
  L:     { top: 65.528, left: 65.900, width: 4.745, height: 4.979 },
  SLASH: { top: 65.801, left: 72.000, width: 4.745, height: 4.843 },
  XIT:   { top: 65.801, left: 78.009, width: 4.655, height: 4.570 },

  CLK:   { top: 73.464, left: 14.909, width: 4.564, height: 4.690 },
  Z:     { top: 73.464, left: 21.009, width: 4.473, height: 4.690 },
  X:     { top: 73.464, left: 27.018, width: 4.564, height: 4.690 },
  C:     { top: 73.464, left: 32.936, width: 4.655, height: 4.690 },
  V:     { top: 73.464, left: 38.946, width: 4.745, height: 4.690 },
  B:     { top: 73.464, left: 45.046, width: 4.655, height: 4.690 },
  N:     { top: 73.464, left: 51.055, width: 4.655, height: 4.690 },
  M:     { top: 73.601, left: 57.246, width: 4.655, height: 4.690 },
  COMMA: { top: 73.464, left: 63.255, width: 4.655, height: 4.690 },
  DOT:   { top: 73.601, left: 69.355, width: 4.564, height: 4.690 },
  QUEST: { top: 73.601, left: 75.364, width: 4.745, height: 4.826 },
  SPC:   { top: 73.601, left: 81.373, width: 4.655, height: 4.690 },
};

// Extra hit areas for non-rectangular keys. ENTER is an inverted-L on the
// device: a tall narrow vertical piece on the right (primary above) plus a
// wider horizontal cap at the top extending leftward over what would be the
// DASH column. Each extra hotspot dispatches the same event as `for` and
// flashes together with it.
const EXTRA_HOTSPOTS: Array<{ for: string; rect: Rect }> = [
  { for: "ENTER", rect: { top: 57.934, left: 83.091, width: 4.755, height: 4.846 } },
];

const STORAGE_KEY = "kl43.hotspots";

const PUNCT_LEGEND_TO_CHAR: Record<string, string> = {
  "(": "(", ")": ")", "-": "-", "/": "/", ",": ",", ".": ".", "?": "?",
};

export function keyEventFor(id: string, legend: string): KeyEvent | null {
  switch (id) {
    case "XIT":   return { kind: "key", key: "XIT" };
    case "ENTER": return { kind: "key", key: "ENTER" };
    case "ZRO":   return { kind: "key", key: "ZRO" };
    case "UP":    return { kind: "key", key: "UP" };
    case "DOWN":  return { kind: "key", key: "DOWN" };
    case "LEFT":  return { kind: "key", key: "LEFT" };
    case "RIGHT": return { kind: "key", key: "RIGHT" };
    case "BOT":   return { kind: "key", key: "BOT" };
    case "EOT":   return { kind: "key", key: "EOT" };
    case "BOL":   return { kind: "key", key: "BOL" };
    case "EOL":   return { kind: "key", key: "EOL" };
    case "DCH":   return { kind: "key", key: "DCH" };
    case "DWD":   return { kind: "key", key: "DWD" };
    case "CLK":   return { kind: "key", key: "CLK" };
    case "SRCH":  return { kind: "key", key: "SRCH_ON" };
    case "SPC":   return { kind: "char", ch: " " };
  }
  if (/^D[0-9]$/.test(id)) return { kind: "char", ch: id.charAt(1) };
  if (/^[0-9]$/.test(id)) return { kind: "char", ch: id };
  if (/^[A-Z]$/.test(id)) return { kind: "char", ch: id };
  const punct = PUNCT_LEGEND_TO_CHAR[legend];
  if (punct !== undefined) return { kind: "char", ch: punct };
  return null;
}

function computedRect(k: KeyDef): Rect {
  const band = ROW_BANDS[k.row];
  if (!band) throw new Error(`no band for row ${k.row}`);
  const left = COL_LEFT_START + k.col * COL_PITCH;
  const top = band.top;
  let height = band.height;
  if (k.rowSpan && k.rowSpan > 1) {
    const lastBand = ROW_BANDS[k.row + k.rowSpan - 1];
    if (lastBand) height = lastBand.top + lastBand.height - band.top;
  }
  return { top, left, width: COL_WIDTH, height };
}

function loadLocalOverrides(): Record<string, Rect> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) as Record<string, Rect> : {};
  } catch { return {}; }
}

function saveLocalOverrides(o: Record<string, Rect>): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(o));
}

function rectForKey(k: KeyDef, local: Record<string, Rect>): Rect {
  return local[k.id] ?? HOTSPOT_OVERRIDES[k.id] ?? computedRect(k);
}

function applyRect(btn: HTMLButtonElement, r: Rect): void {
  btn.style.top = `${r.top}%`;
  btn.style.left = `${r.left}%`;
  btn.style.width = `${r.width}%`;
  btn.style.height = `${r.height}%`;
}

export type KeypadHandles = {
  flashKey: (id: string) => void;
  keysById: Map<string, HTMLButtonElement>;
};

export function buildKeypad(
  host: HTMLElement,
  onEvent: (ev: KeyEvent) => void,
): KeypadHandles {
  host.innerHTML = "";
  const byId = new Map<string, HTMLButtonElement>();
  const local = loadLocalOverrides();

  const allById = new Map<string, HTMLButtonElement[]>();
  const pushBtn = (id: string, btn: HTMLButtonElement) => {
    const arr = allById.get(id);
    if (arr) arr.push(btn);
    else allById.set(id, [btn]);
  };

  for (const k of KEYS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `key ${k.category}`;
    btn.dataset.id = k.id;
    btn.dataset.calId = k.id;
    btn.setAttribute("aria-label", k.legend || k.id);
    applyRect(btn, rectForKey(k, local));
    // Use pointerdown (not click) so iOS Safari doesn't impose the ~300ms
    // synthesized-click delay on touch input.
    btn.addEventListener("pointerdown", (e) => {
      if (document.body.classList.contains("calibrate")) return;
      if (e.button !== undefined && e.button !== 0) return;
      e.preventDefault();
      const ev = keyEventFor(k.id, k.legend);
      if (ev) onEvent(ev);
    });
    host.appendChild(btn);
    byId.set(k.id, btn);
    pushBtn(k.id, btn);
  }

  for (let i = 0; i < EXTRA_HOTSPOTS.length; i++) {
    const extra = EXTRA_HOTSPOTS[i]!;
    const parent = KEYS.find((x) => x.id === extra.for);
    if (!parent) continue;
    const calId = `${parent.id}:${i + 1}`;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `key ${parent.category}`;
    btn.dataset.id = parent.id;
    btn.dataset.calId = calId;
    btn.setAttribute("aria-label", parent.legend || parent.id);
    applyRect(btn, local[calId] ?? extra.rect);
    btn.addEventListener("pointerdown", (e) => {
      if (document.body.classList.contains("calibrate")) return;
      if (e.button !== undefined && e.button !== 0) return;
      e.preventDefault();
      const ev = keyEventFor(parent.id, parent.legend);
      if (ev) onEvent(ev);
    });
    host.appendChild(btn);
    pushBtn(parent.id, btn);
  }

  return {
    flashKey: (id: string) => {
      const btns = allById.get(id);
      if (!btns) return;
      for (const b of btns) b.classList.add("pressed");
      setTimeout(() => { for (const b of btns) b.classList.remove("pressed"); }, 90);
    },
    keysById: byId,
  };
}

// ---------------------------------------------------------------------------
// Calibration: visual drag/resize for hotspots with localStorage persistence.

type Handle = "move" | "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

export function enableCalibration(deviceEl: HTMLElement, keypadEl: HTMLElement): void {
  if (!/[?&]calibrate\b/.test(location.search)) return;
  document.body.classList.add("calibrate");

  const local: Record<string, Rect> = loadLocalOverrides();
  let selected: HTMLButtonElement | null = null;

  // HUD
  const hud = document.createElement("div");
  hud.id = "calibration-hud";
  hud.innerHTML = `<b>calibration</b><br>click a key to select · drag middle or corners · arrow keys nudge (shift ×10) · <b>C</b> copy · <b>R</b> reset · <b>Esc</b> deselect<br><span id="cal-info">—</span>`;
  document.body.appendChild(hud);
  const info = hud.querySelector<HTMLSpanElement>("#cal-info")!;

  const setInfo = (id: string | null, r: Rect | null) => {
    if (!id || !r) { info.textContent = "—"; return; }
    info.textContent = `${id}  top:${r.top.toFixed(2)}  left:${r.left.toFixed(2)}  w:${r.width.toFixed(2)}  h:${r.height.toFixed(2)}`;
  };

  const getRect = (btn: HTMLButtonElement): Rect => ({
    top: parseFloat(btn.style.top),
    left: parseFloat(btn.style.left),
    width: parseFloat(btn.style.width),
    height: parseFloat(btn.style.height),
  });

  const calKey = (btn: HTMLButtonElement) => btn.dataset.calId ?? btn.dataset.id!;

  const setRect = (btn: HTMLButtonElement, r: Rect) => {
    const clamped: Rect = {
      top: Math.max(0, Math.min(99, r.top)),
      left: Math.max(0, Math.min(99, r.left)),
      width: Math.max(0.5, Math.min(100, r.width)),
      height: Math.max(0.5, Math.min(100, r.height)),
    };
    applyRect(btn, clamped);
    local[calKey(btn)] = clamped;
    saveLocalOverrides(local);
    setInfo(calKey(btn), clamped);
  };

  const select = (btn: HTMLButtonElement | null) => {
    if (selected) selected.classList.remove("selected");
    selected = btn;
    if (btn) {
      btn.classList.add("selected");
      setInfo(calKey(btn), getRect(btn));
    } else {
      setInfo(null, null);
    }
  };

  // Click to select — iterates every key button in the keypad, including
  // secondary hit areas for non-rectangular keys (ENTER).
  for (const btn of keypadEl.querySelectorAll<HTMLButtonElement>("button.key")) {
    btn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      select(btn);
      startDrag(btn, e as MouseEvent, handleFromPoint(btn, e as MouseEvent));
    });
  }

  // Click empty area deselects.
  deviceEl.addEventListener("mousedown", (e) => {
    if ((e.target as HTMLElement).classList.contains("key")) return;
    select(null);
  });

  function handleFromPoint(btn: HTMLButtonElement, e: MouseEvent): Handle {
    const r = btn.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const hEdge = 8; // px — edge grab zone
    const onL = x < hEdge, onR = x > r.width - hEdge;
    const onT = y < hEdge, onB = y > r.height - hEdge;
    if (onT && onL) return "nw";
    if (onT && onR) return "ne";
    if (onB && onL) return "sw";
    if (onB && onR) return "se";
    if (onT) return "n";
    if (onB) return "s";
    if (onL) return "w";
    if (onR) return "e";
    return "move";
  }

  function startDrag(btn: HTMLButtonElement, startEv: MouseEvent, handle: Handle): void {
    const dev = deviceEl.getBoundingClientRect();
    const start = getRect(btn);
    const startX = startEv.clientX;
    const startY = startEv.clientY;

    const onMove = (ev: MouseEvent) => {
      const dxPct = ((ev.clientX - startX) / dev.width) * 100;
      const dyPct = ((ev.clientY - startY) / dev.height) * 100;
      const r: Rect = { ...start };
      if (handle === "move") {
        r.left = start.left + dxPct;
        r.top = start.top + dyPct;
      } else {
        if (handle.includes("n")) { r.top = start.top + dyPct; r.height = start.height - dyPct; }
        if (handle.includes("s")) { r.height = start.height + dyPct; }
        if (handle.includes("w")) { r.left = start.left + dxPct; r.width = start.width - dxPct; }
        if (handle.includes("e")) { r.width = start.width + dxPct; }
      }
      setRect(btn, r);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  // Keyboard: arrow nudge, C copy, R reset, Esc deselect.
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { select(null); return; }
    if (e.key.toLowerCase() === "c") {
      const payload = JSON.stringify(local, null, 2);
      navigator.clipboard.writeText(payload).then(
        () => { info.textContent = `copied ${Object.keys(local).length} overrides to clipboard`; },
        () => { info.textContent = "copy failed — see console"; console.log(payload); },
      );
      return;
    }
    if (e.key.toLowerCase() === "r") {
      if (confirm("Reset all hotspot overrides?")) {
        localStorage.removeItem(STORAGE_KEY);
        location.reload();
      }
      return;
    }
    if (!selected) return;
    const step = e.shiftKey ? 1.0 : 0.1;
    const r = getRect(selected);
    if (e.key === "ArrowUp")    { r.top  -= step; e.preventDefault(); }
    else if (e.key === "ArrowDown")  { r.top  += step; e.preventDefault(); }
    else if (e.key === "ArrowLeft")  { r.left -= step; e.preventDefault(); }
    else if (e.key === "ArrowRight") { r.left += step; e.preventDefault(); }
    else return;
    setRect(selected, r);
  });
}
