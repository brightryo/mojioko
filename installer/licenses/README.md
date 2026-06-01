# MOJIOKO — Third-Party Licenses

MOJIOKO bundles the following third-party components. Their licenses are included in this directory.

---

## ffmpeg / ffprobe

- **License**: GNU Lesser General Public License v2.1 (LGPL-2.1)
- **Source**: https://ffmpeg.org/
- **File**: `ffmpeg-lgpl.txt`
- **Note**: MOJIOKO uses LGPL-compliant builds of ffmpeg and ffprobe. No GPL-licensed components are included.

---

## faster-whisper

- **License**: MIT
- **Source**: https://github.com/SYSTRAN/faster-whisper
- **File**: `faster-whisper-mit.txt`

---

## Electron

- **License**: MIT
- **Source**: https://electronjs.org/
- **File**: `electron-mit.txt`
- **Note**: Electron includes Chromium (BSD) and Node.js (MIT). Full notices are in the Electron package.

---

## React

- **License**: MIT
- **Source**: https://reactjs.org/
- **File**: `react-mit.txt`

---

## Other npm dependencies

All other npm dependencies are MIT-licensed or similarly permissive.
A complete list is available via `npm ls --json` in the source repository.

---

## Whisper models (OpenAI / SYSTRAN)

Whisper models are subject to the MIT License:
https://github.com/openai/whisper/blob/main/LICENSE

---

## Noto Sans JP (bundled)

- **License**: SIL Open Font License v1.1
- **Source**: https://fonts.google.com/noto/specimen/Noto+Sans+JP
- **File**: `noto-sans-jp-ofl.txt` (full SIL OFL text)
- **Note**: The same OFL.txt also ships next to the font files at
  `resources/fonts/Noto_Sans_JP/OFL.txt` so the licence travels with the
  font binary (OFL §3.2).  Copyright Adobe (Source Han Sans) /
  Google / The Noto Project authors.

---

## Other subtitle fonts (downloaded on demand)

The fonts available via the in-app picker — Dela Gothic One, Reggae One,
Yusei Magic, Mochiy Pop One, Hachi Maru Pop, Potta One, DotGothic16,
Rampart One — are all distributed under the SIL Open Font License v1.1.
Each download bundles its own `OFL.txt` next to the TTF in
`%APPDATA%/MOJIOKO/fonts/<font-id>/`.  Attribution and licence text for
every font (bundled and downloaded) is also viewable in-app under
**About → Font licenses**.
