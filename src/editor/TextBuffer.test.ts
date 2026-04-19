import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  BufferFullError,
  LINE_WIDTH,
  MAX_BUFFER_CHARS,
  TextBuffer,
} from "./TextBuffer.js";

describe("insertChar", () => {
  it("appends at cursor and advances", () => {
    const b = new TextBuffer();
    b.insertChar("A");
    b.insertChar("B");
    expect(b.toString()).toBe("AB");
    expect(b.cursorPosition).toBe(2);
  });

  it("inserts at the cursor, not the end", () => {
    const b = new TextBuffer();
    b.insertString("AC");
    b.moveLeft();
    b.insertChar("B");
    expect(b.toString()).toBe("ABC");
    expect(b.cursorPosition).toBe(2);
  });

  it("throws when buffer is full", () => {
    const b = new TextBuffer();
    b.insertString("x".repeat(MAX_BUFFER_CHARS));
    expect(b.length).toBe(MAX_BUFFER_CHARS);
    expect(() => b.insertChar("y")).toThrow(BufferFullError);
  });

  it("rejects non-single-char input", () => {
    const b = new TextBuffer();
    expect(() => b.insertChar("")).toThrow(RangeError);
    expect(() => b.insertChar("AB")).toThrow(RangeError);
  });
});

describe("insertString returns actually-inserted count", () => {
  it("truncates at capacity", () => {
    const b = new TextBuffer();
    b.insertString("x".repeat(MAX_BUFFER_CHARS - 3));
    expect(b.insertString("abcdef")).toBe(3);
    expect(b.length).toBe(MAX_BUFFER_CHARS);
  });
});

describe("deleteCharLeft (DCH)", () => {
  it("deletes the char to the left", () => {
    const b = new TextBuffer();
    b.insertString("ABC");
    b.deleteCharLeft();
    expect(b.toString()).toBe("AB");
    expect(b.cursorPosition).toBe(2);
  });

  it("no-op at start of buffer", () => {
    const b = new TextBuffer();
    b.insertString("ABC");
    b.moveBot();
    b.deleteCharLeft();
    expect(b.toString()).toBe("ABC");
  });
});

describe("deleteWordRight (DWD)", () => {
  it("deletes up to and including the word + trailing spaces", () => {
    const b = new TextBuffer();
    b.insertString("hello world rest");
    b.moveBot();
    b.deleteWordRight();
    expect(b.toString()).toBe("world rest");
  });

  it("from mid-word deletes the remainder of the current word + trailing space", () => {
    const b = new TextBuffer();
    b.insertString("hello world");
    b.moveBot();
    b.moveRight();
    b.moveRight(); // after "he"
    b.deleteWordRight();
    expect(b.toString()).toBe("heworld");
  });

  it("stops at a newline", () => {
    const b = new TextBuffer();
    b.insertString("hello\nworld");
    b.moveBot();
    b.deleteWordRight();
    expect(b.toString()).toBe("\nworld");
  });

  it("no-op at end of buffer", () => {
    const b = new TextBuffer();
    b.insertString("hi");
    b.deleteWordRight();
    expect(b.toString()).toBe("hi");
  });
});

describe("cursor motion", () => {
  it("LEFT and RIGHT clamp at ends", () => {
    const b = new TextBuffer();
    b.insertString("AB");
    b.moveRight();
    expect(b.cursorPosition).toBe(2);
    b.moveLeft();
    b.moveLeft();
    b.moveLeft();
    expect(b.cursorPosition).toBe(0);
  });

  it("BOT / EOT", () => {
    const b = new TextBuffer();
    b.insertString("HELLO");
    b.moveBot();
    expect(b.cursorPosition).toBe(0);
    b.moveEot();
    expect(b.cursorPosition).toBe(5);
  });

  it("BOL and EOL respect hard newlines", () => {
    const b = new TextBuffer();
    b.insertString("line1\nline2\nline3");
    // Place cursor mid-line2.
    b.moveBot();
    for (let i = 0; i < 8; i++) b.moveRight(); // after "line1\nli"
    expect(b.cursorPosition).toBe(8);
    b.moveBol();
    expect(b.cursorPosition).toBe(6); // start of "line2"
    b.moveEol();
    expect(b.cursorPosition).toBe(11); // end of "line2", before '\n'
  });
});

describe("layout (word-wrap)", () => {
  it("wraps at lineWidth without breaking lines earlier", () => {
    const b = new TextBuffer();
    b.insertString("A".repeat(LINE_WIDTH + 5));
    const { lines } = b.layout();
    expect(lines[0]!.length).toBe(LINE_WIDTH);
    expect(lines[1]!.length).toBe(5);
  });

  it("hard newlines start new lines", () => {
    const b = new TextBuffer();
    b.insertString("foo\nbar");
    const { lines } = b.layout();
    expect(lines).toEqual(["foo\n", "bar"]);
  });

  it("cursor row/col reflect the current position", () => {
    const b = new TextBuffer();
    b.insertString("A".repeat(LINE_WIDTH + 3));
    // Cursor at end (position LINE_WIDTH+3) should be row 1, col 3.
    const { cursorRow, cursorCol } = b.layout();
    expect(cursorRow).toBe(1);
    expect(cursorCol).toBe(3);
  });

  it("empty buffer reports one empty line, cursor at (0,0)", () => {
    const b = new TextBuffer();
    const { lines, cursorRow, cursorCol } = b.layout();
    expect(lines).toEqual([""]);
    expect(cursorRow).toBe(0);
    expect(cursorCol).toBe(0);
  });
});

describe("UP / DOWN preserve column", () => {
  it("DOWN then UP returns to the same row and col", () => {
    const b = new TextBuffer();
    b.insertString("A".repeat(10) + "\n" + "B".repeat(20));
    b.moveBot();
    for (let i = 0; i < 5; i++) b.moveRight();
    const startLayout = b.layout();
    b.moveDown();
    b.moveUp();
    const endLayout = b.layout();
    expect(endLayout.cursorRow).toBe(startLayout.cursorRow);
    expect(endLayout.cursorCol).toBe(startLayout.cursorCol);
  });
});

describe("search (SRCH)", () => {
  it("forward search moves cursor to end of match", () => {
    const b = new TextBuffer();
    b.insertString("hello world hello");
    b.moveBot();
    expect(b.search("world")).toBe(true);
    expect(b.cursorPosition).toBe("hello world".length);
  });

  it("wraps once to the start if not found after cursor", () => {
    const b = new TextBuffer();
    b.insertString("hello world");
    b.moveEot();
    expect(b.search("hello")).toBe(true);
    expect(b.cursorPosition).toBe(5);
  });

  it("returns false when the needle isn't present anywhere", () => {
    const b = new TextBuffer();
    b.insertString("hello");
    const before = b.cursorPosition;
    expect(b.search("xyz")).toBe(false);
    expect(b.cursorPosition).toBe(before);
  });

  it("rejects empty or over-20-char needles (MANUAL p.14)", () => {
    const b = new TextBuffer();
    expect(() => b.search("")).toThrow(RangeError);
    expect(() => b.search("a".repeat(21))).toThrow(RangeError);
    expect(() => b.search("a".repeat(20))).not.toThrow();
  });
});

describe("property: insertion + cursor invariants", () => {
  it("cursor stays in [0, length] through random ops", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.record({ op: fc.constant("ins"), ch: fc.constantFrom("A", "B", "C", " ") }),
            fc.record({ op: fc.constant("del"), ch: fc.constant("") }),
            fc.record({ op: fc.constant("left"), ch: fc.constant("") }),
            fc.record({ op: fc.constant("right"), ch: fc.constant("") }),
            fc.record({ op: fc.constant("bot"), ch: fc.constant("") }),
            fc.record({ op: fc.constant("eot"), ch: fc.constant("") }),
          ),
          { maxLength: 100 },
        ),
        (ops) => {
          const b = new TextBuffer();
          for (const { op, ch } of ops) {
            switch (op) {
              case "ins": b.insertChar(ch); break;
              case "del": b.deleteCharLeft(); break;
              case "left": b.moveLeft(); break;
              case "right": b.moveRight(); break;
              case "bot": b.moveBot(); break;
              case "eot": b.moveEot(); break;
            }
            expect(b.cursorPosition).toBeGreaterThanOrEqual(0);
            expect(b.cursorPosition).toBeLessThanOrEqual(b.length);
          }
        },
      ),
    );
  });
});
