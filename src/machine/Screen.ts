// Pure projection from Machine.State to a 2×40 LCD screen. All user-visible
// text routes through STRINGS.ts (the faithfulness registry). Any string
// that appears on the LCD and is not sourced here is a regression.

import type { Compartment } from "../state/KeyCompartment.js";
import { KeyCompartmentStore, formatSlotLine } from "../state/KeyCompartment.js";
import type { DualBuffer } from "../editor/DualBuffer.js";
import type { Clock } from "../state/Clock.js";
import { formatClockLines } from "../state/Clock.js";
import { MAIN_MENU_ITEMS, STRINGS, type LcdScreen } from "../ui/STRINGS.js";
import type { State } from "./Machine.js";

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

const LCD_COLS = 40;

/**
 * Compose a 2x40 screen from a base (left column, left-aligned) and an
 * indicator (right column, right-aligned). Both rows are padded to exactly
 * LCD_COLS characters. If a row's left+right content overflows 40 chars it
 * is truncated on the right; callers should avoid that case.
 */
function twoColScreen(base: LcdScreen, indicator: LcdScreen): LcdScreen {
  const pad = (left: string, right: string): string => {
    if (left.length + right.length >= LCD_COLS) {
      return (left + right).slice(0, LCD_COLS);
    }
    return left + " ".repeat(LCD_COLS - left.length - right.length) + right;
  };
  const baseRow2 = base.length === 2 ? base[1]! : "";
  const indRow2 = indicator.length === 2 ? indicator[1]! : "";
  return [pad(base[0]!, indicator[0]!), pad(baseRow2, indRow2)];
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
      const slots = store.list();
      const top = state.topSlot;
      const bottom = top + 1;
      const row1 = formatSlotLine(top, slots[top - 1] ?? null);
      const row2 = bottom <= 16 ? formatSlotLine(bottom, slots[bottom - 1] ?? null) : "";
      return [row1, row2];
    }

    case "MAIN_MENU": {
      const a = MAIN_MENU_ITEMS[state.topIndex]!;
      const b = MAIN_MENU_ITEMS[state.topIndex + 1];
      const row1 = `${a.key} - ${a.label.toUpperCase()}`;
      const row2 = b ? `${b.key} - ${b.label.toUpperCase()}` : "";
      return [row1, row2];
    }

    case "POWER_OFF_CONFIRM":
      return STRINGS.power_off_confirm.screen;

    case "QUIET_MENU": {
      // "[On]" follows whichever mode is currently active.
      const silentMark = silent ? " [On]" : "";
      const normalMark = silent ? "" : " [On]";
      return [`S - Silent Mode${silentMark}`, `N - Normal Mode${normalMark}`];
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
      return STRINGS.wp_message_selector.screen;

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
      const { lines, cursorRow } = buf.layout();
      const row1Idx = Math.max(0, cursorRow - (cursorRow >= lines.length - 1 ? 1 : 0));
      const row1 = lines[row1Idx] ?? "";
      const row2 = lines[row1Idx + 1] ?? "";
      return [row1.replace(/\n$/, ""), row2.replace(/\n$/, "")];
    }

    case "WP_STORED":
      return [STRINGS.wp_stored.screen[0]!.replace("{AB}", state.slot)];

    // ───────── Encrypt flow ─────────
    case "E_SELECT_SLOT":
      return STRINGS.wp_message_selector.screen;

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
      return STRINGS.wp_message_selector.screen;

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
      return STRINGS.wp_message_selector.screen;

    case "R_VIEWER": {
      if (!buffers) return [""];
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
      return STRINGS.wp_message_selector.screen;

    case "P_WARN_PLAIN":
      return STRINGS.print_plain_warning.screen;

    case "P_MENU":
      return STRINGS.print_menu.screen;

    case "P_BUSY":
      return STRINGS.printing.screen;

    // ───────── Communications (C menu) ─────────
    case "C_MODE_SELECT":
      return STRINGS.comms_audio_or_digital.screen;

    case "C_DIR_SELECT":
      return STRINGS.comms_xmit_or_recv.screen;

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

    case "C_TX_SLOT_SELECT":
      return STRINGS.wp_message_selector.screen;

    case "C_TX_READY":
      return STRINGS.comms_ready_prompt.screen;

    case "C_TX_BUSY":
      return STRINGS.comms_transmitting.screen;

    case "C_TX_COMPLETE":
      return STRINGS.comms_tx_complete.screen;

    case "C_RX_WAIT":
      return state.mode === "AUDIO"
        ? STRINGS.comms_waiting_carrier.screen
        : STRINGS.comms_waiting_data.screen;

    case "C_RX_BUSY":
      return STRINGS.comms_receiving.screen;

    case "C_RX_COMPLETE":
      return STRINGS.comms_rx_complete.screen;
  }
}
