# KL-43C Emulator — Technical Specification

**Document version:** 1.0
**Target device:** TSEC/KL-43C "AutoManual System" (TRW Electronic Products, Inc., ~1987–1992 firmware)
**Deliverable:** Faithful functional and visual emulator of the KL-43C portable secure text terminal
**Authenticity goal:** Operationally indistinguishable from the real unit for a user who has never seen source code. Period-accurate aesthetics, key legends, message flow, tones, and failure modes.

---

## 1. Scope

### 1.1 In scope

- Full UI reproduction: 2 × 40 character LCD, 59-key rubber-dome keypad, power-on self-test, menu system, message composition, encrypt/decrypt review, key management, authentication mode, clock, zeroize.
- Functional cryptography using a declassified-algorithm substitute that is structurally compatible with the real device's key format and operational model.
- Bell 103 FSK audio modem (300 baud simplex) for acoustic transmission between two emulator instances.
- Forward Error Correction on the ciphertext stream.
- Persistence of keys and messages (volatile; wiped on power-off, per the real device).
- Two-instance "call" mode so two copies of the emulator can exchange messages either over a direct WebRTC audio link or by physically playing tones into a phone handset.

### 1.2 Out of scope (and why)

- The actual classified NSA algorithm used in the production KL-43 (still classified as of April 2026).
- Interoperability with any real KL-43, KL-42, or XMP-500 hardware. (Possible in theory only if the real A→4-bit key mapping and full cipher are ever published.)
- TEMPEST emissions, radio (U-229) interface to real military radios, physical thermal printer (TP-40S).
- The older KL-43, KL-43A, KL-43D, KL-43E, KL-43G, KL-43H variants. (This spec targets the **KL-43C** specifically — the ruggedized 168 × 95 × 43 mm tactical model with built-in acoustic coupler, as it is the most iconic and the most thoroughly documented from surviving units.)

### 1.3 Substitutions and how they are labeled

Every place this spec substitutes a known-unknown with a reasonable approximation, it is marked **[SUBSTITUTE]**. These are the only places the emulator departs from the real device:

- Cipher algorithm (classified → DES-CBC)
- A–Z to 4-bit key character mapping (unknown → A=0..P=15 convention)
- Session IV / message indicator derivation (unknown → documented scheme in §6.4)
- FEC code parameters (unknown → Reed-Solomon RS(255,223) in §7.3)
- Key update KDF (unknown → HMAC-SHA-256 based, in §6.5)

All **[SUBSTITUTE]** items are implemented behind a single `crypto_backend` interface so they can be swapped without UI changes if new declassification data emerges.

---

## 2. Reference hardware

### 2.1 Physical characteristics (for visual fidelity)

| Property | Value |
|---|---|
| Enclosure | Die-cast aluminum, olive drab, watertight |
| Dimensions | 168 × 95 × 43 mm (W × H × D) |
| Weight (no batteries) | 814 g |
| Power | 4 × AA alkaline (24 h) or NiCd (8 h); emulator ignores |
| Buttons | 59 rubber-dome tactile keys |
| Display | 2 × 40 character LCD, monochrome, green/grey (STN) |
| Side connector | 6-pin U-229 (right side) — not emulated beyond cosmetic |
| Bottom | Acoustic coupler grille — visible speaker/microphone assembly |
| Battery door | Left side, hinged, sealed |

### 2.2 System architecture (for reference only)

| Component | Part | Notes |
|---|---|---|
| CPU | NSC800 | Military CMOS Z80 clone |
| UART | NSC858 | Drives RS-232 over U-229 |
| RTC | Ricoh RP5C15 | 32 kHz crystal, lithium-backed |
| RAM | Sony CXK58257 | 32 KB CMOS SRAM, lithium-backed |
| ROM | CCI "U-ATA" | Holds firmware (crypto + UI) |
| Modem | National MM74HC943 | 300 baud, Bell 103 compatible |
| Backup battery | 3.5 V lithium (Keeper LTC-7PN) | Retains RAM when off |

Emulator does not need to reproduce this architecture, but the boot banner and version numbers should match (see §4.2).

---

## 3. Operational model

### 3.1 Cryptographic terminology (NSA/COMSEC usage)

- **Red message**: plaintext (in the clear).
- **Black message**: ciphertext (encrypted).
- **TEK**: Traffic Encryption Key. Loaded by the operator into one of 16 compartments.
- **KEK**: Key Encryption Key. Not used in KL-43.
- **Update**: deterministic one-way transformation of a TEK into a daughter key, indexed 0..35. The real device supports 35 updates per TEK before a new TEK must be loaded.
- **Cryptoperiod**: the time window a TEK (or an updated TEK) is authorized for use. Operationally, 24 hours no-update, or 7 days with daily updates.
- **Zeroize**: emergency destruction of all stored key material.
- **Cryptonet**: the group of stations sharing a TEK.

### 3.2 Message life cycle

1. **Compose** a Red (plaintext) message using the keyboard. Up to 2600 characters.
2. Select a key compartment and **Encrypt**. The message is transformed into Black groups of characters.
3. **Transmit** Black, either by reading groups aloud (manual), playing Bell 103 tones into a handset (acoustic), or via RS-232/radio (not in scope).
4. Receiving station **enters** Black into its KL-43 (via keyboard, acoustic coupler, or serial).
5. Receiving station **decrypts** using the matching key + update level, yielding Red.

All messages are held in volatile RAM and **erased on power-down** per the real device.

---

## 4. User interface

### 4.1 Display

- Logical model: **2 rows × 40 columns**, monospaced, character-based.
- Character set: ASCII uppercase letters, digits, space, and the following punctuation/symbols: `, . / ? ( ) - < > ∧ ∨`. Lowercase letters not supported by the real device.
- Cursor: block cursor, blinking at 2 Hz when awaiting input.
- Contrast: view-angle control via `KEYBOARD MENU SELECTION` (no physical knob on KL-43C); emulator may expose a slider in options for authenticity only.
- Visual style: positive-mode STN LCD, dark characters on greenish-grey background; slight ghosting at state transitions is a nice-to-have.

### 4.2 Boot sequence

On press of **SRCH** followed by confirmation **Y**:

```
+----------------------------------------+
|          TRW EPI Inc. (C) 1984-92      |
|       KL-43C software version 1.6.9    |
+----------------------------------------+
```

Displayed for 2.0 seconds, then self-test (RAM check, key integrity, RTC check) for 1.0 second, then main menu. A subtle piezo click accompanies the power-on.

### 4.3 Keyboard — full key inventory

The keypad has **59 tactile rubber keys** (per Crypto Museum). The TRW feature sheet enumerates the key types; exact rows/columns are not published, so emulators should treat the visual arrangement below as a faithful approximation rather than pixel-perfect.

**Key inventory (full set, KL-43C):**

| Category | Count | Keys |
|---|---|---|
| Alphabet | 26 | `A`–`Z` |
| Digits | 10 | `0`–`9` |
| Punctuation | 6 | `,` `.` `/` `?` `(` `)`  *(parens are KL-43C/F-specific)* |
| Cursor / navigation | 8 | `∧` `∨` `<` `>` `BOT` `EOT` `BOL` `EOL` |
| Editing | 2 | `DCH` `DWD` |
| Control / menu | 6 | `SPC` `ENTER` `XIT` `SRCH` `ZRO` `CLK` |
| Reserved / mode | 1 | 1 additional key (likely TALK/DIRECT or silent-mode toggle; legend unconfirmed) |
| **Total** | **59** | |

**Visual arrangement (approximate — use as starting point, refine against photographs):**

```
Row 1:  Q  W  E  R  T  Y  U  I  O  P       BOT  ∧  EOT
Row 2:  A  S  D  F  G  H  J  K  L  ?       BOL  <  EOL
Row 3:  Z  X  C  V  B  N  M  ,  .  /       (    >  )
Row 4:  1  2  3  4  5  6  7  8  9  0       DCH  ∨  DWD
Row 5:  SRCH   SPACE (wide bar)   XIT  ZRO  CLK     ENTER
```

(The five rows above total 59 keys: 13 + 13 + 13 + 13 + 7.)

**Per-key semantics:**

| Legend | Meaning | Behavior |
|---|---|---|
| A–Z | Alphabet | Character entry |
| 0–9 | Digits | Character entry |
| `, . / ( )` | Punctuation | Character entry |
| `?` | Question mark | Character entry (also `Y/N` prompt response) |
| `SPC` / space bar | Space | Character entry |
| `BOT` | Beginning of text | Cursor to start of message buffer |
| `EOT` | End of text | Cursor to end of message buffer |
| `BOL` | Beginning of line | Cursor to column 1 of current row |
| `EOL` | End of line | Cursor to last non-space column of current row |
| `∧` `∨` `<` `>` | Up / down / left / right | Cursor movement (one cell) |
| `DCH` | Delete character | Delete character left of cursor |
| `DWD` | Delete word | Delete word to right of cursor |
| `SRCH` | Search / power-on | From powered-off, powers on. In compose, initiates a text search prompt. |
| `ZRO` | Zeroize | Confirmation prompt; 3-s hold is emergency zeroize without prompt |
| `XIT` | Exit | Back one level in menu hierarchy |
| `CLK` | Clock | Display / set real-time clock (jumps from any state) |
| `ENTER` | Confirm / commit | Accept current input |

Each key emits a short piezo click (~4 kHz, 10 ms) when pressed, unless **Quiet Mode** is enabled (KL-43C/F feature; see §4.6).

### 4.4 Menu structure (state machine)

States are shown in hierarchy form. `XIT` navigates up one level; `ENTER` descends or confirms.

```
ROOT
├── PLAIN (compose Red message)
│   └── [message editor — see §4.5]
├── CIPHER (compose/view Black message)
│   └── [message editor, ciphertext character set only]
├── ENCRYPT
│   ├── SELECT KEY (choose compartment 01–16)
│   ├── UPDATE LEVEL (00–35)
│   └── ENCRYPTING… → MESSAGE READY (go to CIPHER review)
├── DECRYPT
│   ├── SELECT KEY
│   ├── UPDATE LEVEL
│   └── DECRYPTING… → MESSAGE READY (go to PLAIN review)
├── KEY MGMT
│   ├── LOAD  (enter new key into a compartment)
│   ├── NAME  (set or change key name)
│   ├── UPDATE (advance key's update level, 0→1, 1→2, …)
│   ├── ZEROIZE (erase one key or all)
│   └── LIST  (show 4 compartments at a time, scrollable)
├── AUTH (authentication mode; see §5.4)
├── CLOCK (read/set RTC; CLK key jumps here directly)
├── XMIT (transmit Black via acoustic modem)
└── RECV (receive Black via acoustic modem)
```

### 4.5 Message editor

- Capacity: **2600 characters per buffer** (hard limit; entering 2601st character beeps and is ignored).
- Editor supports word wrap at column 40.
- Display shows a 2-row viewport onto the buffer; cursor movement scrolls the viewport.
- Red/Black toggle: in review mode, the user can press `∧`/`∨` combo (or a soft key) to switch between viewing Red and Black for the same slot. This is a documented real-device feature ("Message Review — Red or Black text displayed on KL-43").
- **Power-down behavior**: on power off (timeout or manual), the message buffer is cleared. Keys survive (lithium-backed in real device; emulator uses `localStorage` or equivalent — see §9.4 constraint).

### 4.6 Quiet mode

- Suppresses all key clicks and confirmation tones.
- Toggled from a hidden menu (real KL-43C: reached by a specific key sequence in key management).
- Emulator setting: checkbox in options.

---

## 5. Functional features

### 5.1 Encrypt

1. User selects **ENCRYPT** from the main menu.
2. Prompted to **SELECT KEY**; displays 4 compartments at a time:
   ```
   01-ALPHA     -03
   02-BRAVO     -00
   03-AVAILABLE -00
   04-TEST      -12
   ```
   Format: `NN-NAME-UU` where `NN` is compartment number, `NAME` is up to 8 uppercase letters (or `AVAILABLE` if empty), `UU` is current update level 00–35.
3. User moves cursor with `∧`/`∨`, presses `ENTER` to select.
4. Prompted to confirm update level (default: current level; editable).
5. Display shows `ENCRYPTING...` with a progress indicator for ~500 ms (proportional to message length).
6. On completion: `MESSAGE READY` and drops into Black review mode.

### 5.2 Decrypt

Mirror of Encrypt. The ciphertext must already be present in the Black buffer (typed in, received via modem, or received via serial).

### 5.3 Key management

#### 5.3.1 Load a key

1. `KEY MGMT` → `LOAD`.
2. Select compartment.
3. Enter **name** (up to 8 chars A–Z). Press `ENTER`.
4. Display shows: `ENTER KEY SET 1 OF 4`.
5. Enter **8 letters A–Z**. Press `ENTER`.
6. Repeat for sets 2, 3, 4.
7. Device validates the key (checksum, §6.2). On success: `KEY LOADED`. On failure: `Key is Invalid` (exact wording from real device).
8. Update level is set to 00.

#### 5.3.2 Update a key

Advances the key one step along the update chain (see §6.5). The update counter increments; the derived key replaces the working copy. Once a key reaches update 35, further updates are refused and the operator must load a new TEK.

#### 5.3.3 Zeroize

- Single-compartment: prompts `ZEROIZE NN? Y/N`. On Y, clears that compartment.
- All keys: press `ZRO` from main menu, prompts `ZEROIZE ALL? Y/N`. Holding `ZRO` for 3 seconds in any screen: emergency zeroize, no prompt. Wipes all 16 compartments, all message buffers, and the RTC alarm state.

### 5.4 Authentication

A challenge-response mode: station A generates a random 4-letter challenge; station B computes the response using the shared key + current update level; A verifies. Used to confirm both stations hold the same key material before sending classified traffic. Spec defers algorithm detail to §6.6 (**[SUBSTITUTE]** = HMAC-based).

### 5.5 Clock

- `CLK` key jumps to clock view from any state.
- Display shows date and time: `2026-04-18  14:30:45 UTC`.
- Press `ENTER` to set; fields editable with cursor keys.
- Clock is used for time-stamping messages and for the update chain (updates are advisory-expected to happen on day boundaries but are not enforced by time).

### 5.6 Transmit / Receive (acoustic)

- `XMIT`: initiates Bell 103 FSK transmission of the Black buffer. Plays tones through the emulator's speaker. Displays `TRANSMITTING... XX%`.
- `RECV`: listens on the microphone for Bell 103 tones, demodulates into the Black buffer. Displays `RECEIVING... XX%`. Includes FEC decoding (§7.3).

---

## 6. Cryptographic specification

### 6.1 Overview

The real KL-43 uses a classified NSA-approved algorithm. This spec substitutes **DES in CBC mode** (56-bit key, 64-bit block, 64-bit IV per message). **[SUBSTITUTE]**

Rationale: the Datotek XMP-500 export variant of the KL-43 is key-compatible with the real device and uses 56-bit DES in place of the classified algorithm. DES is therefore the single most historically authentic substitute available.

Implementers preferring stronger crypto may swap in 3DES (168-bit effective) or AES-128-CBC via the `crypto_backend` interface. Visual and operational behavior are identical.

### 6.2 Key format

Keys are entered as **32 letters A–Z**, split into **4 groups of 8**. Example input:
```
Set 1: HJKLMNPQ
Set 2: RSTVWXYZ
Set 3: ABCDEFGH
Set 4: JKLMNPQR
```

Each letter maps to 4 bits. **[SUBSTITUTE]** mapping:
```
A=0000  B=0001  C=0010  D=0011
E=0100  F=0101  G=0110  H=0111
I=1000  J=1001  K=1010  L=1011
M=1100  N=1101  O=1110  P=1111
Q–Z: map to A–J (i.e. Q≡A, R≡B, …) to preserve the full A–Z input alphabet
```

32 nibbles × 4 bits = **128 bits** of raw key material.

- The first **120 bits** form the master key material (call it `K_raw`).
- The final **8 bits** form a **checksum**: the sum (mod 256) of the 15 preceding bytes of `K_raw`.
- On LOAD, the device computes the checksum of the entered material and compares to the trailing 8 bits. Mismatch ⇒ `Key is Invalid`. **[SUBSTITUTE]** — the real checksum algorithm is unknown but is likely SAVILLE-style (Crypto Museum's assessment).

For DES use, derive a **56-bit DES key** from `K_raw` by taking the first 7 bytes of SHA-256(`K_raw`). The remaining 113 bits of `K_raw` are reserved for future algorithm extensions. This keeps the DES and 3DES backends driven by the same key material.

### 6.3 Key compartment storage

In-memory structure per compartment:

```
compartment {
  number:       uint4          # 01-16
  name:         char[8]        # uppercase, space-padded, or "AVAILABLE"
  k_raw:        byte[15]       # 120 bits of key material
  checksum:     byte           # 8-bit sum of k_raw
  update_level: uint8          # 0–35
  current_key:  byte[15]       # derived key at current update level (cache)
}
```

All fields live in volatile memory with backup persistence (see §9.4).

### 6.4 Message indicator / IV

The real protocol's indicator format is unknown. **[SUBSTITUTE]**:

Each Black message is prefixed by a 12-character **Message Indicator (MI)**:

```
MI = random 10-letter group (A–Z) || 2-letter checksum
```

- The 10-letter random group (50 bits of entropy) is generated fresh per message using a CSPRNG.
- The 2-letter checksum is the first 10 bits of SHA-256(random group) encoded as 2 letters A–Z (mod 26).
- The IV for DES-CBC is `SHA-256(MI || current_key)[:8]`.

On decrypt, the receiving device parses and verifies the MI before attempting to decrypt. An invalid MI is reported as `BAD HEADER — CHECK KEY/UPDATE`.

### 6.5 Update chain (key derivation)

The real device allows up to 35 successive updates of a TEK. **[SUBSTITUTE]** algorithm:

```
update_key(k_raw, level):
  k = k_raw
  for i in 1..level:
    k = HMAC-SHA-256(k, "KL43-UPDATE-" || byte(i))[:15]
  return k
```

Properties:
- Deterministic — both sides compute the same daughter key for the same level.
- One-way — compromise of `k_{level=N}` does not reveal `k_{level<N}`.
- Bounded — level 35 is the last; level 36+ refused at UI layer.

`current_key` in the compartment is cached as `update_key(k_raw, update_level)` and refreshed whenever `update_level` changes.

### 6.6 Authentication mode

Challenge-response using the current key. **[SUBSTITUTE]**:

```
challenge = 4 random letters A-Z           (20 bits of entropy)
response  = first 4 letters of
            HMAC-SHA-256(current_key, challenge)
            encoded as A-Z (mod 26)
```

Station A displays the challenge, speaks/transmits it; station B enters it, the device displays the response; B speaks/transmits the response; A enters it and the device confirms `MATCH` or `FAIL`.

### 6.7 Ciphertext output format

After encryption, the Black buffer contains:

```
[MI:12 chars] [FEC header:4 chars] [ciphertext groups]
```

- Ciphertext is DES-CBC output bytes, encoded as **A-Z only** using base-26 (6 bits → ~1.29 letters; simplest: 5 output bytes → 8 letters).
- Letters are displayed and transmitted as **5-letter groups separated by single spaces**, 8 groups per line for review mode.
- End-of-message marker: the 4-letter sequence `ZZZZ` appended after the last ciphertext letter, then padded to a 5-letter boundary with `X`.

This matches the convention visible in photographs of real KL-43 output.

---

## 7. Communications

### 7.1 Bell 103 FSK modem

Audio path specification:

| Parameter | Originate station | Answer station |
|---|---|---|
| Mark frequency (logical 1) | 1270 Hz | 2225 Hz |
| Space frequency (logical 0) | 1070 Hz | 2025 Hz |
| Baud rate | 300 | 300 |
| Encoding | 8-N-1 (1 start, 8 data, no parity, 1 stop) | same |
| Full/half duplex | Half (simplex) — device toggles between originate and answer frequencies per direction | same |

The transmitting device should use the **originate** pair if it is the first to transmit in a session; the receiving device uses **answer** when it transmits an ACK or reply. For a single-shot message send, originate pair is sufficient.

Audio levels (from the TRW feature sheet):
- Output: 95 dBa SPL (US lines mode) or 80 dBa SPL (European lines mode), measured 1/8" from speaker.
- Equivalent: −12 dBm on tip/ring of a US line through an acoustic coupler.
- Input range: −35 dBm to 0 dBm.

### 7.2 Framing

Each transmission consists of:

```
[leader: 750 ms of mark tone]
[sync: 0x7E 0x7E 0x7E]
[length: 2 bytes, big-endian, length of payload in bytes]
[payload: FEC-encoded ciphertext bytes]
[trailer: CRC-16 of payload, 2 bytes]
[tail: 100 ms of mark tone]
```

- **750 ms leader** matches the documented "Digital Sync Time: 750 msec" from TRW feature sheet (400 ms for firmware ≤ 1.7.0).
- Sync bytes `0x7E` are HDLC-style flags.
- CRC-16-CCITT (polynomial 0x1021).

### 7.3 Forward Error Correction

**[SUBSTITUTE]**: Reed-Solomon RS(255, 223) over GF(2^8).

- Input: up to 223 bytes per block → 32 parity bytes → 255 bytes output.
- Can correct up to 16 byte errors per block.
- Suitable for acoustic/radio channel with burst errors.

The real KL-43 has built-in FEC but the code is not documented. RS(255,223) is the NASA/CCSDS-standard code of the era and is a reasonable period-authentic choice.

### 7.4 RS-232 interface (optional, stub only)

For completeness and possible extension:

- Baud: selectable 50, 75, 150, 300, 600, 1200, 2400, 4800, 9600, 19200 (actual rates per TRW spec: 50, 75, 150, 300, 601, 1202, 2404, 4808, 9868, 18750 bps)
- Framing: 1 start, 8 data, no parity, 2 stop
- Voltage: RS-232C compatible (±9 V out, ±30 V in tolerant)
- Rise time: < 7 µs through ±3 V

Emulator exposes a virtual serial port (via WebSerial API in browser builds) for future connection to real peripherals.

---

## 8. Persistence and state

### 8.1 Volatile buffers

- **Message buffer (Red)**: 2600 chars. Wiped on power-off.
- **Message buffer (Black)**: 2600 chars. Wiped on power-off.
- **Current operation state**: wiped on power-off.

### 8.2 Non-volatile state (lithium-backed in real device)

- 16 key compartments (each ~30 bytes).
- Key name registry.
- Quiet mode toggle.
- Real-time clock.
- View angle / contrast setting.

### 8.3 Emulator persistence

- Keys persist in `IndexedDB` (browser) or a local file (`~/.kl43emu/state.json` on desktop builds).
- Messages do NOT persist.
- A "Flat Battery" simulation mode is available: clears all persistent state on next launch, simulating lithium cell failure.

### 8.4 Zeroize guarantees

- Logical zeroize: overwrites all key material with `0x00` bytes.
- Strong zeroize: overwrites three times (0xFF, 0x00, random) before removing from storage. Required by spec for audit-mode builds.

---

## 9. Implementation guidance (web target)

### 9.1 Technology stack (recommended)

- **Frontend**: Vanilla HTML + Canvas for the LCD and keypad (pixel-perfect fonts). Optional thin framework (Svelte or Preact) for state.
- **Crypto**: WebCrypto API for SHA-256 and HMAC; custom DES implementation (WebCrypto does not expose DES; use a vetted library such as `crypto-js` or port a small DES into TypeScript, ~200 lines).
- **Audio**: Web Audio API. A custom `AudioWorklet` for Bell 103 modulation/demodulation.
- **Persistence**: IndexedDB via `idb-keyval`.
- **Two-instance link**: WebRTC data channel for direct mode; loopback-to-microphone for acoustic mode.

### 9.2 Font

Use a bitmap font mimicking Hitachi HD44780 character ROM (5×7 dot matrix with 1-dot descender). A free font like "Shared Pixel" or a bespoke 5×7 pixel font rendered at 4× scale gives the right look.

### 9.3 Module layout

```
src/
├── ui/
│   ├── Lcd.ts           # 2x40 character renderer on canvas
│   ├── Keypad.ts        # 59-key input handler + click sound
│   ├── BootScreen.ts
│   └── theme/           # olive-drab case, rubber keys
├── state/
│   ├── StateMachine.ts  # §4.4 menu graph
│   ├── MessageBuffer.ts # 2600-char editor with cursor
│   └── store.ts
├── crypto/
│   ├── CryptoBackend.ts # interface
│   ├── backends/
│   │   ├── DesBackend.ts      # §6 default
│   │   ├── TripleDesBackend.ts
│   │   └── AesBackend.ts
│   ├── KeyCodec.ts      # A-Z <-> 4-bit mapping, checksum
│   ├── Updater.ts       # §6.5 update chain
│   └── Mi.ts            # §6.4 message indicator
├── comms/
│   ├── Bell103.ts       # FSK modulate/demodulate
│   ├── Framing.ts       # §7.2
│   ├── Fec.ts           # RS(255,223)
│   └── Link.ts          # WebRTC or audio loopback
├── persistence/
│   └── Store.ts
└── main.ts
```

### 9.4 Constraint — browser storage

Per Cowork artifact rules, `localStorage` and `sessionStorage` must not be used in artifact builds. Use IndexedDB exclusively. For non-artifact standalone builds, either is acceptable.

### 9.5 Testing

- **Known-answer tests** for DES-CBC (NIST CAVP vectors).
- **Round-trip tests**: encrypt then decrypt a 2600-char message with each of 16 keys × 3 update levels.
- **Modem loopback**: transmit a message end-to-end through the WebAudio path with ±3 dB noise injection. Should succeed with FEC on, fail gracefully with FEC off + noise.
- **UI snapshot tests**: boot screen, main menu, key list (all 16 compartments), error states.
- **Timing**: boot ≤ 3 s; encrypt of 2600 chars ≤ 750 ms on target hardware (old laptop).

---

## 10. Visual reference notes

### 10.1 Color palette

| Element | Color | Notes |
|---|---|---|
| Case | Olive drab (#3B4026 ±) | Matte, slight texture |
| Keys | Dark grey rubber (#2B2B2B) | Slight sheen on top |
| Key legends | Yellow-white (#E8E0B8) | Screen-printed look |
| LCD background | Desaturated green-grey (#8FA18A) | Positive-mode STN |
| LCD characters | Near-black (#0E1410) | Slight smear at edges |
| Screws | Brass / zinc-plated | 13 hex-socket cap screws |
| Label plate | Anodized aluminum | "TSEC/KL-43C" engraved |

### 10.2 Case details

- Left side: hinged battery door with captive screw.
- Right side: recessed U-229 connector, metal cap on short chain.
- Bottom: acoustic coupler grille (speaker visible through perforations); concave cup for handset placement.
- Top: 2-line LCD recessed behind a clear bezel; keypad below.
- Markings: "TSEC/KL-43C" silkscreen; NSN label; TRW corporate mark.

### 10.3 Reference photos

Primary reference: Crypto Museum's KL-43C gallery (multiple angles, interior shots, carrying bag). Secondary: Iran-Contra Congressional hearings C-SPAN footage where a KL-43 (variant A or C) is held up as evidence.

---

## 11. Error states and messages

Exact wording (where known) from the real device. All others are **[SUBSTITUTE]**:

| Condition | Display |
|---|---|
| Key checksum failure on LOAD | `Key is Invalid` |
| Empty key compartment selected | `NO KEY IN COMPT. NN` |
| Update level exceeded (>35) | `UPDATE LIMIT — LOAD NEW TEK` |
| Decrypt failure (bad MI) | `BAD HEADER — CHECK KEY/UPDATE` |
| Decrypt failure (FEC unrecoverable) | `DECRYPT FAIL — RETRANSMIT` |
| Message buffer full | `BUFFER FULL` (3 beeps) |
| Low battery (simulated) | `LOW BATTERY — REPLACE AA` |
| Self-test failure | `RAM FAIL — SERVICE REQUIRED` |
| Zeroize pending | `ZEROIZE? Y/N` |
| Sync lost during RX | `SYNC LOST` |

---

## 12. Open issues and future work

1. **A-Z → nibble mapping**: the real mapping is unknown. If Crypto Museum or an operator ever confirms the true mapping, the `KeyCodec` module is the single point of change.
2. **True cipher**: should the KL-43 algorithm ever be declassified, a new `CryptoBackend` can be dropped in. Expect the algorithm to be a 64- or 128-bit block cipher given the era and key length.
3. **Authenticator format**: real format unknown; current scheme is a plausible SAVILLE-style HMAC.
4. **Dual-language support**: KL-43F added French. Not in scope for v1, but i18n seams should be left in UI strings.
5. **Thermal printer output**: TP-40S is a serial ESC/POS-style printer. A virtual scroll of "printed" text could be added for atmosphere.
6. **Radio mode (U-229)**: simulated PTT via keyboard shortcut would add to the fantasy-ops feel.

---

## 13. References

- TRW Electronic Products, Inc., *KL-43C Operator's Manual*, P/N 410-308-1, Rev F, 15 August 1991.
- TRW Electronic Products, Inc., *Feature Comparison: KL-43 Family of Cryptographic Devices*, undated (NSA-cleared).
- Crypto Museum, *KL-43* (and interior teardown), https://www.cryptomuseum.com/crypto/usa/kl43/, last updated April 2026.
- Jerry Proc, *KL-43 Automanual Equipment*, http://jproc.ca/crypto/kl43.html.
- LTC David M. Fiedler, *The KL-43: burst communication on a budget*, Army Communicator, Winter/Spring 1990, Vol. 15 No. 1.
- USMC, *Marine Corps Order MCO 2250.1*, C4-CCT-635, 17 January 1990 (keying doctrine).
- Jerry Proc, *Datotek XMP-500*, http://jproc.ca/crypto/xmp500.html (export-variant cipher evidence).
- Bell System Technical Reference PUB 41106, *Data Communication Using Voiceband Private Line Channels* (Bell 103 modulation).
- CCSDS 101.0-B-6, *Telemetry Channel Coding* (Reed-Solomon parameters).

---

*End of specification.*
