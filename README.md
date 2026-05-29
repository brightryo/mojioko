# MOJIOKO

A free, local-first desktop application for generating subtitled videos.
All processing runs locally on your PC—no data leaves your device.

[Download](https://brightryo.github.io/mojioko/) | [日本語 README](README_JA.md)

---

## Features

- **Local processing** — All transcription and rendering happens on your PC. No cloud, no telemetry.
- **Multi-format support** — Import MKV, MP4, MOV (iPhone videos), and AVI.
- **Vertical video support** — Generate subtitles for TikTok, YouTube Shorts, and Instagram Reels.
- **MP4 export** — Direct export to MP4 with `+faststart` for optimized SNS uploads.
- **Multilingual transcription** — Powered by OpenAI Whisper, supports 11 languages.
- **Hardware-accelerated encoding** — Auto-detects NVIDIA, AMD, Intel GPU encoders, with software fallback.
- **Subtitle editor** — Inline text editing, time adjustment, undo/redo, multi-format export (TXT/SRT).
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

MOJIOKO is free to use. If you find it helpful, please consider supporting development:

- **[Buy Me a Coffee](https://buymeacoffee.com/brightryog)** — Global, no account required, from $3
- **[BOOTH](https://brightryo.booth.pm/items/8414334)** (Japan only) — PayPay, convenience store, credit card, from ¥300
- **[GitHub Sponsors](https://github.com/sponsors/brightryo)** — One-time or recurring, requires GitHub account

## Issues & Feedback

Found a bug or have a feature request?
Please open an issue on [GitHub Issues](https://github.com/brightryo/mojioko/issues).

## License

Proprietary. See [LICENSE](build/license_en.txt) for full terms.

Copyright © 2026 brightryo. All rights reserved.

---

## Technical Notes

- **Smart screen warning**: The installer is not code-signed in v1.0.0. Windows Defender SmartScreen may show a warning on first launch. This will be addressed in future versions.
- **No auto-update**: Manual update checks via Help → Open Download Page.
- **macOS / Linux**: Not currently supported. Windows only.
