# Changelog

All notable changes to MOJIOKO are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

[日本語版 / Japanese version](CHANGELOG_JA.md)

---

## [1.2.1] - 2026-06-13

Follow-up release on the v1.2 line: small additions around subtitle
editing (duplicate, two line-break modes, stacked preview captions)
and a handful of fixes that landed after v1.2.0 went out.

### Added

- **Duplicate a subtitle row.**  Both the table and the timeline
  block inspector now have a duplicate button.  The copy lands
  directly under the source row in the table, carries every style
  field (text, time, font, colour, outline, fade), and is marked as
  edited so it stands out at a glance.
- **Two line-break modes** replace the previous single "Auto wrap"
  button:
  - **Pack wrap** — drops every existing break in the row and
    refills the line(s) to the full display width.  Same behaviour
    as the old auto-wrap.
  - **Overflow wrap** — keeps the manual breaks the user already
    placed and only folds segments that exceed the display width.
  Both buttons appear side-by-side in the row icons, the bulk-edit
  bar, and the timeline block inspector.
- **Simultaneous captions in the preview.**  When two or more
  subtitles overlap in time, the preview now stacks them vertically
  in the same order the burn-in produces (first event at the
  configured edge, later events pushed away from it).  Previously
  only one caption was shown at a time.
- **Timeline ruler stays on screen.**  When the timeline has three
  or more rows and you scroll down to reach the lower tracks, the
  time ruler now pins to the top of the timeline view instead of
  scrolling out of sight, so the playhead is always reachable.
- **Click or drag on empty timeline space to seek.**  You can now
  click — or hold and drag — anywhere in the empty area of the
  tracks to move the playhead, in addition to the existing ruler
  gesture.  Clicks on subtitle clips continue to select / drag the
  clip as before.

### Changed

- The legacy "Auto wrap" button was renamed to "Pack wrap" so the
  name matches the new "Overflow wrap" sibling.  Behaviour of the
  existing button is unchanged.

### Fixed

- Pressing a wrap button while a text input was focused could
  silently revert the wrap on the next blur (and could discard the
  user's last-typed character).  The text input now syncs from
  external updates while not dirty and only commits on blur when
  the user actually typed.
- Dragging a timeline clip that shares its start time with another
  clip used to swap the two clips' rows mid-drag — the user saw
  the wrong block move.  The dragged clip's track is now pinned to
  its starting row for the duration of the drag.
- Preview captions used to "reflow downward" when an earlier
  caption ended, but the burn-in (libass) freezes each caption's
  vertical position.  The preview now matches: positions are
  decided when a caption starts and stay put until it ends; later
  arrivals fill any freed gap.
- Scrolling the timeline vertically used to let subtitle clips
  paint on top of the (newly-pinned) ruler — the time numbers ran
  underneath the blocks.  The ruler now stays in front of the
  scrolling clips so the time axis is always readable.
- The playhead could be dragged past the end of the video (or
  before the start), which left it pointing at a time the player
  could never reach.  The playhead now stops at the video's start
  and end no matter where you drag.

---

## [1.2.0] - 2026-06-10

Third minor-line release: timeline editing with non-destructive
trimming, scissor-marker undo, on-the-fly help guide, and a clearer
error / warning model.

### Added

#### Timeline editor — trimming

- New STEP 2 timeline view gains a **Trim** action: mark an In point
  and an Out point on the timeline ruler, press **Trim**, and the
  selected span is removed from the video while every later subtitle
  ripples forward to fill the gap.  The trim is non-destructive — the
  original entries stay in the data, only the displayed time axis
  shrinks.
- **Scissor markers** stay at every trim location.  Click a scissor
  to undo that specific trim and restore the subtitles it removed.
  Nested trims unwind from the outermost inward — the next layer
  becomes clickable after the previous one is removed.
- Subtitles that fall entirely inside a trimmed span are temporarily
  hidden (and marked "trim-deleted" in the table); they reappear when
  the trim is reverted.
- A "How to use" popover lives on the timeline toolbar with four
  short tips covering trimming, the scissor undo, zoom / snap, and the
  recommendation to keep subtitles on a single timeline row.

#### Issues tab and error vs warning split

- The subtitle filter formerly known as "Warnings" is now **Issues**,
  and groups every problem the user has to look at.
- Problems are now split into two tiers:
  - **Errors** (red): block export — invalid time, time exceeds video
    duration, invalid size.  The "Continue to render" button is
    disabled while any error remains, with a tooltip pointing at the
    Issues tab.
  - **Warnings** (amber): allow export but should be reviewed —
    empty text, time overlap, overflow.
- The state-badge column now shows red badges for errors and amber
  badges for warnings.

### Changed

- **Time display unified on the edited axis**: every time readout in
  STEP 2 (table cells, time-edit dialog, timeline ruler, inspector)
  now shows the **edited** time — i.e. the time the subtitle will
  have in the rendered output after all trims.  Previously the
  table showed original-axis time, which read inconsistently with
  the timeline.
- **Deleted clips are frozen on the timeline**: subtitles that have
  been removed by a trim show in a dimmed state and reject edits
  (text, time, size, style, bulk operations, delete, restore, auto-
  line-break, font, colour, fade).  The only way to revive them is to
  click the scissor marker that consumed them.
- "Cut" / カット renamed to **Trim** / トリミング throughout the UI
  for consistency with the feature name (button label, tooltip,
  scissor-marker title, toast, help popover).
- Trim toolbar now reads left-to-right as **In → Out → Trim**, with
  the "Trim" heading label removed (the bordered frame around the
  three buttons already groups them visually).
- Bulk-edit operations and Reset on rows that fall inside a trimmed
  span are skipped (with no surprise edits to frozen rows).

### Fixed

- Trimming a span in the middle of an entry that already has a
  trim on one side now unions the two trims correctly (previously
  the second trim could over-shrink the entry).
- Scissor markers no longer appear for trims that are fully
  contained by another trim — only the outermost is clickable.
- The "Issues" tab now correctly counts the unionised set of errors
  and warnings instead of double-counting overlap.
- Removed-rows action buttons stay visible and clickable on the
  Deleted tab so a removed row can be restored without unfreezing
  the whole row first.
- Help popover stays inside the viewport in every window size — opens
  to the right of the help button to escape the bottom-of-window
  clipping that long English translations would otherwise hit.

### Tests / infrastructure

- E2E test selectors switched from localised text matching
  (`button:has-text("追加")` etc.) to `data-testid` so the suite
  passes regardless of `DEFAULT_LANGUAGE`.

---

## [1.1.1] - 2026-06-02

Second minor-line release: per-row font selection, audio file input, expanded
colour palette, and settings dialog organisation.

### Added

#### Font customization
- 9-font registry: Noto Sans JP SemiBold (bundled) plus 8 downloadable
  Google Fonts (Dela Gothic One, Reggae One, Yusei Magic, Mochiy Pop One,
  Hachi Maru Pop, Potta One, DotGothic16, Rampart One)
- Font picker with one-list "select + manage" UI shared between the
  Subtitle Style dialog and the Settings ▸ Fonts tab
  - Click a row to set the project default; download / uninstall icons
    on each row
  - License (SIL OFL v1.1) viewable per-font with the upstream-verbatim
    OFL.txt
- Per-row font override in the STEP 2 subtitle table
  - Compact font selector above each row's text editor
  - Bulk-edit-bar gets a matching font picker for multi-row apply
  - Per-row font flows through to ASS `\fn<family>` and a staged fontsdir
    at burn-in time, so a single output video can mix multiple fonts
- Rare-kanji-coverage warning on Hachi Maru Pop / Potta One (those two
  fonts omit a small set of post-jōyō kanji such as 塡 剝 頰)
- Pre-burn-in font validation: missing fonts surface a toast before the
  save dialog opens instead of letting the back-end fail
- Uninstalling a font that's referenced by any row triggers a
  confirmation dialog; on confirm, affected rows' `fontId` is auto-cleared
  and a notice toast surfaces the change

#### Audio file input
- Six audio formats supported in addition to the existing video formats:
  MP3, WAV, M4A, AAC (raw ADTS), FLAC, OGG (Vorbis)
- Content-based mode detection via ffprobe — extension spoofing
  (e.g. `.mp4` rename of an audio file) is ignored; the actual stream
  layout decides
- Audio mode UI in STEP 1: audio-wave icon in place of the video
  thumbnail, resolution row hidden, format row collapsed
- Audio mode UI in STEP 2: AudioPreviewPanel (centred play/pause + seek
  bar + time readout) replaces VideoPreviewPanel; size / style / font
  cells in each row are hidden; bulk-edit-bar hidden; "Continue to render"
  hidden; text/SRT export becomes the single output path
- Audio playback drives row focus the same way video does (the table
  highlight follows the playhead)

#### Colour palette
- 30 colours unified across every picker (per-row, bulk-edit, settings,
  subtitle style dialog) in three labelled groups:
  - Basic (10 singles)
  - Suggested pairs (5 text × outline combinations — single click sets
    both halves; rendered as a subtitle-style "Aa" preview tile)
  - Colour-blind friendly (10 CUD-recommended singles)
- Close (×) button on the popover; popover height adapts to the host
  dialog (uses Radix's `--radix-popover-content-available-height`) so
  it never clips when opened inside the Settings dialog

#### Settings dialog organisation
- Re-tabbed into 4 panes: General / Fonts / Default style / Whisper
- Underline-style tab strip (the previous chip-style ran on the same
  background colour as the dialog, making non-selected tabs read as
  plain text)
- Font management lives in the Fonts tab; default seed-style and Whisper
  engine params each get their own tab and share a single store slice
  with the STEP 1 surfaces

### Fixed

- **Whisper model download integrity check (C-3)** — downloaded model
  files are now SHA-verified before being marked installed
- **APP_VERSION dynamic** — window title, About dialog, and startup log
  now read the version from `package.json` at build time (no parallel
  edit needed when bumping)
- **OFL compliance** — every font (including the bundled Noto) ships its
  own per-font OFL.txt taken verbatim from `google/fonts/ofl/<name>/
  OFL.txt`.  Earlier per-font OFL editing / synthesis paths were
  removed in favour of upstream-verbatim distribution
- **Settings dialog** — opening the dialog no longer surfaces a green
  focus ring on the active tabpanel (only keyboard-navigation focus
  shows it now); tab height stable across all four tabs so switching
  doesn't jitter
- Wording neutralised across audio-aware paths (audio inputs no longer
  see "Video loaded" / "Failed to load video" / similar — replaced with
  "File loaded" / "Failed to load file" etc.)
- Numerous smaller UI polish: per-row font selector width matches the
  text editor below, font picker rows simplified to a single indicator
  dot, "Download" auto-select removed (download no longer changes the
  active selection), font size limits surfaced via tooltip + inline
  hint (the previous silent 200-px clamp is now visible)

---

## [1.1.0] - 2026-06-01

First minor release: UI redesign, bulk editing, and layout reorganization.

### Added

- Step 2: Multi-row selection with a checkbox column
  - Ctrl+A selects all visible rows, Esc clears the selection
- Step 2: Bulk edit bar — apply style changes (text color, outline color,
  outline thickness, fade) to multiple selected rows in one operation
  - The whole bulk operation collapses to a single undo entry
- Step 2: Bulk auto line-wrap action — re-flow selected rows to fit the
  video width using accurate glyph-width metrics
- Step 1: Live subtitle style sample preview in the new
  subtitle style dialog
- Step 1: Advanced transcription settings (VAD threshold, beam size,
  language, etc.) promoted to a dedicated dialog
- Shared outline-thickness slider used consistently across Step 1
  style dialog, Step 2 per-row, and Step 2 bulk edit

### Changed

- Major UI restructuring so each step's first view fits within
  the 1280×820 default window:
  - Step 1: Compact first view focused on video + audio tracks;
    subtitle style settings moved to a modal triggered from the
    Start button split-caret
  - Step 2: Subtitle position and background controls moved here from
    Step 3 and embedded in the video preview panel
  - Step 3: Recast as a render-settings panel (live preview removed,
    now provided on Step 2 instead)
- Default window size: 1280×820 (content size); minimum 960×640
- Auto line-wrap option moved from "Advanced" to the subtitle
  style defaults, with live reflection in the preview
- New UI code routed through shadcn theme tokens
  (preparatory refactor for future light theme support)

### Fixed

- Command palette "Support the project" entry did not open the
  donation dialog; now wired up correctly

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
