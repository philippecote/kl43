# Email draft — Crypto Museum

**To:** info@cryptomuseum.com
**Subject:** KL-43C emulator — permission request and a small thank-you

---

Hello,

I'm a big fan of Crypto Museum — your KL-43 pages have been my main reference for a little hobby project I just finished, and I wanted to reach out before doing anything else with it.

I built a browser-based emulator of the TSEC/KL-43C. It's a personal thing; I've always been fascinated by these devices and always wanted one, so I made one for myself. It runs entirely client-side — keypad, 2×40 LCD, menus, key compartments, update chain, classification field, the whole operational flow — and (to my slight amazement) the Bell 103 FSK modem actually works: I sent a message from my iPhone to my laptop over the air last night, purely acoustically across a quiet room. No real Type 1 crypto, of course — I've included an LFSR nonlinear-combiner as a period-flavoured substitute plus AES-128-CTR as the default secure option, with clear warnings that none of it is interoperable with real equipment.

**Live demo:** <https://philippecote.github.io/kl43/>
**Source:** <https://github.com/philippecote/kl43>

A few things I'd love your help with:

1. **Permission to use one of your KL-43C photographs as the UI background.** I'm using it now in the hosted demo; the README credits Crypto Museum and links back to you, and the image is not part of the MIT-licensed source. If you'd rather I didn't use it, or if you'd prefer a specific credit line or a different/higher-resolution image, just say the word and I'll change whatever you'd like — or pull it and replace it with something I make myself. Whatever you're comfortable with.

2. **Would you take a quick look?** I'd love to know what I got right, what I got wrong, and especially what looks silly to someone who has actually seen one in the flesh. I've never handled a real unit or seen one in operation, so parts of the presentation are educated guesses from your photos and the TRW feature sheet.

3. **If you have a working KL-43 and could film a short clip of it in action**, even 20 seconds of it booting, beeping, and printing a menu — I would be thrilled. The sound design in particular is pure imagination at the moment (keypress clicks, beeper tones, the modem sync chirp), and I'd love to get it closer to the real thing. I know this is a big ask; no pressure at all if it's not practical.

Thank you for running the museum. It's one of my favourite corners of the internet, and the depth of documentation you've put up — especially for devices like this one where so much was classified for so long — is what made the project possible in the first place. I'll make a donation either way; you've earned it many times over.

Happy to make any changes you'd like, and happy to answer any questions about what's under the hood.

All the best,
Philippe Cote
pcote@stingray.com
