# MOJIOKO — Third-Party Licenses

MOJIOKO bundles the following third-party components. Their licenses are
included in this directory.  The user can reach this folder from the
**About** dialog → **Third-party licenses** link.

---

## ffmpeg / ffprobe (LGPL v2.1)

- **License**: GNU Lesser General Public License, Version 2.1 (LGPL-2.1)
- **Source**: https://ffmpeg.org/
- **Component notice**: `ffmpeg-lgpl.txt` (FFmpeg-specific copyright,
  build flags, linking method, how to relink, source-availability
  pointer)
- **License full text**: `lgpl-2.1.txt` (verbatim GNU LGPL v2.1 from
  https://www.gnu.org/licenses/old-licenses/lgpl-2.1.txt)
- **Notes**:
  - MOJIOKO uses LGPL-only builds of ffmpeg and ffprobe.  No GPL or
    nonfree components are linked in (no `--enable-gpl`, no
    `--enable-nonfree`).
  - The binaries are linked **dynamically** via shared libraries
    (`avcodec*.dll`, `avdevice*.dll`, `avfilter*.dll`,
    `avformat*.dll`, `avutil*.dll`, `swresample*.dll`,
    `swscale*.dll`) shipped next to `ffmpeg.exe`.  This satisfies
    LGPL §6(b) — a user can replace those .dlls with a custom
    FFmpeg build of the same major version / ABI.
  - No source modifications were made by the MOJIOKO project.

---

## libass (ISC)

- **License**: ISC License
- **Source**: https://github.com/libass/libass
- **File**: `libass-isc.txt` (verbatim COPYING from upstream)
- **Notes**: MOJIOKO uses libass through ffmpeg's `subtitles=` filter
  for ASS subtitle burn-in.  Whether libass is linked statically into
  the bundled ffmpeg binaries or shipped as a separate DLL depends on
  the upstream FFmpeg build flavour shipped in `resources/bin/ffmpeg/`.
  Either way, the ISC notice is reproduced here.

---

## faster-whisper (MIT)

- **License**: MIT
- **Source**: https://github.com/SYSTRAN/faster-whisper
- **File**: `faster-whisper-mit.txt`

---

## Electron (MIT)

- **License**: MIT
- **Source**: https://electronjs.org/
- **File**: `electron-mit.txt`
- **Notes**: Electron embeds Chromium (BSD-3-Clause) and Node.js
  (MIT, with bundled libuv MIT, V8 BSD, OpenSSL Apache-2.0).  Full
  attribution notices for those sub-components ride along with the
  Electron runtime that the user has on disk; this file documents
  only the top-level Electron licence.

---

## React (MIT)

- **License**: MIT
- **Source**: https://reactjs.org/
- **File**: `react-mit.txt`

---

## Other npm dependencies (MIT / ISC / BSD / Apache 2.0)

All other npm dependencies used at runtime are distributed under
permissive licences (MIT, ISC, BSD-2/3, or Apache 2.0).  The
authoritative list is the `dependencies` block of `package.json` in
the source repository.  Key runtime modules include:

- `@radix-ui/*` (MIT) — UI primitives for the shadcn-style design
- `framer-motion` (MIT) — animation engine
- `react-i18next` / `i18next` (MIT) — localisation
- `react-hook-form` / `zod` (MIT) — forms and validation
- `zustand` (MIT) — state management
- `tailwind-merge` / `clsx` / `class-variance-authority` (MIT) — styling
  helpers
- `lucide-react` (ISC) — icons
- `sonner` (MIT) — toasts
- `react-hotkeys-hook` (MIT) — keyboard shortcuts
- `opentype.js` (MIT) — font metric reader used by the overflow
  calculator
- `react-colorful` (MIT) — colour picker
- `electron-log` (MIT) — main-process logger
- `react-router-dom` (MIT) — routing

Each of those packages carries its own LICENCE file inside its
`node_modules/<pkg>/` directory; the MOJIOKO installer does not
re-bundle every file individually but the source-repository
`node_modules/` retains them verbatim during build.

---

## Whisper models (OpenAI / SYSTRAN — MIT)

Whisper models are subject to the MIT License:

  https://github.com/openai/whisper/blob/main/LICENSE

The faster-whisper int8 quantised models hosted on Hugging Face by
SYSTRAN are redistributions of those weights under the same MIT
licence.

---

## Bundled fonts

### Noto Sans JP (SIL OFL v1.1)

- **License**: SIL Open Font License, Version 1.1
- **Source**: https://fonts.google.com/noto/specimen/Noto+Sans+JP
- **File**: `noto-sans-jp-ofl.txt` (verbatim OFL.txt taken from
  https://github.com/google/fonts/raw/main/ofl/notosansjp/OFL.txt)
- **Notes**: The same OFL.txt also ships next to the font files at
  `resources/fonts/Noto_Sans_JP/OFL.txt` so the licence travels with
  the font binary (OFL §3.2).  Copyright Adobe (Source Han Sans) /
  Google / The Noto Project authors.

### Downloaded subtitle fonts (SIL OFL v1.1)

The fonts available via the in-app picker — Dela Gothic One, Reggae
One, Yusei Magic, Mochiy Pop One, Hachi Maru Pop, Potta One,
DotGothic16, Rampart One — are all distributed under the SIL Open
Font License v1.1.  Each download bundles its own `OFL.txt`
verbatim next to the TTF in
`%APPDATA%/MOJIOKO/fonts/<font-id>/`.  Attribution and licence text
for every font (bundled and downloaded) is also viewable in-app
under **About → Font licenses**.

---

## File index (for the installer NSIS step)

```
ffmpeg-lgpl.txt        (FFmpeg per-component notice)
lgpl-2.1.txt           (GNU LGPL v2.1 verbatim full text)
libass-isc.txt         (libass ISC notice)
faster-whisper-mit.txt (faster-whisper MIT)
electron-mit.txt       (Electron MIT)
react-mit.txt          (React MIT)
noto-sans-jp-ofl.txt   (Noto Sans JP SIL OFL v1.1)
README.md              (this file)
```
