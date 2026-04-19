// Pure projection from Machine.State to a 2×40 LCD screen. All user-visible
// text routes through STRINGS.ts (the faithfulness registry). Any string
// that appears on the LCD and is not sourced here is a regression.

import type { Compartment } from "../state/KeyCompartment.js";
import { KeyCompartmentStore, formatSlotLine } from "../state/KeyCompartment.js";
import type { DualBuffer } from "../editor/DualBuffer.js";
import type { Clock } from "../state/Clock.js";
import { formatClockLines } from "../state/Clock.js";
import {
  MAIN_MENU_ITEMS,
  PHONETIC_DIGIT,
  PHONETIC_LETTER,
  STRINGS,
  type LcdScreen,
} from "../ui/STRINGS.js";
import { BAUD_RATES, tokenizeForVerbal, type State } from "./Machine.js";

const LCD_COLS = 40;

/**
 * Compose a two-column LCD line: `left` flushed left, `right` flushed right,
 * spaces filling the gap to hit `width` exactly. If the combined length
 * already exceeds `width`, the result is truncated from the right — callers
 * should size their inputs so that doesn't happen.
 */
function padTwoCol(left: string, right: string, width = LCD_COLS): string {
  if (right === "") return left.padEnd(width).slice(0, width);
  const gap = Math.max(1, width - left.length - right.length);
  return (left + " ".repeat(gap) + right).slice(0, width);
}

/**
 * Compact slot descriptor for the Key Select grid: "NN-NAME-UU" with no
 * spaces around the hyphens so two columns + the indicator column fit in 40
 * chars. Manual p.5/8 depicts "NN - NAME-UU" but that's manual typesetting —
 * a 2-row × 2-col grid + "^ or v" indicator only fits at 16 chars/slot.
 */
/**
 * Render a cipher/word token as its phonetic spelling, using MANUAL Appendix C
 * (p.55). Unknown characters pass through verbatim so operators can still
 * distinguish punctuation if it ever appears.
 */
function spellPhonetic(token: string): string {
  const parts: string[] = [];
  for (const raw of token) {
    const ch = raw.toUpperCase();
    if (PHONETIC_LETTER[ch]) parts.push(PHONETIC_LETTER[ch]!);
    else if (PHONETIC_DIGIT[ch]) parts.push(PHONETIC_DIGIT[ch]!);
    else parts.push(ch);
  }
  return parts.join(" ");
}

function formatCompactSlot(id: number, c: Compartment | null): string {
  const nn = id.toString().padStart(2, "0");
  if (!c) return `${nn}-AVAILABLE-00`;
  const uu = c.updateLevel.toString().padStart(2, "0");
  return `${nn}-${c.name}-${uu}`;
}

/**
 * Compose a two-column screen: `base` on the left, `indicator` flushed right.
 * Used for the many selector screens that share the same pattern — message
 * selector ("Select / Message to Use"), comms selectors ("Select / Function"),
 * quiet mode, main menu, etc.
 */
function twoColScreen(base: LcdScreen, indicator: LcdScreen): LcdScreen {
  const b1 = base[0] ?? "";
  const b2 = base.length === 2 ? base[1]! : "";
  const i1 = indicator[0] ?? "";
  const i2 = indicator.length === 2 ? indicator[1]! : "";
  return [padTwoCol(b1, i1), padTwoCol(b2, i2)];
}

/** MANUAL p.27: "19.2K" replaces "19200"; others render verbatim. */
function baudLabel(rate: number): string {
  return rate === 19200 ? "19.2K" : String(rate);
}

/** MANUAL p.29/37: "{RATE} Baud   ^ or v to Select Speed / Press ENTER at Desired Speed". */
function baudSelectScreen(baudIndex: number): LcdScreen {
  const rate = BAUD_RATES[baudIndex] ?? BAUD_RATES[0]!;
  const [line1, line2] = STRINGS.comms_baud_prompt.screen;
  return [line1!.replace("{RATE}", baudLabel(rate)), line2!];
}

/** MANUAL p.11: A/B message selector with "Select / Message to Use" indicator. */
function messageSelectorScreen(): LcdScreen {
  return twoColScreen(
    STRINGS.wp_message_selector.screen,
    STRINGS.wp_message_selector_indicator.screen,
  );
}

/**
 * Format the "{NN}-{NAME}-{UU}" line used by the Encrypt/Decrypt/Update/Auth
 * confirm screens. Missing-key case returns an empty header; callers that
 * reach these states without a selected key have already been routed away.
 */
function formatKeyHeader(c: Compartment | null): string {
  if (!c) return "";
  const id = c.id.toString().padStart(2, "0");
  const uu = c.updateLevel.toString().padStart(2, "0");
  return `${id}-${c.name}-${uu}`;
}

export function renderScreen(
  state: State,
  store: KeyCompartmentStore,
  silent: boolean,
  buffers?: DualBuffer,
  clock?: Clock,
): LcdScreen {
  switch (state.kind) {
    case "OFF":
      return [""]; // Blank LCD.

    case "BOOT_CONFIRM":
      return STRINGS.boot_confirm_on.screen;

    case "BOOT_ZRO_CONFIRM":
      return STRINGS.zero_confirm_all.screen;

    case "BANNER":
      return STRINGS.boot_trw_banner.screen;

    case "KEY_SELECT": {
      // MANUAL p.5/8: "Four positions are displayed at a time." 2×2 grid of
      // slots on the left, "^ or v" / "ID#" indicator column on the right.
      const slots = store.list();
      const top = state.topSlot;
      const pad = (n: number) => formatCompactSlot(n, slots[n - 1] ?? null).padEnd(16);
      const [ind1, ind2] = STRINGS.key_select_header_indicator.screen;
      const left1 = `${pad(top)} ${pad(top + 1)}`;
      const left2 = `${pad(top + 2)} ${pad(top + 3)}`;
      return [padTwoCol(left1, ind1), padTwoCol(left2, ind2 ?? "")];
    }

    case "MAIN_MENU": {
      // MANUAL p.9: left column shows two menu items; right column shows
      // "^ or v or" / "Select Function" scroll hint.
      const a = MAIN_MENU_ITEMS[state.topIndex]!;
      const b = MAIN_MENU_ITEMS[state.topIndex + 1];
      const [ind1, ind2] = STRINGS.main_menu_indicator.screen;
      const left1 = `${a.key} - ${a.label.toUpperCase()}`;
      const left2 = b ? `${b.key} - ${b.label.toUpperCase()}` : "";
      return [padTwoCol(left1, ind1), padTwoCol(left2, ind2 ?? "")];
    }

    case "POWER_OFF_CONFIRM":
      return STRINGS.power_off_confirm.screen;

    case "QUIET_MENU": {
      // "[On]" follows whichever mode is currently active. MANUAL p.40 shows
      // "Select" / "Function" in the right-column indicator.
      const silentMark = silent ? " [On]" : "";
      const normalMark = silent ? "" : " [On]";
      const base: LcdScreen = [`S - Silent Mode${silentMark}`, `N - Normal Mode${normalMark}`];
      return twoColScreen(base, STRINGS.quiet_menu_indicator.screen);
    }

    case "ZEROIZE_PROMPT":
      return STRINGS.zero_prompt.screen;

    case "ZEROIZE_CONFIRM_ONE": {
      const c: Compartment | null = store.peek(state.slot);
      const idStr = state.slot.toString().padStart(2, "0");
      const row1 = c
        ? `${idStr} - ${c.name} - ${c.updateLevel.toString().padStart(2, "0")}`
        : `${idStr} - AVAILABLE`;
      return [row1, "Is this the key to be zeroed? (Y/N)"];
    }

    case "ZEROIZE_CONFIRM_ALL":
      return STRINGS.zero_confirm_all.screen;

    case "ZEROING":
      return STRINGS.zeroing.screen;

    case "MALFUNCTION":
      return STRINGS.warn_malfunction.screen;

    case "STUB":
      return [`${state.letter} - ${state.label.toUpperCase()}`, "(not yet implemented)"];

    case "WP_SELECT_SLOT":
      return messageSelectorScreen();

    case "WP_CLEAR_CONFIRM":
      return STRINGS.wp_clear_prompt.screen;

    case "WP_EMPTY_NOTICE":
      return STRINGS.wp_empty.screen;

    case "WP_MODE_SELECT":
      return STRINGS.wp_mode_prompt.screen;

    case "WP_CLASSIFICATION":
      return [STRINGS.wp_classification_prompt.screen[0], state.text];

    case "WP_EDITOR": {
      if (!buffers) {
        // Without a buffer we can only show the mode banner. Real callers
        // always pass `buffers`; this branch exists so Screen is total.
        return state.mode === "CIPHER"
          ? STRINGS.wp_editor_cipher.screen
          : STRINGS.wp_editor_plain.screen;
      }
      // Render the two display lines nearest the cursor. TextBuffer.layout()
      // returns all lines; we pick a 2-line window around cursorRow.
      const buf = buffers.get(state.slot).buffer;
      const { lines, cursorRow, cursorCol } = buf.layout();
      const row1Idx = Math.max(0, cursorRow - (cursorRow >= lines.length - 1 ? 1 : 0));
      const row1 = (lines[row1Idx] ?? "").replace(/\n$/, "");
      const row2 = (lines[row1Idx + 1] ?? "").replace(/\n$/, "");
      // Overlay a "_" cursor in the cell at cursorCol on whichever of the two
      // visible rows holds the cursor. When the cursor sits past the last
      // char on a line, pad with spaces so the underscore lands in the right
      // column (mirrors real hardware underscore cursor).
      const overlay = (row: string): string => {
        const padded = row.length < cursorCol ? row.padEnd(cursorCol, " ") : row;
        return padded.slice(0, cursorCol) + "_" + padded.slice(cursorCol + 1);
      };
      const out1 = cursorRow === row1Idx ? overlay(row1) : row1;
      const out2 = cursorRow === row1Idx + 1 ? overlay(row2) : row2;
      return [out1, out2];
    }

    case "WP_SEARCH": {
      const prompt = STRINGS.wp_search_prompt.screen[0]!;
      const line1 = `${prompt} ${state.term}`;
      const line2 = state.notFound ? STRINGS.wp_search_not_found.screen[1]! : "";
      return [line1, line2];
    }

    case "WP_STORED":
      return [STRINGS.wp_stored.screen[0]!.replace("{AB}", state.slot)];

    // ───────── Encrypt flow ─────────
    case "E_SELECT_SLOT":
      return messageSelectorScreen();

    case "E_CONFIRM_KEY":
      return [
        formatKeyHeader(store.selected()),
        STRINGS.crypt_key_confirm.screen[1]!,
      ];

    case "E_BEGIN_CONFIRM":
      return STRINGS.begin_encryption.screen;

    case "E_BUSY":
      return STRINGS.encrypting.screen;

    // ───────── Decrypt flow ─────────
    case "D_SELECT_SLOT":
      return messageSelectorScreen();

    case "D_CONFIRM_KEY":
      return [
        formatKeyHeader(store.selected()),
        STRINGS.crypt_key_confirm.screen[1]!,
      ];

    case "D_BEGIN_CONFIRM":
      return STRINGS.begin_decryption.screen;

    case "D_BUSY":
      return STRINGS.decrypting.screen;

    case "D_FAIL":
      return STRINGS.warn_decrypt_failed.screen;

    // ───────── Update Key flow ─────────
    case "U_CONFIRM":
      return [
        formatKeyHeader(store.selected()),
        STRINGS.key_update_confirm.screen[1]!,
      ];

    case "U_CONFIRM2":
      return STRINGS.key_update_confirm2.screen;

    case "U_COMPLETE":
      return STRINGS.key_update_complete.screen;

    case "U_POST":
      return [
        formatKeyHeader(store.selected()),
        STRINGS.key_after_update.screen[1]!,
      ];

    case "U_MAX_REACHED":
      return STRINGS.key_update_limit.screen;

    // ───────── Authentication flow ─────────
    case "A_CONFIRM_KEY":
      return [
        formatKeyHeader(store.selected()),
        STRINGS.auth_key_confirm.screen[1]!,
      ];

    case "A_CHALLENGE_OR_REPLY":
      return STRINGS.auth_challenge_or_reply.screen;

    case "A_ENTER_CHALLENGE":
      return [STRINGS.auth_enter_challenge.screen[0]!, state.text];

    case "A_DISPLAY_CHALLENGE":
    case "A_DISPLAY_REPLY":
      return [
        STRINGS.auth_challenge_display.screen[0]!
          .replace("{CH4}", state.challenge)
          .replace("{RP4}", state.reply),
        STRINGS.auth_challenge_display.screen[1]!,
      ];

    // ───────── Clock view / edit (S menu) ─────────
    case "CLOCK_VIEW": {
      const now = clock ? clock.nowUtcMs() : Date.now();
      const [row1, row2] = formatClockLines(now);
      return [row1, row2];
    }

    case "CLOCK_EDIT": {
      const field = state.fields[state.fieldIdx] ?? "";
      const label = ["MONTH", "DATE", "YEAR", "HOUR", "MINUTE", "SECOND"][state.fieldIdx] ?? "";
      const row1 = STRINGS.clock_edit_prompt.screen[0]!.replace("{FIELD}", label);
      // Show the pending buf if any, otherwise the current field value.
      const row2 = state.buf.length > 0 ? state.buf : field;
      return [row1, row2];
    }

    // ───────── Key Change (K menu) ─────────
    case "K_PROMPT_ID":
      return [
        STRINGS.key_enter_id_prompt.screen[0]!,
        `${STRINGS.key_enter_id_prompt.screen[1]!} ${state.buf}`,
      ];

    case "K_PROMPT_NAME":
      return [
        STRINGS.key_enter_name_prompt.screen[0]!
          .replace("{NN}", state.slotId.toString().padStart(2, "0")),
        state.name.length > 0 ? state.name : STRINGS.key_enter_name_prompt.screen[1]!,
      ];

    case "K_ENTER_SET": {
      const setNum = (state.setIdx + 1).toString();
      const row1 = STRINGS.key_enter_set_prompt.screen[0]!.replace("{N}", setNum);
      const thisSet = state.letters.slice(state.setIdx * 8);
      return [row1, thisSet];
    }

    case "K_INVALID":
      return STRINGS.key_invalid.screen;

    case "K_CONFIRM": {
      const c = store.peek(state.slotId);
      return [formatKeyHeader(c), STRINGS.key_is_selected.screen[1]!];
    }

    // ───────── Review Message (R menu) ─────────
    case "R_SELECT_SLOT":
      return messageSelectorScreen();

    case "R_VIEWER": {
      if (!buffers) return [""];
      if (state.phonetic) {
        // MANUAL Appendix C / SPEC_DELTA §1.1: verbal-fallback readout. Show
        // the current cipher/word group on the top row with position counter,
        // and its phonetic spelling on the bottom row.
        const tokens = tokenizeForVerbal(buffers.get(state.slot).buffer.toString());
        if (tokens.length === 0) {
          return [STRINGS.verbal_empty.screen[0] ?? "", ""];
        }
        const idx = Math.min(state.tokenIndex, tokens.length - 1);
        const token = tokens[idx] ?? "";
        const header = padTwoCol(`${idx + 1}/${tokens.length}`, token);
        const phon = spellPhonetic(token);
        return [header, phon.slice(0, LCD_COLS)];
      }
      const { lines } = buffers.get(state.slot).buffer.layout();
      const row1 = (lines[state.topRow] ?? "").replace(/\n$/, "");
      const row2 = (lines[state.topRow + 1] ?? "").replace(/\n$/, "");
      return [row1, row2];
    }

    // ───────── View Angle (V menu) ─────────
    case "V_ADJUST":
      return [
        STRINGS.view_angle_adjust.screen[0]!.replace("{LEVEL}", state.level.toString()),
        STRINGS.view_angle_adjust.screen[1]!,
      ];

    // ───────── Print (P menu) ─────────
    case "P_SELECT_SLOT":
      return messageSelectorScreen();

    case "P_WARN_PLAIN":
      return STRINGS.print_plain_warning.screen;

    case "P_MENU":
      return STRINGS.print_menu.screen;

    case "P_BUSY":
      return STRINGS.printing.screen;

    // ───────── Communications (C menu) ─────────
    case "C_MODE_SELECT":
      return twoColScreen(
        STRINGS.comms_audio_or_digital.screen,
        STRINGS.comms_select_function_indicator.screen,
      );

    case "C_DIR_SELECT":
      return twoColScreen(
        STRINGS.comms_xmit_or_recv.screen,
        STRINGS.comms_select_function_indicator.screen,
      );

    case "C_AUDIO_SUBMODE":
      return twoColScreen(
        STRINGS.comms_acoustic_or_connector.screen,
        STRINGS.comms_select_function_indicator.screen,
      );

    case "C_ACOUSTIC_LINES":
      return twoColScreen(
        STRINGS.comms_us_or_euro_lines.screen,
        STRINGS.comms_select_function_indicator.screen,
      );

    case "C_AUDIO_DENIED":
      return STRINGS.warn_quiet_audio.screen;

    case "C_TX_SLOT_SELECT":
      return messageSelectorScreen();

    case "C_TX_BAUD_SELECT":
    case "C_RX_BAUD_SELECT":
      return baudSelectScreen(state.baudIndex);

    case "C_TX_PLEASE_WAIT":
      return STRINGS.comms_please_wait.screen;

    case "C_TX_READY":
      return STRINGS.comms_ready_prompt.screen;

    case "C_TX_BUSY":
      return STRINGS.comms_transmitting.screen;

    case "C_TX_COMPLETE":
      return STRINGS.comms_tx_complete.screen;

    case "C_RX_WAIT":
      // Once the host signals carrier lock / first byte we flip to the
      // "Receiving Message" screen while bytes are still streaming in, so
      // the operator sees the same "Receiving" screen the real device
      // showed during the actual receive (MANUAL p.32) — not just for the
      // post-carrier dwell.
      if (state.active) return STRINGS.comms_receiving.screen;
      return state.mode === "AUDIO"
        ? STRINGS.comms_waiting_carrier.screen
        : STRINGS.comms_waiting_data.screen;

    case "C_RX_BUSY":
      return STRINGS.comms_receiving.screen;

    case "C_RX_COMPLETE":
      return STRINGS.comms_rx_complete.screen;
  }
}
