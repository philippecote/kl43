// Thin wrapper around `qrcode-generator` so the rest of the host doesn't
// have to deal with the library's factory-function shape. Renders directly
// as an inline SVG into a container element — no canvas, no PNG bytes,
// scales cleanly in CSS.
//
// The URLs we encode (share links) fit well under ~300 bytes, so we let
// the library auto-size (typeNumber=0) at medium ECC which is the normal
// default for link-style payloads.

import qrcodeGenerator from "qrcode-generator";

export function renderQrInto(container: HTMLElement, text: string): void {
  const qr = qrcodeGenerator(0, "M");
  qr.addData(text, "Byte");
  qr.make();
  container.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}
