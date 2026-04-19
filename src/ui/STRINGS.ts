// Canonical registry of every user-visible string on the KL-43C.
//
// Every string is traced to a source:
//   - MANUAL: KL-43C Operator's Manual, Part No. 410-308-1, Revision F, 1991-08-15
//     (reference/KL43C_manual_F_19910815.pdf)
//   - FEATURE: TRW Feature Comparison: KL-43 Family of Cryptographic Devices
//     (reference/KL43_features.pdf)
//   - SUBSTITUTE: no published source; our best reconstruction
//   - UNCERTAIN: appears in manual but wording or punctuation is ambiguous
//
// Any LCD render that does not go through this registry is a faithfulness
// regression. A lint rule enforces that UI code may only import from here
// for user-visible text.
//
// Display layout: the real LCD is 2 rows × 40 columns monospaced. Multi-line
// strings are given as tuples `[row1, row2]`. Single-string entries are
// centered or left-aligned per the manual's depiction.

export type LcdLine = string;
export type LcdScreen = readonly [LcdLine] | readonly [LcdLine, LcdLine];

export interface Source {
  readonly doc: "MANUAL" | "FEATURE" | "SUBSTITUTE" | "UNCERTAIN";
  readonly page?: number;
  readonly section?: string;
  readonly note?: string;
}

export interface StringEntry {
  readonly id: string;
  readonly screen: LcdScreen;
  readonly source: Source;
}

const S = (doc: Source["doc"], page?: number, section?: string, note?: string): Source =>
  note !== undefined
    ? { doc, ...(page !== undefined ? { page } : {}), ...(section !== undefined ? { section } : {}), note }
    : { doc, ...(page !== undefined ? { page } : {}), ...(section !== undefined ? { section } : {}) };

const M = (page: number, section?: string): Source => S("MANUAL", page, section);

export const STRINGS = {
  // ───────────────────────────────────── Power on / off ─────────────────────────────────────
  boot_confirm_on: {
    id: "boot_confirm_on",
    screen: ["Confirm--Turn power on? (Y/N)"],
    source: M(5, "Turning on the KL-43C"),
  },
  boot_trw_banner: {
    id: "boot_trw_banner",
    screen: ["TRW EPI Inc. (C) 1984-92", "KL-43C software version 1.6.9"],
    source: S("UNCERTAIN", undefined, undefined, "Banner text inferred from spec §4.2 + firmware version from spec. Manual describes as 'briefly display the TRW copyright message' without verbatim wording. Revise if a photograph confirms exact text."),
  },
  power_off_confirm: {
    id: "power_off_confirm",
    screen: ["Confirm --Turn the Unit OFF (Y/N)"],
    source: M(47, "Power Off"),
  },

  // ───────────────────────────────────── Key Select Menu ─────────────────────────────────────
  key_select_header_indicator: {
    id: "key_select_header_indicator",
    screen: ["^ or v", "ID#"],
    source: M(5, "Key Select Menu (indicator column)"),
  },
  // Template for a Key Select row: "NN - NAME-UU" where NAME ≤ 10 chars, UU is update level 00-35.
  // Actual rendering is dynamic; format constant lives here to pin the format.
  key_select_row_format: {
    id: "key_select_row_format",
    screen: ["{NN} - {NAME}-{UU}"],
    source: M(6, "Key Select row format"),
  },
  key_select_available: {
    id: "key_select_available",
    screen: ["AVAILABLE"],
    source: M(6, "Placeholder name for unloaded compartments"),
  },

  // ───────────────────────────────────── Key loading ─────────────────────────────────────
  key_enter_id_prompt: {
    id: "key_enter_id_prompt",
    screen: ["Enter the ID# of the key", "to be changed (01-16):"],
    source: S("SUBSTITUTE", 7, undefined, "Manual p.7 describes Key Change as entered via 2-digit ID# but does not quote verbatim prompt wording. SUBSTITUTE — reconstructed from the prompt shape used elsewhere."),
  },
  key_enter_name_prompt: {
    id: "key_enter_name_prompt",
    screen: ["ID# {NN}", "Enter the Key name"],
    source: M(7, "Selecting a Key"),
  },
  key_name_display: {
    id: "key_name_display",
    screen: ["KEY NAME: {NAME}"],
    source: M(7, "Selecting a Key"),
  },
  key_enter_set_prompt: {
    id: "key_enter_set_prompt",
    screen: ["Enter Key Set {N}"],
    source: M(7, "Selecting a Key — N = 1..4"),
  },
  key_invalid: {
    id: "key_invalid",
    screen: ["Key is Invalid"],
    source: M(8, "Selecting a Key — checksum failure"),
  },
  key_is_selected: {
    id: "key_is_selected",
    screen: ["{NN} - {NAME}-{UU}", "Is the selected key"],
    source: M(8, "Selecting a Key — confirmation"),
  },
  key_is_selected_alt: {
    id: "key_is_selected_alt",
    screen: ["{NN}-{NAME}-{UU}", "is the selected key"],
    source: S("UNCERTAIN", 9, undefined, "Manual p.9 renders without spaces around hyphens and with lowercase 'is'. Same meaning as key_is_selected; flag as real-device inconsistency."),
  },

  // ───────────────────────────────────── Main Menu ─────────────────────────────────────
  // Manual p.9 claims "14 menu functions" but lists 13 items. Treated as typo in manual;
  // our implementation exposes the 13 listed items. If a 14th surfaces in photos or later
  // firmware, add here.
  main_menu_header: {
    id: "main_menu_header",
    screen: ["W - WORD PROCESSOR", "Q - QUIET OPERATION"],
    source: M(9, "Main Menu — first two items shown on entry"),
  },
  main_menu_indicator: {
    id: "main_menu_indicator",
    screen: ["^ or v or", "Select Function"],
    source: M(9, "Main Menu — indicator column"),
  },
  main_menu_items: {
    id: "main_menu_items",
    screen: ["Main Menu items, 13 total"],
    source: M(9, "See MAIN_MENU_ITEMS below"),
  },

  // ───────────────────────────────────── Word Processor ─────────────────────────────────────
  wp_message_selector: {
    id: "wp_message_selector",
    screen: ["A - Message A", "B - Message B"],
    source: M(11, "Creating a Message — dual buffer selector"),
  },
  wp_message_selector_indicator: {
    id: "wp_message_selector_indicator",
    screen: ["Select", "Message to Use"],
    source: M(11, "Creating a Message — indicator"),
  },
  wp_clear_prompt: {
    id: "wp_clear_prompt",
    screen: ["Do you wish to clear message", "from memory? (Y/N)"],
    source: M(11, "Creating a Message"),
  },
  wp_empty: {
    id: "wp_empty",
    screen: ["Message Space Is Empty:", "Starting New Message:"],
    source: M(11, "Creating a Message"),
  },
  wp_mode_prompt: {
    id: "wp_mode_prompt",
    // Manual p.11 prints "P - Plain Text Mode  C - Cipher Text Mode" with two
    // spaces between items, but that is 41 chars and the LCD is 40. One-space
    // separation is the only way to fit both items verbatim.
    screen: ["P - Plain Text Mode C - Cipher Text Mode", "       Select Editor Mode"],
    source: M(11, "Creating a Message"),
  },
  wp_classification_prompt: {
    id: "wp_classification_prompt",
    screen: ["Enter Classification:"],
    source: M(12, "Creating a Message — optional, ≤20 chars, becomes part of message"),
  },
  wp_editor_plain: {
    id: "wp_editor_plain",
    screen: ["The Editor is in the plain text mode"],
    source: M(13, "Creating a Message"),
  },
  wp_editor_cipher: {
    id: "wp_editor_cipher",
    screen: ["The Editor is in the cipher text mode"],
    source: S("UNCERTAIN", 12, undefined, "Wording inferred by symmetry with plain-text editor banner on p.13; manual confirms cipher mode exists but does not quote this specific line."),
  },
  wp_search_prompt: {
    id: "wp_search_prompt",
    screen: ["Search String:"],
    source: M(14, "String Search — up to 20 chars, cursor → end of match"),
  },
  wp_search_not_found: {
    id: "wp_search_not_found",
    screen: ["Search String:", "NOT FOUND"],
    source: S("SUBSTITUTE", 14, undefined, "Manual p.14 describes Search but does not quote the not-found indication. Wording reconstructed in the style of Appendix B warnings (all-caps, second line)."),
  },
  wp_stored: {
    id: "wp_stored",
    screen: ["Stored As Message {AB}"],
    source: M(14, "Storing a Created Message"),
  },

  // ───────────────────────────────────── Key management ─────────────────────────────────────
  key_update_confirm: {
    id: "key_update_confirm",
    screen: ["{NN}-{NAME}-{UU}", "Is this the key to be updated (Y/N)?"],
    source: M(16, "Updating a Key"),
  },
  key_update_confirm2: {
    id: "key_update_confirm2",
    screen: ["Are you sure you want to update (Y/N)?"],
    source: M(16, "Updating a Key — double confirmation"),
  },
  key_update_complete: {
    id: "key_update_complete",
    screen: ["Key Update Complete"],
    source: M(16, "Updating a Key"),
  },
  key_after_update: {
    id: "key_after_update",
    screen: ["{NN}-{NAME}-{UU}", "Press ENTER or XIT"],
    source: M(17, "Updating a Key"),
  },
  key_update_limit: {
    id: "key_update_limit",
    screen: ["KEY UPDATE LIMIT REACHED.", "PRESS A KEY TO CONTINUE."],
    source: S("SUBSTITUTE", 16, undefined, "Manual p.6 caps UU at 00-35 and p.16 describes the Update Key flow, but neither Chapter 2 nor Appendix B quotes the warning shown when the operator attempts to update an already-maxed key. Wording reconstructed in the style of Appendix B warnings (all-caps, two lines, 'PRESS A KEY TO CONTINUE')."),
  },

  // ───────────────────────────────────── Encrypt / Decrypt ─────────────────────────────────────
  crypt_key_confirm: {
    id: "crypt_key_confirm",
    screen: ["{NN}-{NAME}-{UU}", "Is this correct (Y/N)?"],
    source: M(17, "Encrypting a Message — key confirm"),
  },
  // Note the odd space before '?' on the Encrypt prompt; faithfully preserved.
  begin_encryption: {
    id: "begin_encryption",
    screen: ["Begin Encryption ? (Y/N)"],
    source: M(18, "Encrypting a Message — manual shows space before '?'"),
  },
  encrypting: {
    id: "encrypting",
    screen: ["Encrypting"],
    source: M(18, "Encrypting a Message"),
  },
  begin_decryption: {
    id: "begin_decryption",
    screen: ["Begin Decryption? (Y/N)"],
    source: M(20, "Decrypting a Message — no space before '?'"),
  },
  decrypting: {
    id: "decrypting",
    screen: ["Decrypting"],
    source: M(20, "Decrypting a Message"),
  },
  update_or_change_prompt: {
    id: "update_or_change_prompt",
    screen: ["(U) Update or (C) Change the Key?"],
    source: M(41, "Authentication — reused for encrypt/decrypt pre-op"),
  },

  // ───────────────────────────────────── Communications ─────────────────────────────────────
  comms_audio_or_digital: {
    id: "comms_audio_or_digital",
    screen: ["A - Audio Data", "D - Digital Data"],
    source: M(22, "Communications — first-level selector"),
  },
  comms_select_function_indicator: {
    id: "comms_select_function_indicator",
    screen: ["Select", "Function"],
    source: M(22, "Communications selectors — right-column indicator (p.22/23/36). Manual's Lines screen on p.23 prints 'Message to Use' but every other sub-selector uses 'Function'; treated as transcription error."),
  },
  comms_acoustic_or_connector: {
    id: "comms_acoustic_or_connector",
    screen: ["A - Acoustic Coupler", "C - Connector Audio"],
    source: M(23, "Communications — Audio sub-selector"),
  },
  comms_xmit_or_recv: {
    id: "comms_xmit_or_recv",
    screen: ["T - Transmit", "R - Receive"],
    source: M(23, "Communications — direction"),
  },
  comms_us_or_euro_lines: {
    id: "comms_us_or_euro_lines",
    screen: ["U - U.S. Lines", "E - European Lines"],
    source: M(23, "Communications — acoustic transmit level"),
  },
  comms_please_wait: {
    id: "comms_please_wait",
    screen: ["Please Wait"],
    source: M(24, "Transmitting a Message"),
  },
  comms_ready_prompt: {
    id: "comms_ready_prompt",
    screen: ["Press ENTER when ready.", "Press XIT for Main Menu."],
    source: M(24, "Transmitting a Message"),
  },
  comms_transmitting: {
    id: "comms_transmitting",
    screen: ["Transmitting Message"],
    source: M(24, "Transmitting a Message"),
  },
  comms_tx_complete: {
    id: "comms_tx_complete",
    screen: ["Transmission Complete. Press ENTER to", "Retransmit or XIT for Main Menu"],
    source: M(24, "Transmitting a Message"),
  },
  comms_waiting_carrier: {
    id: "comms_waiting_carrier",
    screen: ["Waiting for Carrier..."],
    source: M(32, "Receiving a Message — acoustic"),
  },
  comms_waiting_data: {
    id: "comms_waiting_data",
    screen: ["Waiting for Data..."],
    source: M(38, "Receiving a Message — digital"),
  },
  comms_receiving: {
    id: "comms_receiving",
    screen: ["Receiving Message"],
    source: M(32, "Receiving a Message"),
  },
  comms_rx_complete: {
    id: "comms_rx_complete",
    screen: ["Transmission Complete", "Press XIT to return to Main Menu"],
    source: M(32, "Receiving a Message"),
  },
  comms_memory_not_empty: {
    id: "comms_memory_not_empty",
    screen: ["Memory space for message is not empty.", "Do you wish to clear? (Y/N)"],
    source: M(31, "Receiving a Message"),
  },
  comms_select_to_clear: {
    id: "comms_select_to_clear",
    screen: ["Select Message to Clear: A or B"],
    source: M(31, "Receiving a Message"),
  },
  comms_baud_prompt: {
    id: "comms_baud_prompt",
    screen: ["{RATE} Baud   ^ or v to Select Speed", "Press ENTER at Desired Speed"],
    source: M(29, "Transmitting a Message: Digital data"),
  },

  // ───────────────────────────────────── Authentication ─────────────────────────────────────
  auth_key_confirm: {
    id: "auth_key_confirm",
    screen: ["{NN}-{NAME}-{UU}", "Is this the correct key (Y/N) ?"],
    source: M(41, "Authentication"),
  },
  auth_challenge_or_reply: {
    id: "auth_challenge_or_reply",
    screen: ["(C) Challenge or (R) Reply ?"],
    source: M(41, "Authentication"),
  },
  auth_enter_challenge: {
    id: "auth_enter_challenge",
    screen: ["Enter the Challenge:"],
    source: M(42, "Authentication — Reply flow"),
  },
  // Display format for challenger: shows 4-letter challenge (A-Z) and 4-char reply (A-Z + 2-7).
  auth_challenge_display: {
    id: "auth_challenge_display",
    screen: ["Challenge: {CH4}  Reply: {RP4}", "Press XIT to return to the Main Menu."],
    source: M(41, "Authentication — Challenge flow"),
  },

  // ───────────────────────────────────── Zeroize ─────────────────────────────────────
  zero_prompt: {
    id: "zero_prompt",
    screen: ["Which key is to be cleared?", 'Enter ID# or "A" for ALL'],
    source: M(43, "Zeroizing a Key"),
  },
  zero_confirm_one: {
    id: "zero_confirm_one",
    screen: ["{NN} - {NAME} - {UU}", "Is this the key to be zeroed? (Y/N)"],
    source: M(43, "Zeroizing a Key — spaces around hyphens differ from other places"),
  },
  zero_confirm_all: {
    id: "zero_confirm_all",
    screen: ["Do you want all keys cleared? (Y/N)"],
    source: M(43, "Zeroizing a Key"),
  },
  zeroing: {
    id: "zeroing",
    screen: ["Zeroing . . ."],
    source: M(44, "Zeroizing a Key — note spaces between dots"),
  },

  // ───────────────────────────────────── Quiet Operation ─────────────────────────────────────
  quiet_menu: {
    id: "quiet_menu",
    screen: ["S - Silent Mode", "N - Normal Mode [On]"],
    source: M(40, "Quiet Operation — [On] marks current mode"),
  },
  quiet_menu_indicator: {
    id: "quiet_menu_indicator",
    screen: ["Select", "Function"],
    source: M(40, "Quiet Operation"),
  },

  // ───────────────────────────────────── Clock / Time & Date ─────────────────────────────────────
  clock_header: {
    id: "clock_header",
    screen: ["DAY MONTH DATE YEAR", "HH:MM:SS"],
    source: M(44, "Setting the Time and Date"),
  },
  clock_edit_prompt: {
    id: "clock_edit_prompt",
    screen: ["Enter {FIELD}:", "{BUF}"],
    source: S("SUBSTITUTE", 44, undefined, "Manual p.44 describes ENTER cycling through date/time fields but does not quote the field prompt. SUBSTITUTE — FIELD ∈ {MONTH, DATE, YEAR, HOUR, MINUTE, SECOND}."),
  },

  // ───────────────────────────────────── View Angle ─────────────────────────────────────
  view_angle_adjust: {
    id: "view_angle_adjust",
    screen: ["LCD Viewing Angle: {LEVEL}", "^ or v to adjust, XIT when done"],
    source: S("SUBSTITUTE", 47, undefined, "Manual p.47 lists View Angle Adjust as a main-menu item but only photos would give verbatim wording. SUBSTITUTE — reconstructed."),
  },

  // ───────────────────────────────────── Printing ─────────────────────────────────────
  print_menu: {
    id: "print_menu",
    screen: ["P-Print L-Line Feed F-Form Feed", "Select Function"],
    source: M(45, "Printing a Message"),
  },
  print_plain_warning: {
    id: "print_plain_warning",
    screen: ["WARNING!!! PLAIN TEXT. Verify Printer", "ONLY connected. Press (Y) key to continue."],
    source: M(46, "Printing a Message"),
  },
  printing: {
    id: "printing",
    screen: ["Printing Message", "Press XIT to Stop"],
    source: M(46, "Printing a Message"),
  },

  // ───────────────────────────────────── Review — verbal readout ─────────────────────────────────────
  verbal_empty: {
    id: "verbal_empty",
    screen: ["Message is empty", ""],
    source: S(
      "SUBSTITUTE",
      undefined,
      undefined,
      "Manual Appendix C (p.55) documents the phonetic alphabet but gives no screen for the readout itself. The emulator surfaces it via SRCH inside Review — wording is a SUBSTITUTE.",
    ),
  },

  // ───────────────────────────────────── Appendix B warnings ─────────────────────────────────────
  warn_cipher_in_buffer: {
    id: "warn_cipher_in_buffer",
    screen: ["WARNING: CIPHER TEXT IN BUFFER!"],
    source: M(51, "Appendix B — encrypt on already-cipher"),
  },
  warn_plain_in_buffer: {
    id: "warn_plain_in_buffer",
    screen: ["WARNING: PLAIN TEXT IN BUFFER!"],
    source: M(51, "Appendix B — decrypt on already-plain"),
  },
  warn_decrypt_failed: {
    id: "warn_decrypt_failed",
    screen: ["MESSAGE DOES NOT DECRYPT PROPERLY"],
    source: M(51, "Appendix B — bad cipher entry"),
  },
  warn_message_empty: {
    id: "warn_message_empty",
    screen: ["MESSAGE SPACE (A or B) IS EMPTY"],
    source: M(51, "Appendix B"),
  },
  warn_memory_not_empty: {
    id: "warn_memory_not_empty",
    screen: ["MEMORY SPACE FOR MESSAGE IS NOT EMPTY", "DO YOU WISH TO CLEAR? (Y/N)"],
    source: M(52, "Appendix B"),
  },
  warn_comms_fail: {
    id: "warn_comms_fail",
    screen: ["FAILURE TO ESTABLISH COMMUNICATIONS.", "COMMUNICATIONS ABORTED."],
    source: M(52, "Appendix B"),
  },
  warn_local_cipher: {
    id: "warn_local_cipher",
    screen: ["CIPHER TEXT HAS BEEN LOCALLY ENTERED.", "COMMUNICATIONS DENIED."],
    source: M(52, "Appendix B — anti-replay"),
  },
  warn_sync_loss: {
    id: "warn_sync_loss",
    screen: ["LOSS OF SYNCHRONIZATION.", "COMMUNICATIONS ABORTED."],
    source: M(52, "Appendix B"),
  },
  warn_uncorrectable: {
    id: "warn_uncorrectable",
    // MANUAL p.53 Appendix B: displayed when the FEC decoder gives up on a
    // received codeword. "Probable Cause: There were line problems in
    // receiving the message. Operator Action: Transmitter must resend."
    screen: ["THERE WERE UNCORRECTABLE", "ERRORS PRESS EXIT."],
    source: M(53, "Appendix B — FEC unrecoverable"),
  },
  warn_plain_tx: {
    id: "warn_plain_tx",
    screen: ["MESSAGE IN PLAIN TEXT FORM", "COMMUNICATIONS DENIED."],
    source: M(53, "Appendix B"),
  },
  warn_print_plain: {
    id: "warn_print_plain",
    screen: ["WARNING !!! PLAIN TEXT. VERIFY PRINTER", "ONLY CONNECTED. PRESS A KEY TO CONTINUE."],
    source: M(53, "Appendix B — second variant, all-caps"),
  },
  warn_quiet_audio: {
    id: "warn_quiet_audio",
    screen: ["QUIET OPERATION: AUDIO OUTPUT DENIED."],
    source: M(53, "Appendix B"),
  },
  warn_low_battery: {
    id: "warn_low_battery",
    screen: ["...BEEPING TONE WILL SOUND FOR FOUR MINUTES...", "OR LOW BATTERY WARNING"],
    source: M(54, "Appendix B"),
  },
  warn_malfunction: {
    id: "warn_malfunction",
    screen: ["MALFUNCTION! DO NOT USE"],
    source: M(54, "Appendix B — auto-zeroizes all keys"),
  },
} as const satisfies Record<string, StringEntry>;

// Main menu items (§9 of manual): 13 items listed. Manual says "14 menu functions"
// but enumerates 13. Treated as transcription error in the manual unless a photograph
// or alternate source surfaces a 14th.
export const MAIN_MENU_ITEMS: ReadonlyArray<{ key: string; label: string }> = [
  { key: "W", label: "Word Processor" },
  { key: "Q", label: "Quiet Operation" },
  { key: "S", label: "Set Time and Date" },
  { key: "K", label: "Key Change" },
  { key: "U", label: "Update Key" },
  { key: "E", label: "Encrypt Message" },
  { key: "D", label: "Decrypt Message" },
  { key: "A", label: "Authentication" },
  { key: "P", label: "Print" },
  { key: "C", label: "Communications" },
  { key: "R", label: "Review Message" },
  { key: "V", label: "View Angle Adjust" },
  { key: "O", label: "Turn Unit Off" },
] as const;

// Military/ITU-R phonetic alphabet used for manual fallback transcription
// (Appendix C of manual). Digits differ from civilian forms (TREE/FIFE/AIT/
// FOW-er/NIN-er). The emulator's "Verbal" review screen must render these.
export const PHONETIC_LETTER: Readonly<Record<string, string>> = {
  A: "ALFA", B: "BRAVO", C: "CHARLIE", D: "DELTA", E: "ECHO",
  F: "FOXTROT", G: "GOLF", H: "HOTEL", I: "INDIA", J: "JULIETT",
  K: "KILO", L: "LIMA", M: "MIKE", N: "NOVEMBER", O: "OSCAR",
  P: "PAPA", Q: "QUEBEC", R: "ROMEO", S: "SIERRA", T: "TANGO",
  U: "UNIFORM", V: "VICTOR", W: "WHISKEY", X: "XRAY", Y: "YANKEE",
  Z: "ZULU",
} as const;

export const PHONETIC_DIGIT: Readonly<Record<string, string>> = {
  "0": "ZE-RO", "1": "WUN", "2": "TWO", "3": "TREE", "4": "FOW-er",
  "5": "FIFE", "6": "SIX", "7": "SEV-en", "8": "AIT", "9": "NIN-er",
} as const;
