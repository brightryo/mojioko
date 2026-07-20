# MOJIOKO

A local-first desktop application for generating subtitled videos.
All processing runs locally on your PC — no data leaves your device.
Available as a free edition on GitHub and a paid edition on the
Microsoft Store; core features (transcription, editing, subtitle
burn-in, SRT / text export) are identical in both.

[Download](https://brightryo.github.io/mojioko/) | [日本語 README](README_JA.md)

---

## Features

- **Local processing** — All transcription and rendering happens on your PC. No cloud, no telemetry.
- **Multi-format support** — Import MKV, MP4 for video, and MP3 / WAV / M4A / AAC / FLAC / OGG for audio.
- **Audio file input** — Transcribe audio files directly with text/SRT export (no burn-in step).
- **Custom subtitle fonts** — 13 fonts ship in-app (Noto Sans JP plus 12 Google Fonts: 8 Japanese + 4 Latin) with per-row font override. The paid edition unlocks the 12 additional fonts; the free edition uses Noto Sans JP only.
- **Vertical video support** — Generate subtitles for TikTok, YouTube Shorts, and Instagram Reels.
- **MP4 export** — Direct export to MP4 with `+faststart` for optimized SNS uploads.
- **Multilingual transcription** — Powered by OpenAI Whisper, supports 11 languages.
- **Hardware-accelerated encoding** — Auto-detects NVIDIA, AMD, Intel GPU encoders, with software fallback.
- **Subtitle editor** — Inline text editing, time adjustment, undo/redo, multi-format export (TXT/SRT).
- **Timeline trimming** — Mark In / Out on the timeline and remove unwanted segments from the video together with the surrounding subtitles. Each trim leaves a scissor marker you can click to undo, even when trims are nested.
- **Colour palette** — 30 curated colours including a colour-blind-friendly (CUD) set.
- **DaVinci Resolve compatible** — SRT output works directly with DaVinci Resolve and other video editors.

## System Requirements

- **OS**: Windows 10 / 11 (64-bit)
- **RAM**: 8 GB minimum, 16 GB recommended
- **Disk space**: ~2 GB for application + ~3 GB for Whisper large-v3 model (optional)
- **GPU**: Optional (NVIDIA / AMD / Intel hardware encoding supported)

## Quick Start

1. [Download the installer](https://brightryo.github.io/mojioko/) from the official download page
2. Run the installer (administrator privileges not required)
3. Launch MOJIOKO
4. Select a Whisper model and download it (one-time setup)
5. Choose a video file → Transcribe → Edit → Export

## Documentation

- **[Download Page](https://brightryo.github.io/mojioko/)** — Latest version and overview
- **[CHANGELOG.md](CHANGELOG.md)** — Version history
- **[PRIVACY.md](PRIVACY.md)** — Privacy policy
- **[LICENSE](build/license_en.txt)** — End User License Agreement

## Support the Project

MOJIOKO's free edition (on GitHub) is available at no cost. The paid
edition on the Microsoft Store unlocks the additional subtitle fonts
bundled by MOJIOKO and directly supports development. If the free
edition has been helpful, please consider supporting development in
one of the following ways:

- **[Buy Me a Coffee](https://buymeacoffee.com/brightryog)** — Global, no account required, from $3
- **[BOOTH](https://brightryo.booth.pm/items/8414334)** (Japan only) — PayPay, convenience store, credit card, from ¥300
- **[GitHub Sponsors](https://github.com/sponsors/brightryo)** — One-time or recurring, requires GitHub account

## Issues & Feedback

Found a bug or have a feature request?
Please open an issue on [GitHub Issues](https://github.com/brightryo/mojioko/issues).

## License

Proprietary. See [LICENSE](build/license_en.txt) for full terms.

Copyright © 2026 BrightRyo. All rights reserved.

Portions of this software are copyright © 2006-2026 The FreeType
Project (https://freetype.org). All rights reserved.

---

## Technical Notes

- **Smart screen warning**: The installer is not code-signed, so Windows Defender SmartScreen may show a warning on first launch. Code signing is planned for a future release.
- **No auto-update**: Manual update checks via Help → Open Download Page.
- **macOS / Linux**: Not currently supported. Windows only.
