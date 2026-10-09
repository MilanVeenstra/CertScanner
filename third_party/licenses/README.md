# Third-party licence texts for libraries linked into the bundled WebAssembly

`tesseract.js-core` (Apache-2.0) statically links several C libraries into
`tesseract-core-simd-lstm.wasm`, and `zxing-wasm`'s `zxing_reader.wasm` is built from
zxing-cpp. Their licences require the notices below to ship with binary redistributions.
`scripts/build.mjs` copies this directory to `dist/vendor/licenses/` and `--check` fails
if any file is missing.

| File | Component | Identified in the binary by | Source of the text |
|---|---|---|---|
| `leptonica.BSD-2-Clause.txt` | Leptonica | `leptonica-%d.%d.%d` | Standard BSD-2-Clause text with Leptonica's copyright line |
| `libjpeg-turbo-and-IJG.debian-copyright.txt` | IJG libjpeg ("This software is based in part on the work of the Independent JPEG Group") | `Copyright (C) 2014, Thomas G. Lane, Guido Vollbeding` | Debian `libjpeg-turbo8` copyright file (contains the IJG licence) |
| `libpng.debian-copyright.txt` | libpng 1.6.x | `1.6.38.git`, `libpng error` | Debian `libpng16-16t64` copyright file |
| `libtiff.debian-copyright.txt` | LibTIFF | `libtiff does not allow …` | Debian `libtiff6` copyright file |
| `zlib.debian-copyright.txt` | zlib | inflate/deflate symbols via libpng | Debian `zlib1g` copyright file |
| `zxing-cpp.Apache-2.0.txt` | zxing-cpp | `ZXing::` symbols | Apache License 2.0 text (`/usr/share/common-licenses/Apache-2.0`) |

**Release gate:** these texts were copied from the build machine's Debian packaging files on
2026-10-09, not from the exact upstream versions compiled into tesseract.js-core 7.0.0 /
zxing-wasm 3.1.5. The release manager must compare them with the upstream licence files of
those versions before publishing.
