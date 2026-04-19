// Mutable text buffer modelling one Message buffer on the KL-43C.
// Capacity: 2600 chars (MANUAL p.10). Insert/delete operations mirror the
// device's key semantics:
//
//   DCH  — delete character to the LEFT of the cursor      (MANUAL p.13)
//   DWD  — delete word to the RIGHT of the cursor          (MANUAL p.13)
//   SPC  — insert a space to the LEFT of the cursor (editor mode)
//   ENTER — insert a carriage return (new paragraph)       (MANUAL p.13)
//   BOT / EOT — jump to beginning / end of text
//   BOL / EOL — jump to beginning / end of the current display line
//   LEFT / RIGHT / UP / DOWN — cursor motion
//
// Word-wrap is visual: the editor reports "which display line is cursor
// on?" based on a column width (40 for the KL-43C LCD) but the buffer
// itself stores only the raw character stream. Hard newlines come from
// ENTER; soft wrap is recomputed as lines change.

export const MAX_BUFFER_CHARS = 2600;
export const LINE_WIDTH = 40;
export const NEWLINE = "\n";

export class BufferFullError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BufferFullError";
  }
}

export class TextBuffer {
  private chars: string[] = [];
  private cursor = 0;

  get length(): number {
    return this.chars.length;
  }

  get cursorPosition(): number {
    return this.cursor;
  }

  get remaining(): number {
    return MAX_BUFFER_CHARS - this.chars.length;
  }

  toString(): string {
    return this.chars.join("");
  }

  clear(): void {
    this.chars = [];
    this.cursor = 0;
  }

  /**
   * Insert a single character at the cursor and advance. Throws when the
   * buffer is full — matches the device's "BUFFER IS FULL" error path.
   */
  insertChar(ch: string): void {
    if (ch.length !== 1) throw new RangeError(`expected 1 char, got ${ch.length}`);
    if (this.chars.length >= MAX_BUFFER_CHARS) {
      throw new BufferFullError("BUFFER IS FULL");
    }
    this.chars.splice(this.cursor, 0, ch);
    this.cursor++;
  }

  /** Insert a whole string; stops at capacity. Returns count actually inserted. */
  insertString(text: string): number {
    let inserted = 0;
    for (const ch of text) {
      if (this.chars.length >= MAX_BUFFER_CHARS) break;
      this.chars.splice(this.cursor, 0, ch);
      this.cursor++;
      inserted++;
    }
    return inserted;
  }

  /** DCH — delete character to the LEFT of the cursor. */
  deleteCharLeft(): void {
    if (this.cursor === 0) return;
    this.chars.splice(this.cursor - 1, 1);
    this.cursor--;
  }

  /**
   * DWD — delete word to the RIGHT of the cursor.
   * Words are runs of non-whitespace; trailing whitespace on the deleted
   * word is also consumed so the next word sits where the deleted one was.
   */
  deleteWordRight(): void {
    if (this.cursor >= this.chars.length) return;
    let end = this.cursor;
    // Skip any leading whitespace first (if cursor sits on a space, DWD
    // removes up to and including the next word).
    while (end < this.chars.length && /\s/.test(this.chars[end]!)) end++;
    while (end < this.chars.length && !/\s/.test(this.chars[end]!)) end++;
    while (end < this.chars.length && /\s/.test(this.chars[end]!) && this.chars[end] !== NEWLINE)
      end++;
    this.chars.splice(this.cursor, end - this.cursor);
  }

  moveBot(): void {
    this.cursor = 0;
  }

  moveEot(): void {
    this.cursor = this.chars.length;
  }

  moveLeft(): void {
    if (this.cursor > 0) this.cursor--;
  }

  moveRight(): void {
    if (this.cursor < this.chars.length) this.cursor++;
  }

  /** BOL — move to the start of the current display line (after the last \n). */
  moveBol(): void {
    let i = this.cursor;
    while (i > 0 && this.chars[i - 1] !== NEWLINE) i--;
    this.cursor = i;
  }

  /** EOL — move to the end of the current display line (just before the next \n). */
  moveEol(): void {
    let i = this.cursor;
    while (i < this.chars.length && this.chars[i] !== NEWLINE) i++;
    this.cursor = i;
  }

  /**
   * UP / DOWN — move the cursor one visual line up or down, preserving
   * column where possible. `lineWidth` lets callers override the default
   * 40-col LCD width (e.g. in tests).
   */
  moveUp(lineWidth = LINE_WIDTH): void {
    this.moveLineRelative(-1, lineWidth);
  }

  moveDown(lineWidth = LINE_WIDTH): void {
    this.moveLineRelative(+1, lineWidth);
  }

  /**
   * Search forward from the cursor for the first occurrence of `needle`.
   * On success the cursor moves to the END of the match (MANUAL p.14).
   * Returns true on hit, false on miss (cursor unchanged on miss).
   * Case-sensitive and wraps from end-of-buffer back to start, one pass.
   */
  search(needle: string): boolean {
    if (needle.length === 0 || needle.length > 20) {
      throw new RangeError(`search string must be 1..20 chars, got ${needle.length}`);
    }
    const haystack = this.toString();
    const forward = haystack.indexOf(needle, this.cursor);
    if (forward >= 0) {
      this.cursor = forward + needle.length;
      return true;
    }
    const wrapped = haystack.indexOf(needle, 0);
    if (wrapped >= 0 && wrapped < this.cursor) {
      this.cursor = wrapped + needle.length;
      return true;
    }
    return false;
  }

  /**
   * Compute the visual line layout given a column width. Useful for
   * rendering and for UP/DOWN navigation. Each display line is at most
   * `lineWidth` cells; hard newlines start a new line; soft wrap breaks on
   * whitespace where possible, else mid-word.
   */
  layout(lineWidth = LINE_WIDTH): { lines: string[]; cursorRow: number; cursorCol: number } {
    if (lineWidth <= 0) throw new RangeError(`lineWidth must be positive`);
    const lines: string[] = [];
    const offsets: number[] = []; // buffer offset of each line's start
    let current = "";
    let lineStart = 0;
    const flush = () => {
      lines.push(current);
      offsets.push(lineStart);
      lineStart += current.length;
      current = "";
    };

    for (let i = 0; i < this.chars.length; i++) {
      const ch = this.chars[i]!;
      if (ch === NEWLINE) {
        // Consume the newline itself as part of the ending line for cursor
        // math, then flush.
        current += ch;
        flush();
        continue;
      }
      current += ch;
      if (current.length >= lineWidth) flush();
    }
    flush();

    let row = 0;
    let col = 0;
    for (let i = 0; i < offsets.length; i++) {
      const start = offsets[i]!;
      const end = start + lines[i]!.length;
      if (this.cursor < end || i === offsets.length - 1) {
        row = i;
        col = this.cursor - start;
        break;
      }
    }
    return { lines, cursorRow: row, cursorCol: col };
  }

  private moveLineRelative(delta: number, lineWidth: number): void {
    const { lines, cursorRow, cursorCol } = this.layout(lineWidth);
    const targetRow = cursorRow + delta;
    if (targetRow < 0 || targetRow >= lines.length) return;
    let offset = 0;
    for (let i = 0; i < targetRow; i++) offset += lines[i]!.length;
    const targetLine = lines[targetRow]!;
    // Preserve column, clamping to the target line's length excluding a
    // trailing newline character if present.
    const effectiveLen = targetLine.endsWith(NEWLINE) ? targetLine.length - 1 : targetLine.length;
    const clampedCol = Math.min(cursorCol, effectiveLen);
    this.cursor = offset + clampedCol;
  }
}
