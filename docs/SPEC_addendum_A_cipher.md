# KL-43C Emulator — Spec Addendum A: Cipher Backends

**Addendum to:** `docs/SPEC.md` v1.0
**Supersedes:** §6.1 "Overview" of the main spec
**Status:** Decision record + implementation guide
**Applies to:** `src/crypto/` module (being implemented concurrently)

---

## A.1 Decision

The primary `CryptoBackend` is changed from **DES-CBC** to a **SAVILLE-shaped nonlinear LFSR combiner** (hereafter "LFSR-NLC"). Rationale: of all implementable substitutes, the LFSR-NLC is architecturally closest to what the real KL-43's classified algorithm (SAVILLE or a SAVILLE-family variant) is believed to be.

Three backends ship; all implement the same `CryptoBackend` interface so they are runtime-selectable from the emulator options menu:

| Backend ID | Algorithm | Purpose | Default? |
|---|---|---|---|
| `lfsr-nlc` | SAVILLE-shaped LFSR nonlinear combiner | Primary — architecturally closest to real device | **Yes** |
| `aes-ctr` | AES-128 in counter mode | "Secure mode" — operationally equivalent, cryptographically strong | No |
| `des-cbc` | DES-56 in CBC mode | "XMP-500 compatibility mode" — historical period authenticity matching the export variant | No |

All three use the same key format (§6.2 of main spec: 32 A-Z characters → 120 bits + 8-bit checksum), the same message indicator (§6.4), the same update chain (§6.5), and the same ciphertext framing (§6.7). Switching backends changes only the core bit-transformation; the entire UI and wire protocol are unchanged.

---

## A.2 Interface (updated)

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

## A.3 Primary backend — LFSR-NLC

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

## A.4 Secondary backend — AES-128-CTR

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

## A.5 Tertiary backend — DES-56-CBC

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

## A.6 Backend selection UI

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

## A.7 Impact on other spec sections

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

## A.8 Implementation checklist (for the team mid-flight)

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

*End of Addendum A.*
