# MOJIOKO — Third-Party Licenses

MOJIOKO bundles the following third-party components.  Their licence
files live in this directory.  Users can reach this folder from the
**About** dialog → **Third-party licenses** link.

---

## ffmpeg / ffprobe (LGPL v3)

- **Distribution source**: Pre-built binaries from
  [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds/releases),
  flavour `win64-lgpl-shared`.  MOJIOKO ships them verbatim.
- **Upstream**: https://ffmpeg.org/
- **Licence**: GNU **Lesser General Public License, Version 3**
  (LGPL-3.0).
- **Component notice**: `ffmpeg-lgpl.txt` (build flags, source-
  availability, linking method, why this is v3 rather than v2.1).
- **Licence full text**: `lgpl-3.0.txt` (verbatim LGPL v3).
- **Supplementing GPL v3**: `gpl-3.0.txt` (verbatim GPL v3 — LGPL v3
  §0 incorporates GPL v3 by reference; LGPL v3 §4 requires the GPL
  text to accompany the binary as well).
- **Notes**:
  - This is an **LGPL-only** build.  `--enable-gpl` and
    `--enable-nonfree` are **disabled**.  GPL codecs (libx264,
    libx265, libxavs2, libxvid, frei0r, libdvdread, libdvdnav,
    librubberband, libvidstab, avisynth) and proprietary codecs
    (libfdk-aac) are explicitly disabled.
  - LGPL v3 (not v2.1) is required because the build statically
    incorporates GMP, libaribb24, and libzmq, which are LGPL v3 (or
    GPL v2 / LGPL v3 dual; we choose v3).  The configure flag
    `--enable-version3` upgrades LGPL v2.1-or-later code to v3 so
    the combined binary has a single, compatible licence.
  - DLLs (`avcodec`, `avdevice`, `avfilter`, `avformat`, `avutil`,
    `swresample`, `swscale`) ship next to `ffmpeg.exe` to satisfy
    LGPL v3 §4 (the user can replace them to relink against a
    modified FFmpeg).

### ffmpeg statically-linked subsystems used by MOJIOKO

MOJIOKO drives the FFmpeg `subtitles=` filter, which pulls in these
text/font subsystems.  They are statically incorporated into the
FFmpeg DLLs; their attribution files live here so the obligation to
include each licence travels with the binary:

| Component | Licence | File |
|---|---|---|
| libass | ISC | `libass-isc.txt` |
| libfreetype | FreeType License (FTL) | `freetype-ftl.txt` |
| libharfbuzz | "Old MIT" | `harfbuzz-mit.txt` |
| libfribidi | LGPL v2.1+ (this notice retains the v2.1 selection FriBidi originally ships under) | `fribidi-lgpl-2.1.txt` |
| fontconfig | MIT-style | `fontconfig-mit.txt` |

Other FFmpeg subsystems listed in the build configuration (zlib,
libxml2, libvmaf, libaom, libdav1d, libsvtav1, libvorbis, libopus,
libmp3lame, libwebp, libtheora, libvpx, libwhisper, ...) ship under
permissive or LGPL-compatible licences as documented at the
[BtbN/FFmpeg-Builds release page](https://github.com/BtbN/FFmpeg-Builds/releases)
and inside the [FFmpeg source tree](https://github.com/FFmpeg/FFmpeg).
MOJIOKO does not call them through their own API surface; they are
reached only via FFmpeg's command-line / filter API.

---

## faster-whisper (MIT)

- **Licence**: MIT
- **Source**: https://github.com/SYSTRAN/faster-whisper
- **File**: `faster-whisper-mit.txt`

---

## Electron (MIT)

- **Licence**: MIT
- **Source**: https://electronjs.org/
- **File**: `electron-mit.txt`
- **Notes**: Electron embeds Chromium (BSD-3-Clause) and Node.js
  (MIT, with bundled libuv MIT, V8 BSD, OpenSSL Apache-2.0).  Full
  attribution notices for those sub-components ride along with the
  Electron runtime that the user has on disk; this file documents
  only the top-level Electron licence.

---

## npm runtime dependencies

The application's renderer process is bundled with the following 31
packages from `dependencies` in `package.json`.

### Apache-2.0

| Package | Version | Notice |
|---|---|---|
| class-variance-authority | 0.7.1 | `class-variance-authority-apache-2.0.txt` |

Apache-2.0 §4(d) NOTICE: the upstream package does **not** ship a
NOTICE file, so no additional NOTICE attribution is required.

### ISC

| Package | Version | Notice |
|---|---|---|
| lucide-react | 0.400.0 | `lucide-react-isc.txt` |

### MIT (29 packages — each licence header retained verbatim within bundled JS source comments)

| Package | Version |
|---|---|
| @radix-ui/react-checkbox | 1.3.3 |
| @radix-ui/react-dialog | 1.1.15 |
| @radix-ui/react-dropdown-menu | 2.1.16 |
| @radix-ui/react-label | 2.1.8 |
| @radix-ui/react-popover | 1.1.15 |
| @radix-ui/react-scroll-area | 1.2.10 |
| @radix-ui/react-select | 2.2.6 |
| @radix-ui/react-separator | 1.1.8 |
| @radix-ui/react-slot | 1.2.4 |
| @radix-ui/react-switch | 1.2.6 |
| @radix-ui/react-tabs | 1.1.13 |
| @radix-ui/react-tooltip | 1.2.8 |
| clsx | 2.1.1 |
| electron-log | 5.4.4 |
| framer-motion | 11.18.2 |
| i18next | 23.16.8 |
| opentype.js | 2.0.0 |
| react | 18.3.1 |
| react-colorful | 5.7.0 |
| react-dom | 18.3.1 |
| react-hook-form | 7.76.0 |
| react-hotkeys-hook | 4.6.2 |
| react-i18next | 14.1.3 |
| react-router-dom | 6.30.3 |
| sonner | 1.7.4 |
| tailwind-merge | 2.6.1 |
| tailwindcss-animate | 1.0.7 |
| zod | 3.25.76 |
| zustand | 4.5.7 |

Each of those packages is distributed under the standard MIT
licence.  React's licence text is reproduced as `react-mit.txt`
(this folder) as a representative example.  The corresponding
`node_modules/<pkg>/LICENSE` file for every package above is the
authoritative per-package text and is available in the source
repository at `<repo>\node_modules\<pkg>\LICENSE`, as well
as at each upstream's homepage.

---

## Whisper models (OpenAI / SYSTRAN — MIT)

Whisper models are subject to the MIT License:

  https://github.com/openai/whisper/blob/main/LICENSE

The faster-whisper int8 quantised models hosted on Hugging Face by
SYSTRAN are redistributions of those weights under the same MIT
licence.

---

## Python sidecar runtime dependencies

The `mojioko-transcriber.exe` sidecar is a PyInstaller `--onedir`
freeze of `python-sidecar/main.py` and pulls in the following
Python packages transitively via `faster-whisper==1.2.1`.  Each
package's per-distribution licence text is shipped under
`resources/bin/transcriber/_internal/<package>-<version>.dist-info/
LICENSE*` inside the installer, so the licence obligations travel
with the binary at the file level; this section is the aggregated
index for the same set.

| Package | Version | Licence | Notes |
|---|---|---|---|
| faster-whisper | 1.2.1 | MIT | Wraps CTranslate2 for Whisper inference. |
| ctranslate2 | 4.8.0 | MIT | C++ inference engine. |
| onnxruntime | 1.27.0 | MIT | Used for VAD and auxiliary ONNX graphs. |
| tokenizers | 0.23.1 | Apache-2.0 | HuggingFace tokenizer. |
| huggingface-hub | 1.20.1 | Apache-2.0 | Model download client. |
| av (PyAV) | 17.1.0 | BSD-3-Clause | ffmpeg Python bindings used for audio decode. |
| numpy | 2.4.6 | BSD-3-Clause (with 0BSD / MIT / Zlib / CC0-1.0 for vendored parts) | Numeric arrays. |
| click | 8.4.1 | BSD-3-Clause | CLI argument parsing pulled in transitively. |
| tqdm | 4.68.3 | MPL-2.0 AND MIT | Progress bar; only the MIT parts are exercised at runtime. |

None of these transitive dependencies impose GPL-style copyleft on
the surrounding MOJIOKO product — the strictest is MPL-2.0 (tqdm),
which is a per-file weak-copyleft licence and does not extend to
the rest of the sidecar because the tqdm sources ship unmodified.

`python-sidecar/requirements.txt` pins only `faster-whisper==1.2.1`
directly; every other row above is a transitive dependency
selected by pip at PyInstaller build time.  The authoritative
per-package licence text is the `LICENSE` file inside each
`*.dist-info` directory next to the sidecar exe.

---

## Bundled fonts

### Noto Sans JP (SIL OFL v1.1)

- **Licence**: SIL Open Font License, Version 1.1
- **Source**: https://fonts.google.com/noto/specimen/Noto+Sans+JP
- **File**: `noto-sans-jp-ofl.txt` (verbatim OFL.txt taken from
  https://github.com/google/fonts/raw/main/ofl/notosansjp/OFL.txt)
- **Notes**: The same OFL.txt also ships next to the font files at
  `resources/fonts/Noto_Sans_JP/OFL.txt` so the licence travels with
  the font binary (OFL §3.2).  Copyright Adobe (Source Han Sans) /
  Google / The Noto Project authors.

### Downloaded subtitle fonts (SIL OFL v1.1)

The fonts available via the in-app picker are all distributed under
the SIL Open Font License v1.1.  Two groups ship in the `fonts-v1`
GitHub release:

- **Japanese display faces (8)** — Dela Gothic One, Reggae One,
  Yusei Magic, Mochiy Pop One, Hachi Maru Pop, Potta One,
  DotGothic16, Rampart One.
- **Latin display / sans faces (4, added in REQ-0153)** — Anton,
  Bebas Neue, Montserrat, Poppins.

Each download bundles its own `OFL.txt` verbatim next to the TTF in
`%APPDATA%/MOJIOKO/fonts/<font-id>/`.  The verbatim per-font
`<Font>-OFL.txt` originates from `google/fonts/ofl/<name>/OFL.txt`
and carries that font's own copyright header followed by the
standard SIL OFL v1.1 body, so OFL §2 ("each copy contains the
above copyright notice and this license") is satisfied at the
distributed-file level.  Attribution and licence text for every
font (bundled and downloaded) is also viewable in-app under
**About → Font licenses**.  Tier gating: the free (GitHub) edition
runs only on the bundled Noto Sans JP; the paid (Microsoft Store)
edition unlocks all 12 downloadable fonts.  See
`src/renderer/lib/font-tier.ts` for the policy.

---

## File index

```
ffmpeg-lgpl.txt                          (FFmpeg per-component notice)
lgpl-3.0.txt                             (GNU LGPL v3 verbatim full text)
gpl-3.0.txt                              (GNU GPL v3 verbatim — LGPL v3 §0)
libass-isc.txt                           (libass ISC)
freetype-ftl.txt                         (libfreetype FTL)
harfbuzz-mit.txt                         (libharfbuzz Old MIT)
fontconfig-mit.txt                       (fontconfig MIT-style)
fribidi-lgpl-2.1.txt                     (libfribidi LGPL v2.1+)
faster-whisper-mit.txt                   (faster-whisper MIT — see also the Python
                                          sidecar transitive-dependency table above
                                          for ctranslate2, onnxruntime, tokenizers,
                                          huggingface-hub, av, numpy, click, tqdm)
electron-mit.txt                         (Electron MIT)
react-mit.txt                            (React MIT — also representative for the 29 MIT npm pkgs)
class-variance-authority-apache-2.0.txt  (Apache-2.0)
lucide-react-isc.txt                     (ISC)
noto-sans-jp-ofl.txt                     (Noto Sans JP SIL OFL v1.1 — bundled font)
README.md                                (this file)
```

Per-font `<Font>-OFL.txt` files for the 12 downloadable fonts
(Dela Gothic One, Reggae One, Yusei Magic, Mochiy Pop One, Hachi
Maru Pop, Potta One, DotGothic16, Rampart One, Anton, Bebas Neue,
Montserrat, Poppins) are fetched with the TTF and land at
`%APPDATA%/MOJIOKO/fonts/<font-id>/OFL.txt` on the user's disk;
they are not part of the installer payload.

Per-Python-package licence files ship next to the sidecar binary
at `resources/bin/transcriber/_internal/<package>-<version>.dist-info/
LICENSE*` and are copied verbatim by PyInstaller — they are not
duplicated in this folder.

---

## FreeType attribution

Portions of MOJIOKO are built on the FreeType text rendering
library (statically incorporated into the shipped FFmpeg
libraries).  The FreeType License requires the following credit
line to accompany the software:

> Portions of this software are copyright © 2006-2026 The FreeType
> Project (https://freetype.org).  All rights reserved.
