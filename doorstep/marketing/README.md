# Doorstep pamphlet

Six pages that showcase Doorstep, built from real screens of the demo.

| File | Use it for |
|---|---|
| `Doorstep-Pamphlet-PRINT-CMYK.pdf` | **Professional / offset printing.** CMYK, US Letter trim (8.5 × 11 in) with 0.125 in bleed on every side (8.75 × 11.25 in sheet). TrimBox and BleedBox are set. |
| `Doorstep-Pamphlet-PRINT-bleed.pdf` | **Online and digital printers** (Vistaprint, Staples, FedEx Office…) that ask for RGB with bleed. Same size and boxes. |
| `Doorstep-Pamphlet-SCREEN.pdf` | Full quality, Letter, no bleed: for printing at home and for sharing. |
| `Doorstep-Pamphlet-EMAIL.pdf` | Smaller file (≈1.5 MB) for email and the web. |

## What to tell the printer
- Trim size **8.5 × 11 in**, bleed **0.125 in**, no crop marks (the PDF's TrimBox marks the cut).
- 6 pages, single sheets or stapled. For a folded booklet, add 2 pages (a booklet needs a multiple of 4).
- Paper: 100 lb gloss text (or 80 lb cover for a sturdier feel), full color on both sides.
- Screenshots are at about 330 ppi at print size. Fonts are embedded.

## Rebuild after changing the app
1. Serve the repo (`python3 -m http.server 8080`), reset the demo, then run `node shoot-screens.js <James's tenant token>` to retake the screens into `img/`.
2. Edit `pamphlet.html`. `pamphlet-print.html` is the same design with the bleed CSS added at the end of its `<style>`.
3. Run `node render-all.js` (print RGB and screen), then convert to CMYK and email size with Ghostscript:
   ```bash
   gs -q -o Doorstep-Pamphlet-PRINT-CMYK.pdf -sDEVICE=pdfwrite -dPDFSETTINGS=/prepress -sColorConversionStrategy=CMYK -sProcessColorModel=DeviceCMYK Doorstep-Pamphlet-PRINT-bleed.pdf
   ```
   ```bash
   gs -q -o Doorstep-Pamphlet-EMAIL.pdf -sDEVICE=pdfwrite -dPDFSETTINGS=/ebook -dColorImageResolution=150 Doorstep-Pamphlet-SCREEN.pdf
   ```
4. `og.html` is the source of `../og.png`, the 1200×630 link-preview image.

The QR code (`img/qr.svg`) opens https://upliftdigitalpartners.github.io/lynbrook/doorstep/. Regenerate it if the address changes.
