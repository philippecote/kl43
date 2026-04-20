# KL-43C Emulator — Technical Specification

**Document version:** 2.0 (2026-04)
**Target device:** TSEC/KL-43C "AutoManual System" (TRW Electronic Products, Inc., ~1987–1992 firmware)
**Deliverable:** Faithful functional and visual emulator of the KL-43C portable secure text terminal
**Authenticity goal:** Operationally indistinguishable from the real unit for a user who has never seen source code. Period-accurate aesthetics, key legends, message flow, tones, and failure modes.

> **Reading order.** §§1–13 are the original v1.0 spec kept intact for historical
> record. Appendix A (corrections from a second-pass manual read) and Appendix B
> (cipher backend decision record) **supersede** the body where they conflict.
> For a living register of what is actually implemented vs. the real device, see
> `docs/FAITHFULNESS.md`.

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

RS(255,223) corrects **substitutions** at unknown positions: a single dropped or inserted byte would otherwise shift every byte after it by one column and wildly exceed the 16-error budget. The UART receiver (§7.4) is therefore designed to convert every channel disturbance into a position-preserving substitution before FEC ever sees it — see that section for how dropped bytes are turned into `?` erasures and fed back into RS as zero-valued symbols.

### 7.4 UART receiver clock-lock and erasure handling

The receiver's UART is a three-state machine: **IDLE → DATA → LOCKED → DATA → …**. On the first byte of a transmission it acquires the start-bit edge coarsely in IDLE. After sampling the 10 bits of an 8-N-1 frame it enters LOCKED, holding a bit-clock locked to that byte's start-bit sample index. From LOCKED it predicts the *next* byte's start bit at exactly `lastStartEdge + 10 × spb` (sample-per-bit) and accepts an edge only inside a narrow acceptance window around that prediction.

Three outcomes are possible at the stop-bit sample (or expected start-bit sample) of each byte:

| Trigger | Action | Next LOCKED mode |
|---|---|---|
| Stop bit = mark (clean) | Emit `(byte, erased=false)` | Edge-based resync — hunt for the mark→space transition of the next byte inside `[expectedEdge − 0.5×spb, expectedEdge + 3×spb]`, walk back narrow to pin the exact edge, absorb small clock jitter |
| Stop bit = space (framing error) | Emit `(0x3F, erased=true)` — ASCII `?` | Clock-only resync — the line is continuously space through the erased stop bit and into the next start bit, so no mark→space edge exists at `expectedEdge`; the receiver trusts the bit clock and re-enters DATA at `expectedEdge + 0.5×spb` |
| Start-bit edge missing in window (carrier still on) | Emit `(0x3F, erased=true)`, advance clock by one byte-period, increment `consecutiveLockedMisses`. After `MAX_LOCKED_MISSES` (currently 2) in a row, fall to IDLE. | Edge-based resync on the new slot — if another real byte is coming, its start bit produces the expected edge; if not, we time out again and eventually hit the miss cap |

The third (start-bit-missing) path matters because a start-bit bit flip to mark is the second common channel corruption: the entire frame looks like mark + data + mark, so DATA never enters and only LOCKED notices. Before this path was added, LOCKED silently fell back to IDLE and the byte simply disappeared — no `?` marker, just a stream shift of one base32 symbol and a cascade of "uncorrectable errors" downstream. The user-visible symptom was "groups of 2 chars from time to time, no question mark".

Bounding the miss counter matters because at real EOM (transmitter stopped sending, carrier still on for the post-mark tail) LOCKED cannot tell "byte lost" from "transmitter finished" until it's missed enough slots. Capping at `MAX_LOCKED_MISSES` keeps the spurious trailing `?` count bounded — currently ≤ 2 per message — and those extra `?`s map to zero-bit base32 symbols that sit inside the shortened-codeword zero-pad region, harmless to RS as long as total wire length stays under one 255-byte codeword (which the 2600-char plaintext cap guarantees).

This matters because the Bell 103 channel's dominant failure mode — the one that used to produce "uncorrectable errors" reports downstream — is a single-byte drop on a noisy channel. Before the clock lock was added, a framing error silently dropped the byte and returned the UART to IDLE, where the coarse start-bit scanner often latched onto an internal data-bit transition of the *next* byte and emitted a phantom shifted byte. Either way the byte stream shifted by one and every subsequent codeword landed at the wrong offset — catastrophic for Reed-Solomon.

With clock-lock:

1. The receiver emits **exactly one callback per transmitted UART-frame position**, even when some frames have framing errors or missing start bits. Extra `?` callbacks only appear in the bounded tail of a message (≤ `MAX_LOCKED_MISSES`).
2. Each lost byte surfaces as an erasure at its correct byte position, visible to the operator as a literal `?` in the Review section.
3. Noise-triggered false transitions *between* bytes cannot produce phantom insertions, because LOCKED only accepts edges inside the acceptance window around `expectedEdge`.
4. Off-alphabet corruption (a received byte that isn't A-Z / 2-7 / space — e.g. the `\`, `;`, `!` characters users reported on low-SNR channels) is converted to `?` by [`mapRxByteToReviewChar`](../src/host/modem.ts) before it ever reaches the review buffer. Silent host-side drops would otherwise recreate the stream-shift failure mode after we just eliminated it at the UART layer.
5. The downstream base32 decode path (`filterToBase32PreservingErasures` in [src/wire/Base32.ts](../src/wire/Base32.ts)) substitutes each `?` — and any other non-base32, non-structural character that slips through on paste / import paths — with `'A'`, the zero-bit base32 symbol. Spaces, newlines, tabs, `-` (the conventional hand-copy separator), and `=` (the RFC 4648 pad char) are the only characters still dropped silently because they carry no positional information.

A `?` planted in the **MI header** (first 12 A-Z characters) is not recoverable: MI parsing is strict A-Z and the skipped position pulls in the next body character, corrupting the MI checksum and raising `InvalidMiError` at decrypt time. Erasures inside the MI are vanishingly rare on a real Bell 103 channel, but the contract is explicit: **erasures recover body corruption, not header corruption**.

### 7.5 RS-232 interface (optional, stub only)

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

# Appendix A — Manual-driven corrections (v1 → v2)

The body above preserves the v1.0 spec as written. This appendix is the
machine-readable errata derived from a close re-reading of the primary
sources. Where body and appendix conflict, **this appendix wins** and the
code follows the appendix. Entries are kept here rather than silently
rewriting §§1–13 so the historical intent of v1 stays auditable.


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

*End of Appendix A.*

---

# Appendix B — Cipher backend decision record


**Addendum to:** `docs/SPEC.md` v1.0
**Supersedes:** §6.1 "Overview" of the main spec
**Status:** Decision record + implementation guide
**Applies to:** `src/crypto/` module (being implemented concurrently)

---

## B.1 Decision

The primary `CryptoBackend` is changed from **DES-CBC** to a **SAVILLE-shaped nonlinear LFSR combiner** (hereafter "LFSR-NLC"). Rationale: of all implementable substitutes, the LFSR-NLC is architecturally closest to what the real KL-43's classified algorithm (SAVILLE or a SAVILLE-family variant) is believed to be.

Three backends ship; all implement the same `CryptoBackend` interface so they are runtime-selectable from the emulator options menu:

| Backend ID | Algorithm | Purpose | Default? |
|---|---|---|---|
| `lfsr-nlc` | SAVILLE-shaped LFSR nonlinear combiner | Primary — architecturally closest to real device | **Yes** |
| `aes-ctr` | AES-128 in counter mode | "Secure mode" — operationally equivalent, cryptographically strong | No |
| `des-cbc` | DES-56 in CBC mode | "XMP-500 compatibility mode" — historical period authenticity matching the export variant | No |

All three use the same key format (§6.2 of main spec: 32 A-Z characters → 120 bits + 8-bit checksum), the same message indicator (§6.4), the same update chain (§6.5), and the same ciphertext framing (§6.7). Switching backends changes only the core bit-transformation; the entire UI and wire protocol are unchanged.

---

## B.2 Interface (updated)

```ts
interface CryptoBackend {
  readonly id: 'lfsr-nlc' | 'aes-ctr' | 'des-cbc';
  readonly blockSize: number;         // bytes (LFSR: 1, AES: 16, DES: 8)
  readonly keySize: number;           // bytes (LFSR: 15, AES: 16, DES: 7)

  // Initialize with a 15-byte key material (derived from 120 key bits)
  // and a 12-byte message indicator (decoded from the 12-char MI header).
  init(keyBytes: Uint8Array, mi: Uint8Array): CryptoStream;
}

interface CryptoStream {
  // Encrypts or decrypts (symmetric for LFSR/CTR; CBC has encrypt/decrypt split).
  transform(input: Uint8Array, mode: 'encrypt' | 'decrypt'): Uint8Array;
}
```

Implementation rule: `transform` must be called exactly once per message (whole buffer in, whole buffer out). Streaming across multiple calls is not required — the KL-43 processes complete messages.

---

## B.3 Primary backend — LFSR-NLC

### A.3.1 Design rationale

SAVILLE is widely believed to be a **combination of maximum-length LFSRs through a nonlinear Boolean function**, with irregular clocking. This is the dominant architecture for government stream ciphers of the 1960s–1990s (also used in A5/1 for GSM, E0 for Bluetooth, Toyocrypt, LILI-128, etc.). We replicate that species of design without claiming to replicate SAVILLE itself.

Target properties:

- Internal state size: 127 bits (close to SAVILLE's believed ~120 bits)
- Key size: 128 bits (matches KL-43 key format)
- Output: 1 keystream bit per clock
- Byte-oriented: 8 clocks per output byte
- Used as a synchronous stream cipher: `ciphertext[i] = plaintext[i] XOR keystream[i]`
- Encryption and decryption are the same operation

### A.3.2 Register specification

Three LFSRs with coprime primitive polynomials over GF(2). Lengths chosen so the total period is 2^127 − 1 (adequate for any message the KL-43 can hold at 2600 chars = 20800 bits).

```
Register A:  39 bits
             Polynomial: x^39 + x^4 + 1
             Feedback tap indices (from bit 0 = LSB): {0, 35}
             Total bits: 39

Register B:  41 bits
             Polynomial: x^41 + x^3 + 1
             Feedback tap indices: {0, 38}
             Total bits: 41

Register C:  47 bits
             Polynomial: x^47 + x^5 + 1
             Feedback tap indices: {0, 42}
             Total bits: 47

Grand total state: 39 + 41 + 47 = 127 bits.
```

All three polynomials are primitive — verified against Lidl & Niederreiter, *Introduction to Finite Fields*, Appendix B.

### A.3.3 Feedback (one step of a single LFSR)

For a register of length `L` with tap set `T`:

```
feedback_bit = XOR over t in T of register[t]
register = (register << 1 | feedback_bit) & ((1 << L) - 1)
```

The newly shifted-in bit is `feedback_bit`. The bit shifted out on the other end is `register[L-1]` *before* the shift — this is the output bit of the register for this clock.

### A.3.4 Irregular clocking

Not all three registers clock on every step. Which clock is determined by a majority function of three "clocking bits," one per register. This is the same mechanism as A5/1.

```
Clocking bit positions (mid-register, chosen to spread well):
  ca = A[19]
  cb = B[20]
  cc = C[23]

majority = (ca + cb + cc) >= 2 ? 1 : 0

Clock register A if ca == majority
Clock register B if cb == majority
Clock register C if cc == majority
```

At each step, either 2 or 3 registers clock; never 0 or 1. This is the source of non-linearity in the timing.

### A.3.5 Combiner (the nonlinear function)

After clocking, each register has an output bit (the bit that was shifted out). The keystream output is a nonlinear combination of these three output bits.

We use a **Geffe-style selector with balancing**:

```
Let a, b, c = output bits of A, B, C this step.

keystream_bit = (a AND b) XOR ((NOT a) AND c) XOR b
              = a·b ⊕ ā·c ⊕ b
```

The plain `a·b ⊕ ā·c` Geffe combiner is known to have correlation weaknesses (P(output = b) = 0.75 and similar). Adding `⊕ b` rebalances the truth table so each input has correlation 0 or ±1/4 at worst — good enough for a prop, and prevents the most obvious statistical tests from flagging it immediately.

Truth table (for reference and for unit testing):

| a | b | c | a·b | ā·c | Combined ⊕ b |
|---|---|---|-----|-----|--------------|
| 0 | 0 | 0 |  0  |  0  | 0 |
| 0 | 0 | 1 |  0  |  1  | 1 |
| 0 | 1 | 0 |  0  |  0  | 1 |
| 0 | 1 | 1 |  0  |  1  | 0 |
| 1 | 0 | 0 |  0  |  0  | 0 |
| 1 | 0 | 1 |  0  |  0  | 0 |
| 1 | 1 | 0 |  1  |  0  | 0 |
| 1 | 1 | 1 |  1  |  0  | 0 |

Balanced (four 0s, four 1s).

### A.3.6 Key loading

Input: 15-byte key material `K[0..14]` (120 bits) from the `CryptoBackend.init()` call.

```
1. Clear A, B, C to all zeros.
2. For each of the 120 key bits k (MSB first):
     a. Clock all three registers once (regular clocking — not majority, every register clocks).
     b. Before writing the feedback bit back, XOR it with k.
     c. This means the new bit shifted into each register = feedback_bit ⊕ k.
3. After all 120 key bits are consumed, the state is "keyed."
```

This is the same key-loading pattern as A5/1 — it ensures every key bit influences every register state bit through the shift/XOR diffusion.

### A.3.7 Message indicator loading

Input: 12-byte MI from the header (the 10-letter random group plus 2-letter checksum, encoded as bytes).

```
4. For each of the 96 MI bits (12 bytes × 8, MSB first):
     a. Clock all three registers once (regular clocking).
     b. XOR the MI bit into the feedback bit of each register as in step 2b.
5. Clock all three registers an additional 256 times with irregular (majority) clocking
   and discard the output bits. This is the "warm-up" or "mixing" period.
6. The cipher is now ready to produce keystream.
```

After step 6, any change to key or MI affects essentially every state bit with high probability.

### A.3.8 Keystream generation

```
generate_byte():
  byte = 0
  for i in 0..7:
    majority = compute majority of clocking bits
    clock registers per majority rule
    a = output bit of A this step
    b = output bit of B this step
    c = output bit of C this step
    bit = a·b ⊕ ā·c ⊕ b
    byte = (byte << 1) | bit
  return byte
```

### A.3.9 Encryption / decryption

```
transform(input, mode):  // mode is ignored — operation is symmetric
  output = Uint8Array(input.length)
  for i in 0..input.length - 1:
    output[i] = input[i] XOR generate_byte()
  return output
```

### A.3.10 Reference implementation (TypeScript, ~80 lines)

```ts
export class LfsrNlcStream implements CryptoStream {
  private a = 0n; // BigInt; 39 bits used
  private b = 0n; // 41 bits used
  private c = 0n; // 47 bits used

  constructor(keyBytes: Uint8Array, mi: Uint8Array) {
    // Key load (120 bits)
    for (const byte of keyBytes) {
      for (let bit = 7; bit >= 0; bit--) {
        const k = (byte >> bit) & 1;
        this.stepAll(k);
      }
    }
    // MI load (96 bits)
    for (const byte of mi) {
      for (let bit = 7; bit >= 0; bit--) {
        const k = (byte >> bit) & 1;
        this.stepAll(k);
      }
    }
    // Warm up: 256 irregular clocks, discard output
    for (let i = 0; i < 256; i++) this.keystreamBit();
  }

  transform(input: Uint8Array): Uint8Array {
    const out = new Uint8Array(input.length);
    for (let i = 0; i < input.length; i++) {
      let k = 0;
      for (let b = 0; b < 8; b++) k = (k << 1) | this.keystreamBit();
      out[i] = input[i] ^ k;
    }
    return out;
  }

  /** Clock all three registers (regular clocking, for key/MI load). */
  private stepAll(xorBit: number): void {
    this.a = this.shiftOne(this.a, 39n, [0n, 35n], xorBit);
    this.b = this.shiftOne(this.b, 41n, [0n, 38n], xorBit);
    this.c = this.shiftOne(this.c, 47n, [0n, 42n], xorBit);
  }

  /** One keystream bit with irregular (majority) clocking. */
  private keystreamBit(): number {
    const ca = Number((this.a >> 19n) & 1n);
    const cb = Number((this.b >> 20n) & 1n);
    const cc = Number((this.c >> 23n) & 1n);
    const maj = (ca + cb + cc) >= 2 ? 1 : 0;

    let oa = 0, ob = 0, oc = 0;
    if (ca === maj) { oa = Number((this.a >> 38n) & 1n); this.a = this.shiftOne(this.a, 39n, [0n, 35n], 0); }
    if (cb === maj) { ob = Number((this.b >> 40n) & 1n); this.b = this.shiftOne(this.b, 41n, [0n, 38n], 0); }
    if (cc === maj) { oc = Number((this.c >> 46n) & 1n); this.c = this.shiftOne(this.c, 47n, [0n, 42n], 0); }

    return ((oa & ob) ^ ((oa ^ 1) & oc) ^ ob) & 1;
  }

  private shiftOne(reg: bigint, len: bigint, taps: bigint[], xorBit: number): bigint {
    let fb = 0n;
    for (const t of taps) fb ^= (reg >> t) & 1n;
    fb ^= BigInt(xorBit);
    const mask = (1n << len) - 1n;
    return ((reg << 1n) | fb) & mask;
  }
}
```

### A.3.11 Test vectors

Implementers: verify against these before integrating. These are the reference outputs of the implementation above; they are not guaranteed stable across spec revisions.

**Vector 1** — all-zero key and MI:

```
Key:       00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
MI:        00 00 00 00 00 00 00 00 00 00 00 00
Plaintext: 48 45 4C 4C 4F                             ("HELLO")
Keystream: TBD — compute and paste on first run
Ciphertext: plaintext XOR keystream
```

**Vector 2** — key = "ABCDEFGHIJKLMNOP" mapped via A.3.12, MI = "RANDOMGROUPXY":

```
Key (15 bytes): derived via KeyCodec.decode("ABCDEFGHIJKLMNOPQRSTUVWXYZABCDEF")
                (first 32 chars of pangram; discard trailing checksum byte)
MI:             "RANDOMGROUPXY" encoded 1 byte per char via ASCII-32
Plaintext:      "MEET AT MIDNIGHT BEHIND THE MOTEL"
Output:         TBD — compute on first run, freeze as regression test
```

**Vector 3** — ensure encrypt-then-decrypt round-trips for a 2600-char buffer of random bytes.

After implementation, freeze the ciphertext outputs for vectors 1 and 2 and commit them to `test/fixtures/lfsr_nlc.json`. Any future change to key-schedule, combiner, or clocking must intentionally break these.

### A.3.12 Key material derivation

The 32-character A-Z input is decoded via `KeyCodec` (main spec §6.2) into 16 bytes: 15 bytes of key material + 1 byte checksum. For LFSR-NLC, use only the 15 key bytes (`keyBytes[0..14]`) passed directly to `init()`.

---

## B.4 Secondary backend — AES-128-CTR

### A.4.1 Purpose

Provides a "modern Type 1 equivalent" — operationally indistinguishable from LFSR-NLC, but cryptographically sound. Useful for:

- Demonstrating the emulator without running a toy cipher
- Stress-testing the UI and wire protocol with a known-good backend
- Interop with other AES-CTR emulators built by others

### A.4.2 Specification

- Algorithm: **AES-128 in CTR mode**, standard NIST SP 800-38A
- Key: first 16 bytes of `SHA-256(keyBytes || [0x01])` (expands 15-byte key material to 128-bit AES key)
- Nonce/IV: first 12 bytes = `mi`; last 4 bytes = counter starting at 0 (big-endian)
- Counter increment: big-endian, within the last 32 bits only
- Encrypt/decrypt: symmetric (XOR with AES-CTR keystream)

### A.4.3 Implementation

Use WebCrypto `SubtleCrypto.encrypt({ name: 'AES-CTR', counter: iv, length: 32 }, key, input)`. Both encrypt and decrypt call the same method.

Round-trip test: encrypt then decrypt must be the identity for all inputs up to 2600 bytes.

---

## B.5 Tertiary backend — DES-56-CBC

### A.5.1 Purpose

Historical authenticity for users who want "what the XMP-500 actually did." Marked in UI as `XMP-500 MODE — EXPORT CIPHER`.

### A.5.2 Specification

- Algorithm: **DES** (FIPS 46-3, now withdrawn), **CBC mode**
- Key: first 7 bytes of `SHA-256(keyBytes || [0x02])`, expanded to 8 bytes with odd parity per byte
- IV: first 8 bytes of `SHA-256(mi)` — reduced from 12 to 8 bytes because DES block = 64 bits
- Padding: PKCS#7 (on encrypt, strip on decrypt)
- Encrypt and decrypt are distinct operations (unlike the other two backends)

### A.5.3 Implementation

No WebCrypto support for DES. Use a vetted DES library (e.g., `crypto-js`'s TripleDES with K1=K2=K3 for single-DES behavior, or a small dedicated DES module — ~200 lines).

### A.5.4 Warning in UI

When this backend is active, display a persistent warning in the menu: `EXPORT MODE — 56-BIT KEY — NOT SECURE`. This is cosmetic (matches the real-world status of DES in the 2020s) but also an honest disclosure.

---

## B.6 Backend selection UI

Add to main menu, under `OPTIONS → CRYPTO BACKEND`:

```
+----------------------------------------+
| CRYPTO BACKEND                         |
| > [*] SAVILLE-SHAPED     (default)     |
|   [ ] AES-128 SECURE                   |
|   [ ] DES-56 / XMP-500                 |
| XIT: BACK   ENTER: SELECT              |
+----------------------------------------+
```

Selection persists across sessions (IndexedDB). Changing backend invalidates cached `current_key` values in all compartments — they're recomputed on next encrypt/decrypt using the new backend.

---

## B.7 Impact on other spec sections

- **§6.1** (main spec) — superseded by this addendum; update header to reference `ADDENDUM A`.
- **§6.4** (MI) — unchanged; all backends consume the same 12-byte MI.
- **§6.5** (update chain) — unchanged; runs at the protocol layer, not the algorithm layer. Outputs `current_key` bytes that each backend consumes identically.
- **§6.6** (authentication) — unchanged; still HMAC-based, independent of traffic cipher.
- **§9.3** (module layout) — add three files under `src/crypto/backends/`:
  - `LfsrNlcBackend.ts`
  - `AesCtrBackend.ts`
  - `DesCbcBackend.ts`

No changes to UI, modem, FEC, persistence, or state machine.

---

## B.8 Implementation checklist (for the team mid-flight)

- [ ] `CryptoBackend` and `CryptoStream` interfaces merged into `src/crypto/CryptoBackend.ts`
- [ ] `LfsrNlcBackend.ts` implemented and passes vectors 1 & 2
- [ ] `AesCtrBackend.ts` implemented via WebCrypto
- [ ] `DesCbcBackend.ts` implemented via dedicated library
- [ ] Round-trip test suite covers all three backends × 3 key sizes × message lengths {1, 64, 2600}
- [ ] Backend selector wired into options menu
- [ ] Persisted selection honored on boot
- [ ] Cache invalidation on backend switch
- [ ] `EXPORT MODE` warning visible when DES selected

---

*End of Appendix B.*

---

*End of specification.*
