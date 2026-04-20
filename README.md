# KL-43C Emulator

A faithful functional and visual emulator of the **TSEC/KL-43C** secure text
terminal — the portable "AutoManual System" text-encryption device built by
TRW EPI Inc. and used by US and allied forces from the mid-1980s through its
official retirement in **May 2013**.

## Try it now

### ▶ Live demo: <https://philippecote.github.io/kl43/>

> **Tip — how to start:** the device lands powered off, just like the real
> one. Tap (or click) the **`SRCH`** key in the top-right corner of the
> keypad to turn it on, then press **`Y`** within 15 seconds to confirm
> boot. From there, letters and digits on your physical keyboard map
> straight to the keypad; `Enter` is `ENTER`, `Esc` is `XIT`, `Backspace`
> is `DCH`. `Ctrl` / `Cmd` + `C` in the editor or Review copies the
> current message (plaintext or cipher groups) to the clipboard; paste
> works anywhere you'd type. There is no in-app walkthrough — the
> operator's manual (linked in the topbar) is still the authoritative
> guide, as it was in 1991.

Open the demo on **two phones, two laptops, or one of each** — anything with
a browser, a speaker, and a microphone. Pick the same key and cipher backend
on both devices, compose on one, point its speaker at the other's mic, press
`Comms → Audio → Acoustic → Transmit` on the sender and
`Comms → Audio → Acoustic → Receive` on the listener, and watch your
encrypted text cross the room as **300 baud Bell 103 FSK tones** — the
same acoustic-coupler protocol the real KL-43C used to talk through 1980s
telephone handsets.

This is not a simulation of a modem. It **is** a modem. The chirps coming
out of your speaker are the exact mark/space tone pairs the original
device emitted (1270/1070 Hz on the originating side, 2225/2025 Hz on the
answering side). You can record them, mail the audio file to a friend,
hold one phone next to another phone on a call, or pipe them through
anything that preserves a ~1 kHz bandwidth audio path — they will still
decode on the other end. The receiver demodulates with a software
Goertzel filter, feeds the bytes through the cipher and Reed–Solomon
error correction, and drops the plaintext into its message buffer, just
like the operator at the far end of a Cold War radio patch would have
seen. Latency, tones, group framing, and `ZZZZ` end-of-message sentinel
are all period-accurate.

## A note on faithfulness

I have never seen or held a real KL-43C. Everything in this project is
reconstructed from public sources: the 1991 TRW operator's manual, a 1994
Dutch Royal Army instruction card, the TRW feature-comparison sheet, and
the photographs on [Crypto Museum](https://www.cryptomuseum.com/crypto/usa/kl43/).
Every screen prompt, every menu flow, every tone pair, every timeout has
been cross-referenced against those documents and marked `[SUBSTITUTE]`
in code and docs wherever the manual is silent. `docs/FAITHFULNESS.md` is
an honest tally of what's accurate, what's approximate, and what's
guessed.

If you have used a real KL-43, or have better photographs, firmware
dumps, training films, or any other primary material, please
[open an issue](https://github.com/philippecote/kl43/issues) — I would
love to bring this closer to the metal.

---

## Contents

- [Disclaimer](#disclaimer)
- [Features](#features)
- [Getting started](#getting-started)
- [Documentation](#documentation)
- [Image credits and attribution](#image-credits-and-attribution)
- [Licence](#licence)

---

## Disclaimer

**This emulator does NOT implement the classified NSA Type 1 algorithm used
by the real TSEC/KL-43C, and it is NOT interoperable with any real
cryptographic equipment.**

The ciphers included in this project are historical or educational
substitutes:

- **LFSR-NLC** — a nonlinear-combiner stream cipher shaped like a
  declassified SAVILLE-era design. Provided for historical feel only.
  **Not cryptographically secure.**
- **AES-128-CTR** — a modern, secure substitute.
- **DES-56-CBC** — included only to mirror the export-variant Datotek
  XMP-500. Clearly labelled as insecure.

**Do not use this software to protect real sensitive information.** It is a
prop and a teaching tool.

Status:

- Official device retirement: **May 2013**
- Hardware and nomenclature: unclassified
- Classified Type 1 algorithm: **not implemented, not present in this codebase**
- Export control: none applicable (no Type 1 crypto; AES/DES publicly
  available under EAR §734.7)

---

## Features

- Full 2 × 40 LCD, 59-key rubber-dome keypad, and rendered device plate
  (built over a Crypto Museum reference photograph).
- Boot self-test, main menu, message composition, review, encrypt / decrypt,
  key management, time-bucketed authentication, clock, and zeroize flows —
  all traced to specific pages of the TRW operator's manual.
- Dual message slots (A, B) with classification header per MANUAL p.12.
- Verbal phonetic readout (MANUAL Appendix C) for reading cipher groups
  aloud over a voice channel — press `SRCH` inside Review.
- Mock TP-40S printed scroll for the P menu, with torn thermal-paper edge.
- Three pluggable crypto backends behind a single `CryptoBackend` interface,
  runtime-selectable from the app menu: **LFSR-NLC** (SAVILLE-shaped),
  **AES-128-CTR**, and **DES-56-CBC** (XMP-500 compatibility feel).
- **Bell 103 FSK modem** (300 baud, full Goertzel demodulator) over
  WebAudio for real over-the-air acoustic coupling between two browsers,
  with a live-tunable receiver gate exposed in the Modem menu.
- Reed–Solomon FEC on the ciphertext stream, base32 (`A–Z + 2–7`) group
  framing, `ZZZZ` end-of-message sentinel.
- 331+ unit tests covering cipher primitives, framing, state machine,
  UART, and two-station round-trip integration.

---

## Getting started

### Run locally

```bash
npm install
npm run dev
```

Open the printed URL in a browser. The emulator runs entirely client-side.

### Tests and typecheck

```bash
npm test           # vitest, one-shot
npm run test:watch # vitest, watch mode
npm run typecheck  # tsc --noEmit
npm run build      # typecheck + vite build into dist/
```

### Two-station setup

Open the [live demo](https://philippecote.github.io/kl43/) in two browser
windows or on two devices. On each, set the **same cipher backend**
(`Cipher` menu) and load the **same key** (use the `Key Generator` menu
to mint one and `Type into device`). Compose a message on station A with
`W → A`, encrypt with `E → A → Y`, then:

- Sender: `Comms → Audio Data → Acoustic Coupler → Transmit → U.S. Lines`,
  select slot `A`, press `ENTER` to begin. Hold its speaker near the
  receiver's mic.
- Receiver: `Comms → Audio Data → Acoustic Coupler → Receive`. The LCD
  flips from *Waiting for Carrier* to *Receiving Message* the moment the
  first byte lands.
- After carrier loss, the receiver decrypts (`D → A → Y`) and shows the
  plaintext on `R → A`.

For silent single-machine loopback, route audio via
[BlackHole](https://existential.audio/blackhole/) or similar. The **Modem**
menu exposes live sensitivity sliders if ambient noise is defeating
acquisition.

---

## Documentation

- [`docs/SPEC.md`](./docs/SPEC.md) — full functional and visual specification
  (v2.0). Appendix A folds in the manual-driven corrections; Appendix B is the
  cipher backend decision record (LFSR-NLC, AES-128-CTR, DES-56-CBC).
- [`docs/FAITHFULNESS.md`](./docs/FAITHFULNESS.md) — living register of what is
  accurate to the real device, what is deliberate divergence, and why.
- [`reference/`](./reference) — primary source material: the 1991 operator's
  manual (KL43C_manual_F_19910815.pdf), the 1994 Dutch KL royal army
  instruction card (KL43C_IK004164_19940502.pdf), the TRW feature
  comparison sheet (KL43_features.pdf), and the Crypto Museum reference
  photograph used for the device plate.

---

## Image credits and attribution

The background plate and several UI reference images used in this project
are photographs of a real KL-43C that appear on the Crypto Museum website.

> **Image © Crypto Museum (cryptomuseum.com). Used with the express
> permission of Paul Reuvers, Curator (April 2026).**
> Source: <https://www.cryptomuseum.com/crypto/usa/kl43/>

Crypto Museum is a non-profit foundation dedicated to preserving the
history of cryptography. If you enjoy this emulator, please consider
[supporting their work](https://www.cryptomuseum.com/intro/donate.htm) —
every piece of public documentation about the KL-43 used in this project
came from them.

All documentation references (operator's manual excerpts, TRW feature
sheet, photos of the keypad, display, and enclosure) are cited throughout
the specification documents with links back to Crypto Museum.

Other sources:

- **TRW EPI Inc.** — original manufacturer (later acquired by Northrop
  Grumman). The boot banner reproduces period branding nominatively; no
  affiliation or endorsement is implied.
- **NSA / US Government** — the TSEC/KL-43 nomenclature is used factually.
  No affiliation or endorsement is implied. The NSA seal and other
  government insignia are **not** used in this project.

---

## Licence

MIT — see [`LICENSE`](./LICENSE).

The MIT licence covers only the source code in this repository. Images and
documents credited above remain the property of their respective owners and
are used under the terms granted to this project.
