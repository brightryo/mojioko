/**
 * `.mojioko` project file format (REQ-0194 phase 3).
 *
 * Design principles:
 *   - Plain UTF-8 JSON, pretty-printed with 2-space indent so users can open
 *     the file in Notepad / VS Code and read it.
 *   - Fields grouped by role (`format` / `source` / `transcription` /
 *     `editing`) — no flat blob at the top level.
 *   - `SubtitleEntry` is a §21-protected type; the file stores it verbatim
 *     (full fields including `original` snapshot and `isDeleted` / `isEdited`
 *     flags) so a save→open round-trip is bit-identical.
 *   - Human-readable additions like `source.fileName` (basename) and
 *     `source.resolution.{width,height}` are derived at save time from the
 *     canonical `VideoInfo`; they are NOT the source of truth on load.  On
 *     load we reconstruct `VideoInfo` from the top-level `source` keys.
 *   - `transcription.rawResult` is derived from `entries.map(e => e.original)`
 *     at save time; it's provided for readability and for future tooling
 *     that only wants the whisper output.  On load it is ignored — each
 *     entry's `.original` is the real source of truth.
 */

import type { SubtitleEntry, SubtitleEntryOriginal, VideoInfo, AudioTrack, TranscriptionDefaults, WhisperModelId } from './types'
import type { Cut } from './cuts'

/** Current file-format version.  Bump on breaking changes. */
export const PROJECT_FILE_FORMAT_VERSION = 1

/** Filename extension including the leading dot. */
export const PROJECT_FILE_EXTENSION = 'mojioko'

/** `format.app` marker used to sanity-check load target files. */
export const PROJECT_FILE_APP_MARKER = 'MOJIOKO'

export interface ProjectFileFormat {
  app: typeof PROJECT_FILE_APP_MARKER
  appVersion: string
  fileFormatVersion: number
  /** ISO 8601 with local timezone offset (e.g. `2026-07-11T07:00:00+09:00`). */
  savedAt: string
}

export interface ProjectFileSource {
  filePath: string
  /** Basename of `filePath` — derived, purely for readability. */
  fileName: string
  hasVideoStream: boolean
  resolution: { width: number; height: number }
  durationSec: number
  fps: number
  container: string
  videoCodec: string
  fileSizeBytes: number
  audioTracks: AudioTrack[]
  /** 1-based audio-track index that the transcription was run against. */
  transcribedTrackIndex: number
}

export interface ProjectFileTranscription {
  whisperModel: WhisperModelId | null
  device: 'cpu' | 'gpu'
  /**
   * Convenience view of the pre-edit whisper output, derived at save time
   * from `entries.map(e => e.original)`.  Ignored on load — the real source
   * of truth is `editing.subtitles[i].original` embedded in each row.
   */
  rawResult: SubtitleEntryOriginal[]
}

export interface ProjectFileEditing {
  defaults: TranscriptionDefaults
  cuts: Cut[]
  subtitles: SubtitleEntry[]
}

export interface ProjectFile {
  format: ProjectFileFormat
  source: ProjectFileSource
  transcription: ProjectFileTranscription
  editing: ProjectFileEditing
}

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

/**
 * ISO 8601 with the local timezone offset (e.g. `+09:00`).  Standard
 * `Date.toISOString()` always emits `Z` (UTC); we want the local offset
 * so a user opening the file in a Japanese editor immediately sees the
 * wall-clock time they saved at.
 */
function toIsoWithLocalOffset(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const y = d.getFullYear()
  const mo = pad(d.getMonth() + 1)
  const da = pad(d.getDate())
  const h = pad(d.getHours())
  const mi = pad(d.getMinutes())
  const s = pad(d.getSeconds())
  const offMin = -d.getTimezoneOffset()
  const sign = offMin >= 0 ? '+' : '-'
  const offH = pad(Math.floor(Math.abs(offMin) / 60))
  const offM = pad(Math.abs(offMin) % 60)
  return `${y}-${mo}-${da}T${h}:${mi}:${s}${sign}${offH}:${offM}`
}

/** Extract the file basename from a path (cross-platform). */
function basename(filePath: string): string {
  return filePath.split(/[\\/]/).pop() ?? filePath
}

export interface BuildProjectFileArgs {
  appVersion: string
  video: VideoInfo
  transcribedTrackIndex: number
  entries: SubtitleEntry[]
  cuts: Cut[]
  defaults: TranscriptionDefaults
  whisperModel: WhisperModelId | null
  device: 'cpu' | 'gpu'
  now?: Date
}

export function buildProjectFile(args: BuildProjectFileArgs): ProjectFile {
  return {
    format: {
      app: PROJECT_FILE_APP_MARKER,
      appVersion: args.appVersion,
      fileFormatVersion: PROJECT_FILE_FORMAT_VERSION,
      savedAt: toIsoWithLocalOffset(args.now ?? new Date()),
    },
    source: {
      filePath: args.video.path,
      fileName: basename(args.video.path),
      hasVideoStream: args.video.hasVideoStream,
      resolution: {
        width: args.video.widthPx,
        height: args.video.heightPx,
      },
      durationSec: args.video.durationSec,
      fps: args.video.fps,
      container: args.video.container,
      videoCodec: args.video.videoCodec,
      fileSizeBytes: args.video.fileSizeBytes,
      audioTracks: args.video.audioTracks,
      transcribedTrackIndex: args.transcribedTrackIndex,
    },
    transcription: {
      whisperModel: args.whisperModel,
      device: args.device,
      rawResult: args.entries.map((e) => e.original),
    },
    editing: {
      defaults: args.defaults,
      cuts: args.cuts,
      subtitles: args.entries,
    },
  }
}

/** Serialise to pretty-printed UTF-8 JSON (2-space indent). */
export function serializeProjectFile(pf: ProjectFile): string {
  return JSON.stringify(pf, null, 2)
}

// ---------------------------------------------------------------------------
// Deserialisation
// ---------------------------------------------------------------------------

/**
 * Loose parse — accepts any string, returns either a `ProjectFile` or
 * `{ ok: false, reason }`.  Structural validation is intentionally minimal
 * (marker + fileFormatVersion + presence of the four groups); deeper
 * type-checking happens naturally at hydration time when the renderer
 * copies fields into typed stores.  Silent field addition / omission
 * survives.
 */
export type ParseResult =
  | { ok: true; project: ProjectFile }
  | { ok: false; reason: 'invalid-json' | 'not-mojioko' | 'unsupported-version' | 'missing-fields' }

export function parseProjectFile(raw: string): ParseResult {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return { ok: false, reason: 'invalid-json' }
  }
  if (typeof json !== 'object' || json === null) {
    return { ok: false, reason: 'invalid-json' }
  }
  const j = json as Record<string, unknown>
  const fmt = j.format as Record<string, unknown> | undefined
  if (!fmt || fmt.app !== PROJECT_FILE_APP_MARKER) {
    return { ok: false, reason: 'not-mojioko' }
  }
  const ver = fmt.fileFormatVersion
  if (typeof ver !== 'number' || ver > PROJECT_FILE_FORMAT_VERSION) {
    return { ok: false, reason: 'unsupported-version' }
  }
  if (!j.source || !j.transcription || !j.editing) {
    return { ok: false, reason: 'missing-fields' }
  }
  // Structural cast — deeper validation deferred to hydration.
  return { ok: true, project: json as ProjectFile }
}

/**
 * Reconstruct a `VideoInfo` from the file's `source` group.  Used at
 * open-time to seed `projectStore.video` after the identity check
 * (duration + resolution) confirms the on-disk file matches.
 *
 * `path` is passed in explicitly rather than taken from `source.filePath`
 * because the user may have re-selected the file at a new location.
 */
export function videoInfoFromProject(source: ProjectFileSource, path: string): VideoInfo {
  return {
    path,
    hasVideoStream: source.hasVideoStream,
    widthPx: source.resolution.width,
    heightPx: source.resolution.height,
    durationSec: source.durationSec,
    fps: source.fps,
    container: source.container,
    videoCodec: source.videoCodec,
    audioTracks: source.audioTracks,
    fileSizeBytes: source.fileSizeBytes,
  }
}

// ---------------------------------------------------------------------------
// Identity check
// ---------------------------------------------------------------------------

/**
 * Threshold used to decide whether two duration values refer to the same
 * source.  Some container variants (mp4 vs. remux) drift by tens of ms,
 * so a strict `===` is too tight.  0.5 s is well below the granularity
 * users actually care about here.
 */
export const IDENTITY_DURATION_TOLERANCE_SEC = 0.5

export interface IdentityCheckArgs {
  saved: ProjectFileSource
  current: VideoInfo
}

export interface IdentityMismatch {
  durationMismatch: boolean
  resolutionMismatch: boolean
  savedDurationSec: number
  currentDurationSec: number
  savedResolution: { width: number; height: number }
  currentResolution: { width: number; height: number }
}

export function checkIdentity(args: IdentityCheckArgs): { ok: true } | { ok: false; mismatch: IdentityMismatch } {
  const durationMismatch =
    Math.abs(args.saved.durationSec - args.current.durationSec) > IDENTITY_DURATION_TOLERANCE_SEC
  const resolutionMismatch =
    args.saved.resolution.width !== args.current.widthPx ||
    args.saved.resolution.height !== args.current.heightPx
  if (!durationMismatch && !resolutionMismatch) return { ok: true }
  return {
    ok: false,
    mismatch: {
      durationMismatch,
      resolutionMismatch,
      savedDurationSec: args.saved.durationSec,
      currentDurationSec: args.current.durationSec,
      savedResolution: args.saved.resolution,
      currentResolution: { width: args.current.widthPx, height: args.current.heightPx },
    },
  }
}

// ---------------------------------------------------------------------------
// Font usage summary
// ---------------------------------------------------------------------------

/**
 * Collect the set of font IDs actually referenced by the project's subtitles.
 * `undefined` entries (row inherits project default) are represented by the
 * caller-supplied `defaultFontId`, so a project with no per-row overrides
 * still yields a one-element set.
 */
export function collectUsedFontIds(entries: SubtitleEntry[], defaultFontId: string): string[] {
  const s = new Set<string>()
  for (const e of entries) {
    s.add(e.fontId ?? defaultFontId)
  }
  return Array.from(s)
}
