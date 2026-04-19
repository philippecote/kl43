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

function padLine(s: string | undefined): string {
  const t = s ?? "";
  if (t.length >= COLS) return t.slice(0, COLS);
  return t + " ".repeat(COLS - t.length);
}

export function paintLcd(canvas: HTMLCanvasElement, screen: LcdScreen): void {
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;

  const dpr = window.devicePixelRatio || 1;
  const dot = Math.max(1, Math.floor((rect.width * dpr) / LCD_DOTS_W));
  const w = LCD_DOTS_W * dot;
  const h = LCD_DOTS_H * dot;
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = LIT;

  const lines: [string, string] = [
    padLine(screen[0]),
    padLine(screen.length === 2 ? screen[1] : ""),
  ];

  for (let r = 0; r < ROWS; r++) {
    const line = lines[r]!;
    const y0 = r * CELL_H * dot;
    for (let c = 0; c < COLS; c++) {
      const glyph = glyphFor(line[c]!);
      const x0 = c * CELL_W * dot;
      for (let gy = 0; gy < GLYPH_ROWS; gy++) {
        const bits = glyph[gy]!;
        if (bits === 0) continue;
        for (let gx = 0; gx < GLYPH_COLS; gx++) {
          if ((bits >> (GLYPH_COLS - 1 - gx)) & 1) {
            ctx.fillRect(x0 + gx * dot, y0 + gy * dot, dot, dot);
          }
        }
      }
    }
  }
}
