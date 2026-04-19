# SPEC_DELTA — Corrections to SPEC.md

Every entry below is a place where `docs/SPEC.md` (v1.0) disagrees with the
primary source documents. The spec is preserved intact; this file is the errata.
When the two conflict, the manual wins.

**Sources**
- **MANUAL** — TRW KL-43C Operator's Manual, Part No. 410-308-1, Rev F, 1991-08-15
  (`reference/KL43C_manual_F_19910815.pdf`)
- **FEATURE** — TRW *Feature Comparison: KL-43 Family of Cryptographic Devices*
  (`reference/KL43_features.pdf`)
- **DUTCH** — KL Royal Army Instruction Card IK004164, 1994-05-02
  (`reference/KL43C_IK004164_19940502.pdf`)

---

## §1.1 Scope — additions

Spec does not mention these operational features that are in the manual:

- **First-time power-up ritual** — before the Key Select Menu appears, the device
  prompts the operator to enter a 10-digit number followed by 15 letters
  (MANUAL p.5, "Turning on the KL-43C", Note 1). Likely initial keying / unit serial;
  treat as implementation-defined setup gate in emulator.
- **Print function** — main-menu letter `P` prints to the TP-40S serial printer;
  emulator should render a mock "printed" scroll for atmosphere (MANUAL pp.45–46).
- **Verbal fallback** — the device doctrine includes phonetic readout over voice
  channels using military phonetic (TREE/FIFE/AIT/FOW-er/NIN-er for digits)
  (MANUAL Appendix C, p.55). Our "Manual" transmission mode must use these.

## §1.3 Substitutions — updates

Add to the SUBSTITUTE list:

- **Time-bound authentication.** AUTH requires the sending and receiving clocks
  to be within **20 minutes** of each other (MANUAL p.40, "Authentication").
  Our implementation must therefore fold the RTC into the HMAC input with a
  coarse time-bucket (10-min window so ±20 min sync tolerates one bucket on
  either side). Mark as `[SUBSTITUTE]`: the bucket-width is our choice,
  constrained only by the manual's tolerance figure.

## §3.1 Cryptographic terminology — additions

- Manual cites **NTISSI 4001** for CCI handling and **NACSI 4005** for keying
  doctrine; **NTISSI 3001A** is the operational doctrine for the Automanual
  System (AMS), which is where the "Update Key" function draws its rules from
  (MANUAL pp.2–3). Add these citations to the spec.

## §3.2 Message life cycle — corrections

- Manual confirms a **Dual Message Buffer** with explicit labels **Message A**
  and **Message B**, each holding up to 2600 chars. Received messages always
  land in a buffer the user selects; the buffer is explicitly named in prompts.
  Spec understates this as "2600 characters" without the dual-buffer semantics.
  (MANUAL p.10, "Dual Message Buffer".)
- **Manually-entered ciphertext cannot be transmitted.** The device prevents
  transmission of ciphertext that was typed in via the keyboard; the user must
  decrypt and re-encrypt before XMIT. Error: `CIPHER TEXT HAS BEEN LOCALLY
  ENTERED. COMMUNICATIONS DENIED.` (MANUAL pp.12, 22, 52).

## §4.1 Display — no change

2×40 LCD, confirmed by MANUAL Appendix F (p.67).

## §4.2 Boot sequence — **WRONG, replace entirely**

Spec text:
> On press of **SRCH** followed by confirmation **Y**: [banner displayed for
> 2.0 seconds, then self-test 1.0 second, then main menu].

**Correct sequence (MANUAL p.5):**

1. Operator presses **SRCH/ON**.
2. LCD displays: `Confirm--Turn power on? (Y/N)`
3. Operator must press **Y** within **15 seconds**, or the unit auto-powers-down.
   (No confirmation → no boot.)
4. Unit briefly displays the TRW copyright message. *Exact banner text is
   uncertain from the manual prose; the spec's banner wording is provisional
   and flagged UNCERTAIN in `STRINGS.ts`.*
5. Unit displays the **Key Select Menu** (top two compartments shown), OR:
   - (a) the **first-time setup prompt** — 10-digit number + 15 letters;
   - (b) **clock view** if the RTC lost time;
   - (c) `MALFUNCTION! DO NOT USE` on BIT failure.

There is no distinct "self-test" screen visible in the manual; BIT is
implicit, surfacing only on failure.

## §4.3 Keyboard — substantial revisions

### Total key count

Spec says **59**. MANUAL Appendix F (p.67) says "Standard 'QWERTY' plus **15
special function keys** with no shifted functions" — 26 alpha + 10 digit + 15
special = 51. Adding punctuation visible on the KL-43C (`, . / ?` + parens +
space) brings the count to 57–59 depending on how the space bar is counted
(one wide key or two?). Pending photographic trace; layout file
`KEYPAD_LAYOUT.json` holds the authoritative count.

### Key notation

Spec uses the Unicode wedges `∧ ∨`. **Manual uses parenthesised letters**
`(^)` and `(v)` for up/down and `(<)` `(>)` for left/right when naming keys
in prose; photograph key-caps use upward/downward arrows that look like
wedges. Treat the key-cap *glyph* as the rendered character (arrow), and
the key *name* in code as `UP` / `DOWN` / `LEFT` / `RIGHT`.

### Spec's row-5 layout is fabricated

Spec §4.3 offers:
> Row 5:  SRCH   SPACE (wide bar)   XIT  ZRO  CLK     ENTER

This is **not** what the photograph shows. In the Crypto Museum photo, these
keys are distributed at the ends of the letter rows (ZRO is far-left of the A
row; XIT is far-right; CLK is far-left of the Z row; SPC is far-right).
`SRCH` is at the far right of the top edit/navigation row. There is no
dedicated "row 5" on the KL-43C. Authoritative layout will be traced in
`KEYPAD_LAYOUT.json`.

### Per-key semantics updates

- `DCH` — "Deletes the character to the **left** of the cursor" (MANUAL p.13).
  Matches spec.
- `DWD` — "Deletes word to the **right** of the cursor" (MANUAL p.13).
  Matches spec.
- `SPC` — in editor mode, "Inserts a space to the **left** of the cursor"
  (MANUAL p.13). Spec did not specify; honour this.
- `SRCH` — dual role: at the Main Menu invokes word-processor string search
  prompt (`Search String:`); at power-off position, powers the unit on.

## §4.4 Menu structure — **wrong shape, replace**

Spec shows a tree where the leaves are action states. **Manual model is flatter:**
the Main Menu has **13 items** (MANUAL p.9 claims 14 but lists 13 — treat as typo),
each a single-letter shortcut that dives into its own prompt sequence.

Canonical menu letters (MANUAL p.9):

| Key | Function              |
|-----|-----------------------|
| W   | Word Processor        |
| Q   | Quiet Operation       |
| S   | Set Time and Date     |
| K   | Key Change            |
| U   | Update Key            |
| E   | Encrypt Message       |
| D   | Decrypt Message       |
| A   | Authentication        |
| P   | Print                 |
| C   | Communications        |
| R   | Review Message        |
| V   | View Angle Adjust     |
| O   | Turn Unit Off         |

**Missing from spec:** `S`, `P`, `V`, `O` and arguably `R` as a distinct state.
Communications (`C`) is a 4-level nested prompt (Audio/Digital → Acoustic/Connector
→ Transmit/Receive → U.S./Euro Lines when acoustic-transmit).

**Review mode restriction** (MANUAL p.21): during Review, only `^` and `v` are
functional; edit keys are disabled. Our state machine must enforce this.

## §4.5 Message editor — corrections

- `ENTER` in the editor creates a carriage return / new paragraph, not a line
  break (word-wrap handles line breaks automatically) (MANUAL p.13).
- **String search** via `SRCH`: prompt is `Search String:`, up to 20 chars,
  cursor moves to **end of match** on success (MANUAL p.14).
- **Classification field** (optional, ≤20 chars): appears before the editor
  opens in plain-text mode; its value becomes **part of the message**
  (MANUAL p.12). Spec missed this entirely.
- **Red/Black toggle in review:** spec describes a `∧`/`∨` combo to switch
  between Red and Black for the same slot. MANUAL does not document this.
  The dual-buffer model replaces it: Message A or Message B each holds one
  form. Remove the toggle from spec unless a photo or later firmware reveals
  it. (MANUAL p.21.)

## §4.6 Quiet mode — **semantic change**

Spec calls Quiet Mode "suppresses all key clicks and confirmation tones." This
is a severe understatement. MANUAL p.39 says Silent Mode:

1. Error: display only, no beep.
2. Low battery: display only, no audio alarm.
3. **DISALLOWS access to acoustic coupler modem routes entirely.**
4. RS-232, RS-423, and connector-audio communications are still permitted.

Implementation must block XMIT/RECV via the acoustic coupler when Silent Mode
is active and render `QUIET OPERATION: AUDIO OUTPUT DENIED.` (MANUAL p.53).
Mode persists across power cycles (MANUAL p.40).

Entry UI: `Q` from Main Menu → `S - Silent Mode / N - Normal Mode [On] /
Select Function`. The `[On]` bracket marks the current mode.

## §5.1 Encrypt — flow corrections

Actual flow (MANUAL p.17–18):

1. Press `E` from Main Menu.
2. Select message: `A - Message A / B - Message B`.
3. Device displays current key and prompts `Is this correct (Y/N)?`.
4. If `N`, branch to `(U) Update or (C) Change the Key?` (MANUAL p.41 reuses
   this pattern).
5. On confirm, `Begin Encryption ? (Y/N)` (note literal space before `?`).
6. During: display `Encrypting`. **Clock and power keys are disabled.**
7. On completion, return to Main Menu. Message is now cipher text.

## §5.2 Decrypt — flow corrections

Mirror of Encrypt with prompt `Begin Decryption? (Y/N)` (no space before `?`).
See `STRINGS.ts` for exact wording.

## §5.3.1 Load a key — corrections

- Name is up to **10 characters, alphanumeric** — not 8 A–Z as spec says
  (MANUAL p.7).
- Key-set prompt is `Enter Key Set 1` (no "OF 4") (MANUAL p.7).
- On checksum failure, display `Key is Invalid`, then return to
  `ID# NN / Enter the Key name` — user must re-enter name AND all 4 sets
  (MANUAL p.8).
- On success: `01 - TEST-00 / Is the selected key` then Main Menu (MANUAL p.8).

## §5.3.2 Update a key — corrections

Flow (MANUAL p.16–17):

1. `U` from Main Menu.
2. `01-TEST-00 / Is this the key to be updated (Y/N)?` (confirms currently-
   selected key).
3. `Are you sure you want to update (Y/N)?` (double-confirm; prevents
   accidental advance of the one-way chain).
4. `Key Update Complete` briefly.
5. `01-TEST-01 / Press ENTER or XIT` → Main Menu.

Spec's "1 → 2" update counter is correct in principle but the prompt sequence
was unspecified.

## §5.3.3 Zeroize — **wrong trigger, replace**

Spec says emergency zeroize is a **3-second hold of ZRO**. MANUAL p.43 says:

> All keys may also be cleared by **pressing (ZRO) immediately after the unit
> is turned on**. A confirmation prompt will then be displayed.

So the emergency path is triggered **at boot**, not by timed hold. It is
still confirmed by prompt (not instant), per MANUAL note — "The confirmation
prevents accidental zeroing of all encryption keys."

Regular zeroize flow (MANUAL p.43):

1. `ZRO` key.
2. `Which key is to be cleared? / Enter ID# or "A" for ALL`.
3. For one key: `NN - NAME - UU / Is this the key to be zeroed? (Y/N)`.
4. For all: `Do you want all keys cleared? (Y/N)`.
5. During: `Zeroing . . .` (three spaced dots).

**Auto-zeroize on malfunction** (MANUAL p.54, Appendix B): when the BIT
detects a software malfunction, the device displays `MALFUNCTION! DO NOT USE`
and **automatically zeroizes all keys**. Our emulator must do the same on any
self-detected invariant violation.

## §5.4 / §6.6 Authentication — time-bound

**New requirement (MANUAL p.40):**

> The internal clocks of each device are set to within twenty minutes of each
> other.

Therefore the authentication response function takes `(key, challenge, time)`,
not just `(key, challenge)`. Proposed substitute:

```
response = base32(first 20 bits of
                  HMAC-SHA-256(current_key,
                               challenge_bytes ||
                               utc_bucket_10_minutes))[:4]
```

A `±20` minute window corresponds to ±2 buckets; receiver retries ±1, ±2
buckets on mismatch. Mark as `[SUBSTITUTE]`; the real algorithm may use a
different window or a different primitive, but the 20-minute sync figure is
pinned from the manual.

Challenge alphabet: 4 letters A–Z (20 bits entropy).
Reply alphabet: 4 characters A–Z + 2–7 = **base32**, matching ciphertext
alphabet (20 bits).

## §5.5 Clock — additions

`CLK` jumps to clock view from any state **except** during: Receive, Transmit,
Encrypt, Decrypt, Authentication challenge/reply generation (MANUAL p.44).
Spec says "any state" — too permissive.

Setting UI: `S` from Main Menu → `DAY MONTH DATE YEAR / HH:MM:SS`. `<`/`>`
move between fields; `^`/`v` change values; `SS` not editable (auto-starts on
save); `XIT` to commit. (MANUAL p.44.)

## §6.7 Ciphertext output format — **WRONG, replace entirely**

Spec says:
> Ciphertext is DES-CBC output bytes, encoded as **A-Z only** using base-26
> (6 bits → ~1.29 letters; simplest: 5 output bytes → 8 letters). Letters are
> displayed and transmitted as **5-letter groups separated by single spaces**.

**Correct per MANUAL p.12:**

- Alphabet: **A–Z plus digits 2–7** = 32 symbols. This is **RFC 4648 base32**
  (case-insensitive, unambiguous with `O/0` and `I/1/L` because `0` and `1`
  are excluded).
- Group size: **3 characters** separated by single spaces.
- Editor auto-inserts the group spaces; user need not type them.
- Only `A-Z` and `2-7` are accepted in cipher-text mode; all other
  characters are silently ignored.

Example from the manual:
```
4AB NFC QWP H6F 4ER OL2 FCA 7HY 5R4 66T
ZD3 UJI 5D2 7J4 DFL NM3 SQ2 HRT 43G FHT
```

Byte alignment: 5 bytes → 8 base32 chars. End-of-message padding uses the
standard base32 `=` if needed (or we may simply truncate; spec
`ZZZZ` terminator is a SUBSTITUTE and can stay for operational compatibility).

## §7 Communications — additions & corrections

- **Comms menu is a 4-level prompt**, not a single action (MANUAL p.22–23):
  1. `A - Audio Data / D - Digital Data`
  2. (audio) `A - Acoustic Coupler / C - Connector Audio`
  3. `T - Transmit / R - Receive`
  4. (acoustic transmit) `U - U.S. Lines / E - European Lines`
- Device **remembers last setup** and prompts to reuse (MANUAL p.23).
- `stop bits = 2` (MANUAL p.36 + FEATURE p.8). MANUAL p.27 says "1" — treated
  as typo; 2 is authoritative.
- Baud-selection UI: `{RATE} Baud   ^ or v to Select Speed / Press ENTER at
  Desired Speed` (MANUAL p.29).
- Operator safety rule: **never press ENTER to transmit before the receiving
  operator acknowledges ready** (MANUAL p.24). Surface as a toast / hint in
  our UI.

## §8 Persistence — additions

Manual (p.3, p.47) confirms:
- Keys retained across power-off (lithium-backed in real device).
- RTC continues ticking across power-off.
- Silent/Audio mode persists.
- Message buffers are cleared on power-off.

Emulator IndexedDB model matches. Add: `last_comms_setup` to persisted state.

## §11 Error messages — **full catalog replacement**

Spec §11 table had 10 error rows, mostly marked `[SUBSTITUTE]`. Manual Appendix B
is the definitive catalog — **14 warnings**, all verbatim. See `STRINGS.ts`
entries `warn_*`. Notable replacements:

| Spec said                             | Manual says                                          |
|---------------------------------------|------------------------------------------------------|
| `RAM FAIL — SERVICE REQUIRED`         | `MALFUNCTION! DO NOT USE` (also auto-zeroizes keys)  |
| `BUFFER FULL (3 beeps)`               | No exact wording given; beep-count substantiated     |
| `DECRYPT FAIL — RETRANSMIT`           | `MESSAGE DOES NOT DECRYPT PROPERLY` (in-buffer)      |
|                                       | `THERE WERE UNCORRECTABLE / ERRORS PRESS EXIT` (comms) |
| `SYNC LOST`                           | `LOSS OF SYNCHRONIZATION. / COMMUNICATIONS ABORTED.` |
| `BAD HEADER — CHECK KEY/UPDATE`       | Not documented; revert to SUBSTITUTE                  |
| `NO KEY IN COMPT. NN`                 | Not documented in Appendix B; revert to SUBSTITUTE    |
| `UPDATE LIMIT — LOAD NEW TEK`         | Not documented; revert to SUBSTITUTE                  |
| `LOW BATTERY — REPLACE AA`            | `...BEEPING TONE WILL SOUND FOR FOUR MINUTES...`     |
|                                       | (actual visual accompanying the audio alarm)          |
| `ZEROIZE? Y/N`                        | `Do you want all keys cleared? (Y/N)`                 |

## Appendix F (new) — canonical operating specs

Values to pin in code (from MANUAL p.67):

```ts
export const KL43C_SPEC = {
  dimensions_mm: { w: 168.9, h: 41.9, d: 95.3 },
  weight_g: 926,
  battery: { aa_count: 4, alkaline_hours: 24, nicd_hours: 6, lithium_hours: 75 },
  current_draw_mA: { off: 0.090, on: 90, transmit: 190 },
  lcd: { rows: 2, cols: 40 },
  message_buffer_chars: 2600,
  message_buffers: 2,
  modem: { protocol: "Bell-103", baud: 300, duplex: "simplex" },
  serial: { data_bits: 8, stop_bits: 2, parity: "none",
            baud_rates: [50, 75, 150, 300, 600, 1200, 2400, 4800, 9600, 19200] },
  radio: { audio_out_mV_rms: 20, ptt: "dry relay" },
  first_time_prompt: { digits: 10, letters: 15 },
  auth_clock_tolerance_min: 20,
  boot_confirm_timeout_s: 15,
  low_battery_warning_min: 4,
} as const;
```

## Feature sheet contradictions

The TRW *Feature Comparison* sheet (in `reference/KL43_features.pdf`) disagrees with the
MANUAL in two small places. Manual wins in both:

1. **NiCd battery life.** Feature sheet: 8 hours. MANUAL p.67: 6 hours.
2. **Connector label.** Feature sheet p.7: "6 PIN AUDIO (U/329) CONNECTOR" —
   **typo**. Everywhere else (feature sheet p.2, MANUAL pp.ii, 49, Appendix A)
   says **U-229** (MIL-STD 6-pin audio). `U/329` is a scanning/OCR artefact.

---

*End of SPEC_DELTA.*
