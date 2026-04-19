# KL-43C Emulator

A faithful functional and visual emulator of the **TSEC/KL-43C** secure text terminal — the portable "AutoManual System" text-encryption device built by TRW EPI Inc. and used by US and allied forces from the mid-1980s through its official retirement in **May 2013**.

This is a historical re-creation built for educational and entertainment purposes. It reproduces the look, keypad, menus, displays, FSK modem behaviour, and operational procedures of the original device.

### Live demo

Try it in your browser: **<https://philippecote.github.io/kl43/>**

---

## Disclaimer

**This emulator does NOT implement the classified NSA Type 1 algorithm used by the real TSEC/KL-43C, and it is NOT interoperable with any real cryptographic equipment.**

The ciphers included in this project are historical or educational substitutes:

- **LFSR-NLC** — a nonlinear-combiner stream cipher shaped like a declassified SAVILLE-era design. Provided for historical feel only. **Not cryptographically secure.**
- **AES-128-CTR** — a modern, secure substitute (recommended default).
- **DES-56-CBC** — included only to mirror the export-variant Datotek XMP-500. Clearly labelled as insecure.

**Do not use this software to protect real sensitive information.** It is a prop and a teaching tool.

---

## Image credits and attribution

The background plate and several UI reference images used in this project are photographs of a real KL-43C that appear on the Crypto Museum website.

> **Image © Crypto Museum (cryptomuseum.com). Used with permission.**
> Source: <https://www.cryptomuseum.com/crypto/usa/kl43/>

Crypto Museum is a non-profit foundation dedicated to preserving the history of cryptography. If you enjoy this emulator, please consider [supporting their work](https://www.cryptomuseum.com/intro/donate.htm) — every piece of public documentation about the KL-43 used in this project came from them.

All documentation references (operator's manual excerpts, TRW feature sheet, photos of the keypad, display, and enclosure) are cited throughout the specification documents with links back to Crypto Museum.

### Other sources

- **TRW EPI Inc.** — original manufacturer (later acquired by Northrop Grumman). The boot banner reproduces period branding nominatively; no affiliation or endorsement is implied.
- **NSA / US Government** — the TSEC/KL-43 nomenclature is used factually. No affiliation or endorsement is implied. The NSA seal and other government insignia are **not** used in this project.

---

## Status

- Official device retirement: **May 2013**
- Hardware and nomenclature: unclassified
- Classified Type 1 algorithm: **not implemented, not present in this codebase**
- Export control: none applicable (no Type 1 crypto; AES/DES publicly available under EAR §734.7)

---

## Getting started

```bash
npm install
npm run dev
```

Then open the printed URL in a browser. The emulator runs entirely client-side.

### Running tests

```bash
npm test
```

---

## Documentation

- [`KL43_emulator_spec.md`](./KL43_emulator_spec.md) — full functional and visual specification
- [`KL43_emulator_spec_addendum_A_cipher.md`](./KL43_emulator_spec_addendum_A_cipher.md) — cipher backend specification (LFSR-NLC, AES-128-CTR, DES-56-CBC)
- [`FAITHFULNESS.md`](./FAITHFULNESS.md) — notes on what is accurate to the real device and what is deliberate divergence
- [`SPEC_DELTA.md`](./SPEC_DELTA.md) — running log of spec changes and rationale

---

## Licence

MIT — see [`LICENSE`](./LICENSE).

Note: the MIT licence covers only the source code in this repository. Images and documents credited above remain the property of their respective owners and are used under the terms granted to this project.
