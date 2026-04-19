// LCD rendering — paints the 2×40 screen produced by `renderScreen` onto a
// canvas as a grid of 5×7 dot-matrix cells, matching the HD44780-class LCD
// used by the KL-43C. Dot size is derived from the canvas's CSS width so the
// pixels stay crisp at any zoom level; `image-rendering: pixelated` (set in
// styles.css) preserves the square-pixel look when the browser scales.

import type { LcdScreen } from "../ui/STRINGS.js";
import { glyphFor, GLYPH_COLS, GLYPH_ROWS } from "./font5x7.js";

const COLS = 40;
const ROWS = 2;
const CELL_W = GLYPH_COLS + 1; // 1-dot gap between characters
const CELL_H = GLYPH_ROWS + 1; // 1-dot gap between rows
const LCD_DOTS_W = COLS * CELL_W - 1; // trim trailing gap
const LCD_DOTS_H = ROWS * CELL_H - 1;

const LIT = "#1c2213";

/** LCD view-angle level range — mirrors VIEW_ANGLE_MAX in Machine.ts. */
const VIEW_ANGLE_MAX = 7;

function padLine(s: string | undefined): string {
  const t = s ?? "";
  if (t.length >= COLS) return t.slice(0, COLS);
  return t + " ".repeat(COLS - t.length);
}

/**
 * Map view-angle level (0..VIEW_ANGLE_MAX) to an alpha on the lit pixels.
 * Low angle → faint text (as if viewing off-axis on a TN LCD); high angle →
 * crisp dark text. Floor at 0.25 so the LCD never becomes completely blank.
 */
function contrastFor(viewAngle: number): number {
  const clamped = Math.max(0, Math.min(VIEW_ANGLE_MAX, viewAngle));
  return 0.25 + 0.75 * (clamped / VIEW_ANGLE_MAX);
}

// Per-dot persistence model. Real CFAG2002A-class LCDs have a sluggish pixel
// response (tens to ~100 ms) — fresh pixels ramp up and extinguished ones
// linger as ghosting. We simulate that with a brightness grid that lerps
// toward the target each frame. Rise time is faster than fall (matches the
// physical asymmetry of twisted-nematic decay).
const RISE_MS = 30;   // time constant for 0 → 1
const FALL_MS = 120;  // time constant for 1 → 0
const SETTLE_EPS = 0.01;

let persistence: Float32Array | null = null;
let target: Float32Array | null = null;
let gridW = 0;
let gridH = 0;
let currentCanvas: HTMLCanvasElement | null = null;
let currentDot = 0;
let currentViewAngle = 4;
let rafHandle: number | null = null;
let lastFrameMs = 0;

function ensureGrids(w: number, h: number): void {
  const size = w * h;
  if (!persistence || persistence.length !== size) {
    persistence = new Float32Array(size);
    target = new Float32Array(size);
    gridW = w;
    gridH = h;
  }
}

function writeTargetFromScreen(screen: LcdScreen): void {
  if (!target) return;
  target.fill(0);
  const lines: [string, string] = [
    padLine(screen[0]),
    padLine(screen.length === 2 ? screen[1] : ""),
  ];
  for (let r = 0; r < ROWS; r++) {
    const line = lines[r]!;
    const rowOffset = r * CELL_H;
    for (let c = 0; c < COLS; c++) {
      const glyph = glyphFor(line[c]!);
      const colOffset = c * CELL_W;
      for (let gy = 0; gy < GLYPH_ROWS; gy++) {
        const bits = glyph[gy]!;
        if (bits === 0) continue;
        const y = rowOffset + gy;
        if (y >= gridH) continue;
        for (let gx = 0; gx < GLYPH_COLS; gx++) {
          if ((bits >> (GLYPH_COLS - 1 - gx)) & 1) {
            const x = colOffset + gx;
            if (x < gridW) target[y * gridW + x] = 1;
          }
        }
      }
    }
  }
}

function renderFrame(timestamp: number): void {
  rafHandle = null;
  if (!persistence || !target || !currentCanvas) return;
  const ctx = currentCanvas.getContext("2d");
  if (!ctx) return;

  const dt = lastFrameMs === 0 ? 16 : Math.min(100, timestamp - lastFrameMs);
  lastFrameMs = timestamp;

  let settled = true;
  for (let i = 0; i < persistence.length; i++) {
    const tgt = target[i]!;
    const cur = persistence[i]!;
    if (cur === tgt) continue;
    const tau = tgt > cur ? RISE_MS : FALL_MS;
    const k = 1 - Math.exp(-dt / tau);
    const next = cur + (tgt - cur) * k;
    persistence[i] = next;
    if (Math.abs(next - tgt) > SETTLE_EPS) settled = false;
  }
  // Snap near-settled pixels so the rAF loop can actually stop.
  if (settled) {
    for (let i = 0; i < persistence.length; i++) persistence[i] = target[i]!;
  }

  const dot = currentDot;
  const w = gridW * dot;
  const h = gridH * dot;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = LIT;
  const angleAlpha = contrastFor(currentViewAngle);

  for (let y = 0; y < gridH; y++) {
    for (let x = 0; x < gridW; x++) {
      const b = persistence[y * gridW + x]!;
      if (b <= SETTLE_EPS) continue;
      ctx.globalAlpha = angleAlpha * b;
      ctx.fillRect(x * dot, y * dot, dot, dot);
    }
  }
  ctx.globalAlpha = 1;

  if (!settled) scheduleFrame();
  else lastFrameMs = 0;
}

function scheduleFrame(): void {
  if (rafHandle !== null) return;
  rafHandle = requestAnimationFrame(renderFrame);
}

export function paintLcd(
  canvas: HTMLCanvasElement,
  screen: LcdScreen,
  viewAngle = 4,
): void {
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;

  const dpr = window.devicePixelRatio || 1;
  const dot = Math.max(1, Math.floor((rect.width * dpr) / LCD_DOTS_W));
  const w = LCD_DOTS_W * dot;
  const h = LCD_DOTS_H * dot;
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;

  ensureGrids(LCD_DOTS_W, LCD_DOTS_H);
  writeTargetFromScreen(screen);
  currentCanvas = canvas;
  currentDot = dot;
  currentViewAngle = viewAngle;
  scheduleFrame();
}
