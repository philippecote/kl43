# KL-43C Emulator

A faithful functional and visual emulator of the **TSEC/KL-43C** secure text
terminal — the portable "AutoManual System" text-encryption device built by
TRW EPI Inc. and used by US and allied forces from the mid-1980s through its
official retirement in **May 2013**.

The emulator reproduces the look, keypad, menus, displays, Bell 103 FSK
modem behaviour, and operational procedures of the original device. It is a
historical re-creation for educational and entertainment purposes.

**Live demo:** <https://philippecote.github.io/kl43/>

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

- Full 2 × 40 LCD, 59-key rubber-dome keypad, and rendered device plate.
- Boot self-test, main menu, message composition, review, encrypt / decrypt,
  key management, authentication mode, clock, and zeroize flows.
- Dual message slots (A, B) with classification header per MANUAL p.12.
- Three pluggable crypto backends behind a single `CryptoBackend` interface,
  runtime-selectable from the app menu.
- Bell 103 FSK modem (300 baud) over WebAudio for over-the-air acoustic
  coupling between two browsers, with a live-tunable receiver gate.
- Reed–Solomon FEC on the ciphertext stream.
- 329+ unit tests covering cipher primitives, framing, state machine, UART,
  and two-station round-trip integration.

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

Open the demo URL in two browser windows (or on two devices). On each, set
up the same key and cipher backend (`Cipher` menu), compose on one, select
`Comms → Acoustic → Transmit`, and on the other `Comms → Acoustic →
Receive`. Acoustic coupling between phone speaker and laptop microphone
works; for clean loopback on one machine, route audio via
[BlackHole](https://existential.audio/blackhole/) or similar. The **Modem**
menu exposes live sensitivity sliders if reception is marginal.

---

## Documentation

- [`docs/SPEC.md`](./docs/SPEC.md) — full functional and visual specification.
- [`docs/SPEC_addendum_A_cipher.md`](./docs/SPEC_addendum_A_cipher.md) —
  cipher backend design (LFSR-NLC, AES-128-CTR, DES-56-CBC).
- [`docs/FAITHFULNESS.md`](./docs/FAITHFULNESS.md) — what is accurate to the
  real device, what is deliberate divergence, and why.
- [`docs/SPEC_DELTA.md`](./docs/SPEC_DELTA.md) — running log of spec changes
  and rationale as manual evidence accumulated.
- [`reference/`](./reference) — primary source material: the 1991 operator's
  manual (KL43C_manual_F_19910815.pdf), the 1994 Dutch KL royal army
  instruction card (KL43C_IK004164_19940502.pdf), the TRW feature
  comparison sheet (KL43_features.pdf), and the Crypto Museum reference
  photograph used for the device plate.

---

## Image credits and attribution

The background plate and several UI reference images used in this project
are photographs of a real KL-43C that appear on the Crypto Museum website.

> **Image © Crypto Museum (cryptomuseum.com). Used with permission.**
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
