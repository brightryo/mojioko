# Changelog

All notable changes to MOJIOKO are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

[日本語版 / Japanese version](CHANGELOG_JA.md)

---

## [1.0.1] - 2026-05-30

First patch release.

### Fixed

- Help menu "User Guide" link now points to the GitHub Pages
  guide page (previously linked to the GitHub repository README)

### Changed

- "OBS Setup Guide" menu item merged into "User Guide"
  - OBS setup instructions are now part of the User Guide Q&A
- Added "Send Feedback" menu item
  - Opens the feedback page in a new tab

---

## [1.0.0] - 2026-05-30

Initial public release.

### Added

#### Video Input
- Video file selection (MKV, MP4, MOV, AVI)
- Video metadata display (resolution, duration, format, file size)
- Thumbnail preview
- Custom protocol `mojioko-media://` for in-app video playback (with HTTP Range support)

#### Audio Track Selection
- Multi-track audio enumeration with codec / channel / sample rate details
- Track selection UI with default track auto-selection
- Designed for OBS multi-track recordings

#### Whisper Model Management
- Support for 3 models: `small`, `medium`, `large-v3` (Systran faster-whisper int8 quantized)
- HuggingFace model downloader with per-file progress
- Disk space check before download
- Cancelable downloads with automatic cleanup
- Active model switching, uninstall, and folder access

#### Transcription
- faster-whisper Python sidecar (no Python runtime required, bundled via PyInstaller)
- CPU + int8 quantization (no GPU required, runs on any Windows PC)
- VAD (Voice Activity Detection) with adjustable threshold and duration
- Beam size adjustment (1-20)
- 11 language support (auto-detect, Japanese, English, Chinese, Korean, Spanish, French, German, Portuguese, Russian, Arabic)
- Real-time progress (1% granularity)
- Cancelable with confirmation dialog
- Optional automatic line-wrap for video-width fitting

#### Subtitle Editor (Step 2)
- Table view with #, Time, Size, Style, Text, Status, Actions columns
- 5-tab filter: All / Ready / Edited / Warnings / Deleted
- Inline text editing (Ctrl+Enter or blur to commit)
- Inline time editing (HH:MM:SS.cc format)
- Time adjustment dialog with ±1s / ±0.1s steppers, long-press repeat, snap-to-neighbor
- Add new row with auto-positioning by start time
- Soft delete and restore
- Reset to original (text / time / style)
- Undo/Redo (up to 100 steps)
- Auto-sort by start time after time edits
- Auto-scroll to focused row (after framer-motion animation completion)
- Text export (`.txt`, with `\N` removed)
- SRT export (UTF-8 BOM, DaVinci Resolve compatible)
- Video preview panel with playback, seeking, and time-synced subtitle highlight

#### Subtitle Style Settings
- Font size: 30-200 px
- Text color (HEX with color picker, session history)
- Outline color (same picker)
- Outline thickness: 0-10 px
- Fade in/out toggle
- Fade duration: 0.1-0.5s (app-wide setting)

#### Warning & Output Logic
- **Output target** = `!isDeleted && !emptyText`
- **Burn-in target** = `isOutputTarget && !timeInvalid && !overDuration && !invalidSize`
- Visual badges for: time invalid, time exceeded, time overlap, invalid size, overflow, empty text, deleted
- Overflow text portion highlighted in red

#### Video Burn-in (Step 3)
- Subtitle position: horizontal (left/center/right) × vertical (top/bottom)
- Vertical margin adjustment (px)
- Subtitle background panel: on/off, color (black/white), opacity (0-100%)
- **Output format selection (MP4 / Same as input)**
  - Default: **MP4** (optimized for YouTube Shorts, TikTok, Instagram Reels)
  - MP4 mode adds `-f mp4 -movflags +faststart` for streaming
- Encoder auto-detection: h264_nvenc → h264_amf → h264_qsv → h264_mf (fallback)
- Encoder override with fallback warning
- Audio output mode: simple (mix to AAC 192kbps) or preserve (`-c:a copy`)
- Auto-generated output filename: `{stem}_subtitled_{timestamp}.{ext}`
- Native save dialog with default `~/Videos` location
- Overwrite confirmation dialog
- ASS subtitle generation (libass-compatible tags)
- Real-time progress bar (0.1% granularity)
- Cancelable with partial file cleanup
- Post-completion actions: Open file, Show in folder, Re-export, Donate

#### Multilingual UI
- 2 languages: Japanese (default) / English
- Native menu bar translation
- Locale-based JSON namespaces
- Settings persistence

#### Native Menu Bar
- File → Quit (Ctrl+Q)
- Tools → Settings (Ctrl+,)
- Help → User Guide
- Help → OBS Setup Guide
- Help → Support the Project (donation dialog)
- Help → Open Logs Folder
- Help → Open Download Page
- Help → About

#### Command Palette (Ctrl+K)
- 5 categories: Navigation / File / Edit / Settings / Help
- Quick access to all major actions

#### Keyboard Shortcuts
- Global: Ctrl+K, Ctrl+,, Ctrl+/, Ctrl+O, Ctrl+Q
- Step 2: Ctrl+Z, Ctrl+Y, Ctrl+S, Ctrl+N, Delete, Ctrl+R

#### Settings Dialog
- Display language (Japanese / English)
- Fade duration (0.1-0.5s)
- Persistent storage in `%APPDATA%\MOJIOKO\settings.json`
- Auto-recovery from corrupt settings
- Step 3 settings reset on Step 1 navigation (burnin, subtitleBackground, audioMode, outputContainer)

#### Donation Dialog
- 3 donation channels: Buy Me a Coffee → BOOTH → GitHub Sponsors
- Accessible from Help menu and Step 3 completion screen

#### Error Handling & Logging
- Typed error classes
- Toast notifications (success / warning / error / info)
- Log file: `%APPDATA%\MOJIOKO\logs\mojioko.log` (5MB rotation, 3 generations)
- Startup environment dump (OS, Electron, Chromium, Node, GPU, ffmpeg encoders)
- Uncaught exception handling

#### Security & Privacy
- No external communication on startup
- No telemetry or analytics
- Sandboxed renderer process (contextIsolation + sandboxed preload)
- Strict Content Security Policy
- External URL allowlist
- Write path restricted to `~/`
- `mojioko-media://` allowlist
- Whisper model ID validation

#### Installer (NSIS)
- Multi-step wizard (Welcome → License → Install location → Confirm → Progress → Complete)
- EULA agreement screen (Japanese / English, language auto-detected)
- User-level installation (no admin required)
- Custom install path support
- Desktop + Start menu shortcuts
- "Run after install" checkbox
- Uninstaller (preserves user settings)
- Bundled: PyInstaller-built Python sidecar, LGPL ffmpeg shared build, Noto Sans JP font, third-party licenses

### Known Limitations

- **No code signing**: SmartScreen warning may appear on first launch
- **No auto-update**: Manual update via Help → Open Download Page
- **macOS / Linux**: Not supported in v1.0.0 (Windows only)
- **Single bundled font**: Noto Sans JP SemiBold only (font customization planned)
- **No opacity for text/outline colors**: 100% opaque only (opacity setting planned)

### Planned for v1.0.x

- Whisper model integrity check (SHA / size verification)
- Sidecar concurrent execution guard
- Per-chunk download timeout
- Renderer-side IPC subscription auto-cleanup
- Atomic settings.json write

### Planned for v1.1+

- Timeline-based subtitle editor
- Font customization
- Text and outline opacity settings
- Light theme
- macOS / Linux support (potential)
