# FAITHFULNESS.md

A living register of every place our emulator matches, substitutes, or departs
from the real TSEC/KL-43C. Maintained in lockstep with the code.

**Legend**
- ✅ **Pinned**: value comes verbatim from a primary source. Changing it without
  re-sourcing is a regression.
- 🔧 **Substitute**: the real value is unknown or unreachable; we use a
  best-effort reconstruction and declare it as such.
- 🚫 **Out of scope**: the real device has it but the emulator does not attempt
  it, with a stated reason.
- ❓ **Unknown**: observable from the manual but insufficiently specified; our
  implementation is a guess pending better sources.

**Sources**
- **MAN** — TRW *KL-43C Operator's Manual*, P/N 410-308-1, Rev F, 1991-08-15
- **FS** — TRW *Feature Comparison: KL-43 Family of Cryptographic Devices*
- **DUT** — KL Royal Army Instruction Card IK004164, 1994-05-02
- **CM** — Crypto Museum KL-43 gallery (photographs)
- **JP** — Jerry Proc, *KL-43 Automanual Equipment* & *Datotek XMP-500*
- **XMP** — Datotek XMP-500 commercial equivalents

---

## 1 · Cryptographic core

| Aspect | Real KL-43C | Emulator | Source | Status |
|---|---|---|---|---|
| Cipher algorithm | SAVILLE-family, classified (NSA Suite A / Type 1) | DES-CBC (pluggable: 3DES, AES via `CryptoBackend`) | MAN §Security, XMP uses DES | 🔧 |
| DES precedent for substitute | — | XMP-500 is key-compatible with KL-43 and uses 56-bit DES | JP, FS | 🔧 (best substitute available) |
| Block size | likely 64-bit | 64-bit (DES) | — | 🔧 |
| Key material bit length | 120 bits raw + 8 bit checksum = 128 | Same layout | MAN + FS (32 letters in 4 sets of 8) | ✅ (layout) / 🔧 (semantics) |
| A–Z → nibble mapping | Unknown | A=0…P=15, Q–Z alias A–J | — | 🔧 |
| Key checksum algorithm | Unknown; Crypto Museum: "likely SAVILLE-style" | Sum mod 256 of 15 bytes | CM | 🔧 |
| Message Indicator format | Unknown | 10 random letters + 2-letter SHA-256 checksum = 12 chars | — | 🔧 |
| Session IV derivation | Unknown | `SHA-256(MI ‖ current_key)[:8]` | — | 🔧 |
| Key update KDF | Unknown | HMAC-SHA-256 chain, 35 steps max | — | 🔧 |
| Authentication function | Unknown (but time-bound) | `HMAC-SHA-256(key, challenge ‖ 10-min UTC bucket)`, first 4 base32 chars | MAN p.40 (20-min tolerance) | 🔧 (function) / ✅ (tolerance) |
| Ciphertext alphabet | A–Z + 2–7 (base32) | Identical | MAN p.12 | ✅ |
| Ciphertext grouping | 3-char groups, single-space separated | Identical | MAN p.12 | ✅ |
| FEC code | Unknown (built-in); surfaces `THERE WERE UNCORRECTABLE / ERRORS PRESS EXIT.` when noise is too bad (MAN p.53) | Reed-Solomon RS(255, 223) over GF(256) — 32 parity bytes per block, corrects up to 16 symbol errors per 255-byte codeword. Applied in **shortened** form: virtual zero padding in the last data block is not transmitted (and not spoken/copied); only the real data bytes and the 32 parity bytes go on the wire. Wired into encrypt/decrypt: clean transcription rounds-trip verbatim, a handful of character flips are silently corrected, and uncorrectable noise routes to the same Appendix B `D_UNCORRECTABLE` screen. | MAN p.53; `src/wire/WireFrame.ts`, `src/wire/EncryptedMessage.ts`, `src/machine/Machine.ts:performDecrypt` | 🔧 (code picked, wiring real) |
| FEC wire overhead | Unknown; the manual shows ciphertext blocks roughly the same size as the plaintext on p.12 | Shortened RS adds a fixed 32 parity bytes (≈ 52 base32 chars ≈ 17 three-char groups) per 223-byte block. A typical 40-char message is ~40 cipher bytes → one shortened block, ~72 wire bytes, ~116 base32 chars — which the operator actually reads out or types back. An earlier payload-level full-codeword variant transmitted the zero tail verbatim, forcing the operator to voice a ~300-char run of `A`s for short messages; that variant is explicitly rejected here as worse-than-real UX. | `src/wire/WireFrame.ts` (`frameOutgoing`/`unframeIncoming`) | ✅ |
| FEC scope (payload vs. modem) | Payload: FEC is baked into the ciphertext groups on p.12, so the `THERE WERE UNCORRECTABLE ERRORS` warning is a **decrypt-time** error, not a modem-time error. Listing on MAN p.53 Appendix B groups it with other decryption failures; FS §3.4 likewise treats it as part of the encrypted message format. Operationally this is what lets the device tolerate ciphertext that was hand-copied on paper, read aloud over HF SSB voice, or relayed through a degraded channel the KL-43 never saw directly. | Same: `encryptMessage` wraps the cipher bytes in RS parity **before** Base32 grouping, and `decryptMessage` runs the RS decoder **before** handing bytes to the cipher. The 300-baud Bell-103 modem layer carries the already-FEC'd characters as UART bytes without its own inner code, matching the manual's architecture. Keeping FEC at the payload level (rather than at TX time only) was deliberately chosen for this faithfulness reason — a modem-only FEC would make the channel look cleaner than the real device but would strip protection from the paper/voice/relay use cases the KL-43 was actually designed for. | MAN p.12 (ciphertext block length), MAN p.53 Appendix B (error surfaces at decrypt), FS §3.4; `src/wire/EncryptedMessage.ts` | ✅ (architecture) |
| Key checksum wrong → message | `Key is Invalid` | Identical | MAN p.8 | ✅ |
| Malfunction → auto-zeroize all keys | Yes | Yes | MAN p.54 | ✅ |

## 2 · Wire protocol (modem)

| Aspect | Real | Emulator | Source | Status |
|---|---|---|---|---|
| Modulation | Bell-103 FSK | Bell-103 FSK | FS, MAN Appendix F | ✅ |
| Baud | 300 | 300 | MAN p.67 | ✅ |
| Duplex | Simplex | Simplex | MAN p.67 | ✅ |
| Originate/Answer freqs | 1270/1070 Hz, 2225/2025 Hz | Identical | Bell 103 standard | ✅ |
| Leader | 750 ms mark tone (400 ms on firmware ≤1.7.0) | Identical, configurable | FS p.3 | ✅ |
| Sync bytes | HDLC 0x7E | 0x7E 0x7E 0x7E | — | 🔧 |
| Frame CRC | Unknown | CRC-16-CCITT (poly 0x1021) | — | 🔧 |
| Digital Sync Time | 750 ms (400 ms on C ≤1.7.0) | Identical | FS | ✅ |
| Acoustic SPL output | 95 dBA (US Lines) / 80 dBA (Euro Lines) | Level-matched in output gain | MAN Appendix F, FS | ✅ |
| Acoustic channel band | 300–3400 Hz via phone handset | Band-limited in "acoustic" XMIT mode | telephone network standard | ✅ (simulated) |
| XIT during TX stops modem audio | Operator drops the handset / lifts the coupler — carrier ends mid-message | Identical — the live `AudioBufferSourceNode` is retained as a `TransmitHandle` and explicitly `stop()`-ed when the machine leaves an audible-TX state (`C_TX_BUSY` / `C_TX_COMPLETE`), so pressing XIT silences the speaker immediately. Earlier the buffer played to completion regardless of state, producing phantom modem tone after the operator had moved on. | inferred from physical coupling; `src/host/modem.ts:transmitTextTo`, `src/host/main.ts`, `src/host/pair.ts` | ✅ |
| "TRANSMISSION COMPLETE" timing | Appears only after the modem actually stops (operator hears the carrier drop, then the LCD flips) — MAN p.27 describes the screen as the end-of-transmit state. | `C_TX_BUSY` is held open for the entire audio playback: the machine fires `txTransmitted` on entry, the host starts the modem tones synchronously, and only when `TransmitHandle.done` resolves does it call `machine.txComplete()` to flip the LCD to `TRANSMISSION COMPLETE`. Earlier the machine auto-transitioned after a fixed 1 s tick, which painted the completion screen ~30 s before the carrier actually fell silent on a maxed-out message. | MAN p.27; `src/machine/Machine.ts` (`C_TX_BUSY` / `txComplete`), `src/host/main.ts`, `src/host/pair.ts` | ✅ |
| RS-232 framing | 8-N-2 | Identical | FS (MAN p.27 typo says 1 stop bit) | ✅ |
| RS-232 rates | 50/75/150/300/600/1200/2400/4800/9600/19200 nominal; 50/75/150/300/601/1202/2404/4808/9868/18750 actual | Nominal rates only | FS | ✅ (nominal) / 🔧 (actual drift not simulated) |

## 3 · User interface — text

Every user-visible string is registered in `src/ui/STRINGS.ts` with a source
citation. Summary: **60+ strings pinned** to MAN, **14 warnings** from Appendix B,
**13 menu items** from MAN p.9.

| Area | Strings pinned | Source |
|---|---|---|
| Boot & power | 3 | MAN p.5, p.47 |
| Key Select & load | 6 | MAN pp.6–8 |
| Main Menu | 13 items + headers | MAN p.9 |
| Word Processor | 9 | MAN pp.11–14 |
| Key management | 5 | MAN pp.16–17 |
| Encrypt / Decrypt | 6 | MAN pp.17–20 |
| Communications | 12 | MAN pp.22–38 |
| Authentication | 4 | MAN pp.40–42 |
| Zeroize | 4 | MAN pp.43–44 |
| Quiet / Clock / Print | 6 | MAN pp.39–46 |
| Warnings (Appendix B) | 14 | MAN pp.51–54 |

**Uncertainties** (marked `UNCERTAIN` in `STRINGS.ts`):
- Exact TRW boot banner wording (manual describes prose, does not quote).
- `The Editor is in the cipher text mode` banner (inferred by symmetry).
- Lowercase `is` vs uppercase `Is` in some key-selection confirmations — manual
  is inconsistent within itself; we preserve both forms.

## 4 · User interface — visual

| Aspect | Real | Emulator | Source | Status |
|---|---|---|---|---|
| LCD geometry | 2 rows × 40 cols monospaced | Identical | MAN Appendix F | ✅ |
| LCD controller | Hitachi HD44780 family | 5×7 dot matrix + 1-dot descender simulation | inferred (HD44780 was industry standard) | 🔧 |
| LCD character set | HD44780 A00 (Japanese + European) subset | A00 ROM reproduced; only used glyphs drawn | inferred | 🔧 |
| LCD colors | Dark chars on green-grey STN background | #0E1410 on #8FA18A | spec §10.1, tuned from CM photos | ✅ (color) / ❓ (exact hex) |
| LCD physics | STN ~80 ms response, viewing-angle falloff, edge smear | Simulated in shader | HD44780/STN datasheets | 🔧 |
| Case color | Olive drab | #3B4026 (tuned from CM photo) | spec §10.1, CM | ❓ (will re-sample from CM photo) |
| Case material | Die-cast aluminum, matte finish | Rendered; not modeled physically | FS, CM | 🚫 (physics) |
| Dimensions | 168.9 × 41.9 × 95.3 mm | Rendered at this aspect ratio | MAN Appendix F, DUT | ✅ |
| Weight | 926 g | N/A (not modeled) | MAN, DUT | 🚫 |
| Screws | 13 hex-socket cap screws | Rendered in correct positions | CM photos | ❓ (count/position to verify) |
| Label plate | Anodized aluminum, "TSEC/KL-43C" | Rendered as texture | CM | ❓ |
| Keypad | 59 rubber keys (estimated) | DOM/CSS keys with press animation | CM + MAN Appendix F | ❓ (exact count from photo trace) |
| Key color | Dark grey rubber | #2B2B2B, subtle sheen | spec §10.1 | ❓ |
| Key legends | Yellow-white screen-print | #E8E0B8 | spec §10.1 | ❓ |
| Key click | Piezo dome, ~4 kHz fundamental, ~10 ms decay | SUBSTITUTE: 800 Hz square, 8 ms, 0 ms attack, gain 0.035, + 1.5 ms noise burst (BP 1200 Hz, Q 1.4, gain 0.02); suppressed in Quiet Mode. Tuned to read as a soft plastic tick below the Bell-103 modem band so rapid typing doesn't sound like a kitchen timer. | inferred; `src/host/audio.ts:playKeyClick` | 🔧 |
| Confirmation chirp (encrypt/decrypt/key-load/auth) | Single piezo tone, pitch/duration unrecorded | SUBSTITUTE: 1000 Hz sine, 150 ms, gain 0.08; suppressed in Quiet Mode | inferred; `audio.ts:playConfirm` | 🔧 |
| Error beep (decrypt fail / key-invalid) | Piezo, pattern unrecorded | SUBSTITUTE: 1200 Hz → 600 Hz squares, 80 ms each, gain 0.09; overrides Quiet Mode | inferred; `audio.ts:playError` | 🔧 |
| Power-on chirp | Unknown | SUBSTITUTE: 600 → 1200 Hz glide, 200 ms sine, gain 0.08 | inferred; `audio.ts:playPowerOn` | 🔧 |
| Power-off tone | Unknown | SUBSTITUTE: 220 Hz sine, 180 ms, gain 0.08 | inferred; `audio.ts:playPowerOff` | 🔧 |
| Zeroize flourish | Unknown | SUBSTITUTE: 1200 → 900 → 600 Hz descending squares, ~380 ms total, gain 0.09; overrides Quiet Mode | inferred; `audio.ts:playZeroize` | 🔧 |
| Key travel / tactility | Rubber dome | Visual press animation + audio click only | — | 🚫 (mechanical feel impossible in software) |
| Power LED | None documented | None | — | ✅ |
| Acoustic coupler grille | Visible on bottom, concave cup for handset | Rendered | MAN Appendix A, CM | ✅ |
| Battery door | Hinged, left side, captive screw | Rendered; non-interactive | MAN Appendix A | ❓ |

## 5 · Behaviour & timing

| Aspect | Real | Emulator | Source | Status |
|---|---|---|---|---|
| Boot confirm timeout | 15 s | 15 s | MAN p.5 | ✅ |
| Boot banner duration | Brief; no pinned value | 2.0 s (spec) | spec §4.2 | 🔧 |
| First-time setup (10-digit S/N + 15-letter owner code) | Enforced on virgin hardware | Not implemented; recorded as a deliberate omission in §7 | MAN p.5 Note 1 | 🚫 |
| Encrypt throughput | ~3 MHz NSC800 doing a block cipher | Throttled to ≥500 ms for 2600-char message | inferred; spec §9.5 says ≤750 ms | 🔧 (period-accurate feel) |
| Clock locked during encrypt/decrypt/xmit/recv/auth | Yes | Yes | MAN pp.17, 19, 44 | ✅ |
| Silent Mode blocks acoustic modem | Yes | Yes | MAN p.39 | ✅ |
| Silent Mode permits connector audio / RS-232 | Yes | Yes | MAN p.39 | ✅ |
| Silent Mode persists across power cycles | Yes | Yes | MAN p.40 | ✅ |
| Keys persist across power cycles | Yes (lithium-backed) | Yes (IndexedDB) | MAN p.3 | ✅ |
| Messages wiped on power-off | Yes | Yes | MAN p.11 | ✅ |
| RTC continues across power-off | Yes | Yes (system clock ref) | MAN p.47 | ✅ |
| AUTH clock tolerance | ±20 minutes | ±20 minutes (via 10-min bucket with ±2 retry) | MAN p.40 | ✅ |
| Emergency zeroize trigger | ZRO pressed at boot | Same | MAN p.43 | ✅ |
| Emergency zeroize confirm | Y/N prompt | Same | MAN p.43 | ✅ |
| Review mode restrictions | Only `^`/`v` active | Same | MAN p.21 | ✅ |
| Manually-entered ciphertext cannot transmit | Yes, surfaces `CIPHER TEXT HAS BEEN LOCALLY ENTERED / COMMUNICATIONS DENIED.` | Same, via `C_LOCAL_CIPHER_DENIED`; any key returns to Main Menu | MAN pp.12, 22; Appendix B p.52 | ✅ |
| Plaintext cannot transmit | Yes, surfaces `MESSAGE IN PLAIN TEXT FORM / COMMUNICATIONS DENIED.` so an operator who forgets to press E cannot put the message on the wire in the clear | Same, via `C_PLAIN_DENIED`; `DualBuffer.assertTransmittable` rejects any `form === "PLAIN"` slot regardless of provenance (typed or decrypted), so retransmitting a decrypted message is also refused | MAN p.53 Appendix B (`warn_plain_tx`); `src/editor/DualBuffer.ts`, `src/machine/Machine.ts` | ✅ |

## 6 · Persistence

| Item | Real | Emulator | Status |
|---|---|---|---|
| 16 key compartments | Lithium-backed CMOS SRAM | IndexedDB object store | ✅ |
| Key name (≤10 alphanumeric) | Yes | Yes | ✅ |
| Current update level (0–35) | Yes | Yes | ✅ |
| Message buffer A/B | Volatile | `Map<"A"\|"B", string>` in memory only | ✅ |
| Message buffer size | "2600 characters per buffer" (MAN p.10) — this is the plaintext-entry cap; the 2601st keypress is silently dropped. The real device stores the expanded ciphertext (MI + FEC + base32 + grouping) in the same slot, so the physical memory must be larger than 2600 — the exact cap isn't in the manual. | Split into two constants in `src/editor/TextBuffer.ts`: `MAX_PLAINTEXT_CHARS = 2600` enforced by the WP_EDITOR in PLAIN mode (MANUAL p.10), and `MAX_BUFFER_CHARS = 8000` as the physical cap enforced on CIPHER-mode entry and on the in-place `performEncrypt` write-back. A maxed 2600-char plaintext expands through base32 + RS(255, 223) + 3-char grouping + MI to ~6400 chars, which the receiver has to be able to hand-type back in. Earlier, a single 2600-char cap silently truncated the ciphertext during encrypt, producing an uncorrectable-RS failure on the receiver with no visible cause. Round-trip coverage for all three backends at the full 2600-char plaintext is pinned in `stationPair.test.ts`. | MAN p.10; `src/editor/TextBuffer.ts`, `src/machine/Machine.ts` (WP_EDITOR cap selection) | ✅ (plaintext cap) / 🔧 (physical cap) |
| Last comms setup | Persisted | IndexedDB | ✅ |
| Silent/Audio mode | Persisted | IndexedDB | ✅ |
| Real-time clock | Lithium-backed | `Date.now()` with offset persisted | ✅ |
| "Flat Battery" simulation | N/A | Clears all persistent state on launch | 🚫 (not part of real device, but opt-in debug aid) |

## 7 · Out of scope (with reasons)

| Feature | Reason |
|---|---|
| TEMPEST emissions | Only observable with specialised equipment; no signal surface a software emulator can fake. |
| Real NSA cipher algorithm | Still classified as of 2026; no path to a faithful implementation. |
| Real NSC800 firmware emulation | Firmware never publicly dumped; would require a declassified binary. |
| Radio (U-229) interface | No real radio to talk to; RS-232 stub covers the pinout cosmetically. |
| Thermal printer (TP-40S) | Physical device; we render a DOM "printed scroll" overlay (`src/host/printer.ts`) triggered by the P-menu. Fixed-pitch type, optional tear line, auto-dismiss. Paper feed timing, thermal dot geometry, and ribbon artifacts are **not** modelled. |
| First-time power-up ritual (10-digit S/N + 15-letter owner code) | Deliberately omitted. The real device requires it on virgin hardware (MAN p.5 Note 1) as an anti-theft gate; in a browser emulator with no hardware identity, prompting for it would be cargo-culted ceremony that every visitor has to skip on every visit. Recorded here so nobody re-adds it without thinking it through. |
| Battery drain modelling | Not interesting without physical power path; "Low Battery" simulated by timer or test hook. |
| Rubber-dome tactility | Impossible in software; visual press + audio click compensate. |
| Mechanical watertightness | Not modelable. |
| Lithium cell failure | Simulated via "Flat Battery" mode; not modelled temporally. |

## 8 · Known unknowns (to resolve if sources emerge)

1. **A–Z ↔ nibble mapping.** Real mapping unpublished.
2. **Real key checksum function.** Crypto Museum hint only.
3. **Real Message Indicator format.** Unpublished.
4. **Real FEC code and code rate.** Unpublished.
5. **Real AUTH function.** Unpublished; we know clocks are involved.
6. **Real update-key KDF.** Unpublished.
7. **Exact TRW boot banner wording.** Prose description in manual; no quote.
8. **The "14th menu item."** Manual claims 14 but lists 13. Photograph or
   later firmware may reveal a hidden item.
9. **Pixel-accurate keypad geometry.** Traceable from higher-resolution
   photos; our `KEYPAD_LAYOUT.json` starts as an approximation.
10. **Exact piezo click spectrum, confirmation chirp, error pattern, and
    power-off tone.** A field recording of a powered-on KL-43 would settle
    all six (click, confirm, error, power-on, power-off, zeroize). Current
    values in `src/host/audio.ts` are SUBSTITUTE and flagged in §4.
11. **Photo of firmware version on a real boot screen.** Would pin the banner.

## 9 · Non-regression rules

1. Any change to a row above marked ✅ must either:
   - update the cited source, or
   - downgrade the row to 🔧 / ❓ with a stated reason.
2. No user-visible text may bypass `STRINGS.ts`.
3. No value marked SUBSTITUTE may be used outside `src/crypto/backends/`.
4. Timing values in §5 are enforced by tests in `src/**/*.test.ts` where
   feasible.
5. Every field marked ❓ in §4 (visual) must be resolved before Phase 8
   (release gate).

---

*End of FAITHFULNESS.md.*
