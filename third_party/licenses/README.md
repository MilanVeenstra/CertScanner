# Third-party licence texts for libraries linked into the bundled WebAssembly

`tesseract.js-core` 7.0.0 (Apache-2.0) statically links several C libraries into
`tesseract-core-simd-lstm.wasm`, and `zxing-wasm` 3.1.5's `zxing_reader.wasm` is built from
zxing-cpp. Their licences require these notices to ship with binary redistributions.
`scripts/build.mjs` copies this directory to `dist/vendor/licenses/`, and `--check` fails if
any file is missing.

Upstream versions were identified by the release manager on 2026-10-10 from tesseract.js-core
v7.0.0's `.gitmodules`/build scripts and zxing-wasm v3.1.5's zxing-cpp submodule, and
cross-checked against strings in the shipped WASM where possible.

| File | Component (upstream revision) | Evidence in the binary | Source of the text |
|---|---|---|---|
| `leptonica.BSD-2-Clause.txt` | Leptonica (`4af068b`) | `leptonica-%d.%d.%d` | Upstream `leptonica-license.txt` |
| `libjpeg-9a.IJG-legal.txt` | IJG libjpeg 9a (LuaDist `6c0fcb8`) | `Copyright (C) 2014, Thomas G. Lane, Guido Vollbeding` | Upstream README "LEGAL ISSUES" section (contains the required IJG acknowledgement) |
| `libpng-1.6.38.PNG-v2.txt` | libpng 1.6.38 (`a37d483`) | `1.6.38.git` | Upstream `LICENSE` (PNG Reference Library License v2) |
| `libtiff.COPYRIGHT.txt` | LibTIFF (`b51bb15`) | `libtiff does not allow …` | Upstream `COPYRIGHT` |
| `zlib-1.2.12.txt` | zlib 1.2.12 (`21767c6`) | `1.2.12` | Licence comment at the top of upstream `zlib.h` |
| `giflib.COPYING.txt` | giflib (`fa37672`) | GIF decoder symbols | Upstream `COPYING` |
| `libwebp.COPYING.txt`, `libwebp.PATENTS.txt` | libwebp (`20ef03e`) | `WebP decode failed`, `VP8L` | Upstream `COPYING` and `PATENTS` |
| `openlibm.LICENSE.md` | openlibm (`ae2d916`) | on the link line (presence in the binary not confirmed) | Upstream `LICENSE.md` |
| `zxing-cpp.Apache-2.0.txt` | zxing-cpp (`2ecec3f`) | `ZXing::` symbols | Upstream `LICENSE` |
| `libzueci.BSD-3-Clause.txt` | libzueci (bundled in zxing-cpp) | ECI handling in zxing-cpp | Upstream `zueci.h` copyright + SPDX `BSD-3-Clause` identifier; standard BSD-3-Clause text |

Tesseract itself (Apache-2.0) is covered by `vendor/tesseract/LICENSE-tesseract.js-core.txt`.

This is a text comparison, not legal advice. Re-run the comparison whenever a vendor version changes.
