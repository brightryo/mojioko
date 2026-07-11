/**
 * REQ-0194 phase 3c — round-trip test for the .mojioko project file.
 *
 * The invariant this protects: build → serialize → parse must yield a
 * project object whose editing.subtitles is field-identical to the input
 * SubtitleEntry[].  This is the safety net for the §21 SubtitleEntry
 * preservation contract — any accidental field drop / rename in the
 * serializer breaks this test loudly.
 *
 * Also covers:
 *   - format group fields (marker, version, appVersion, savedAt shape)
 *   - source group reconstruction back into VideoInfo
 *   - identity check (match / duration drift / resolution mismatch)
 *   - font-usage collector (explicit fontId vs. inherited)
 *   - parse error paths (invalid JSON, wrong marker, future version)
 */

import { describe, it, expect } from 'vitest'
import {
  buildProjectFile,
  serializeProjectFile,
  parseProjectFile,
  videoInfoFromProject,
  checkIdentity,
  collectUsedFontIds,
  PROJECT_FILE_APP_MARKER,
  PROJECT_FILE_FORMAT_VERSION,
} from '../../src/shared/project-file'
import type { SubtitleEntry, VideoInfo, TranscriptionDefaults, AudioTrack } from '../../src/shared/types'
import type { Cut } from '../../src/shared/cuts'

const sampleAudioTracks: AudioTrack[] = [
  { index: 1, channels: 'stereo', sampleRateHz: 48000, codec: 'aac', language: 'und' },
  { index: 2, channels: 'mono',   sampleRateHz: 48000, codec: 'aac', language: 'jpn' },
]

const sampleVideo: VideoInfo = {
  path: 'C:\\Users\\test\\Videos\\input.mkv',
  hasVideoStream: true,
  widthPx: 1920,
  heightPx: 1080,
  durationSec: 264.0,
  fps: 30,
  container: 'mkv',
  videoCodec: 'h264',
  audioTracks: sampleAudioTracks,
  fileSizeBytes: 20_971_520,
}

const sampleDefaults: TranscriptionDefaults = {
  fontSizePx: 100,
  textColorHex: '#FFFFFF',
  outlineColorHex: '#000000',
  outlineThicknessPx: 3,
  whisperModel: 'large-v3-turbo',
}

function makeEntry(
  id: string,
  startSec: number,
  endSec: number,
  text: string,
  overrides: Partial<SubtitleEntry> = {},
): SubtitleEntry {
  const base = {
    startSec,
    endSec,
    text,
    fontSizePx: 100,
    textColorHex: '#FFFFFF',
    outlineColorHex: '#000000',
    outlineThicknessPx: 3,
    fadeDurationSec: 0.2,
    horizontalPosition: 'center' as const,
    verticalPosition: 'bottom' as const,
    verticalMarginPx: 40,
    subtitleBackground: {
      enabled: false,
      color: 'black' as const,
      opacityPercent: 50,
    },
  }
  return {
    id,
    ...base,
    isDeleted: false,
    isEdited: false,
    original: { ...base, subtitleBackground: { ...base.subtitleBackground } },
    ...overrides,
  }
}

const sampleEntries: SubtitleEntry[] = [
  makeEntry('e-001', 2.5, 5.1, 'これは最初の字幕です。'),
  makeEntry('e-002', 6.3, 9.8, '2 番目の字幕。編集済み。', {
    text: '2 番目の字幕。編集済み。',
    isEdited: true,
    fontId: 'delagothicone',
  }),
  makeEntry('e-003', 11.0, 14.2, 'アイテムを取得しました。', {
    posX: 960,
    posY: 540,
  }),
  makeEntry('e-004', 15.5, 18.9, '削除された行。', {
    isDeleted: true,
  }),
]

const sampleCuts: Cut[] = [
  { id: 'c-001', startSec: 20.0, endSec: 25.0 },
  { id: 'c-002', startSec: 40.0, endSec: 42.5 },
]

// ---------------------------------------------------------------------------
// Round-trip
// ---------------------------------------------------------------------------

describe('project-file: build → serialize → parse round-trip', () => {
  it('preserves every SubtitleEntry field verbatim', () => {
    const pf = buildProjectFile({
      appVersion: '1.3.3',
      video: sampleVideo,
      transcribedTrackIndex: 2,
      entries: sampleEntries,
      cuts: sampleCuts,
      defaults: sampleDefaults,
      whisperModel: 'large-v3-turbo',
      device: 'gpu',
      now: new Date('2026-07-11T07:00:00+09:00'),
    })
    const serialized = serializeProjectFile(pf)
    const parsed = parseProjectFile(serialized)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.project.editing.subtitles).toEqual(sampleEntries)
  })

  it('preserves cuts, defaults, and source metadata', () => {
    const pf = buildProjectFile({
      appVersion: '1.3.3',
      video: sampleVideo,
      transcribedTrackIndex: 2,
      entries: sampleEntries,
      cuts: sampleCuts,
      defaults: sampleDefaults,
      whisperModel: 'large-v3-turbo',
      device: 'cpu',
    })
    const raw = serializeProjectFile(pf)
    const parsed = parseProjectFile(raw)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.project.editing.cuts).toEqual(sampleCuts)
    expect(parsed.project.editing.defaults).toEqual(sampleDefaults)
    expect(parsed.project.source.filePath).toBe(sampleVideo.path)
    expect(parsed.project.source.resolution).toEqual({ width: 1920, height: 1080 })
    expect(parsed.project.source.durationSec).toBe(264.0)
    expect(parsed.project.source.audioTracks).toEqual(sampleAudioTracks)
    expect(parsed.project.source.transcribedTrackIndex).toBe(2)
  })

  it('records the format marker + version', () => {
    const pf = buildProjectFile({
      appVersion: '1.3.3',
      video: sampleVideo,
      transcribedTrackIndex: 1,
      entries: [],
      cuts: [],
      defaults: sampleDefaults,
      whisperModel: null,
      device: 'cpu',
    })
    expect(pf.format.app).toBe(PROJECT_FILE_APP_MARKER)
    expect(pf.format.fileFormatVersion).toBe(PROJECT_FILE_FORMAT_VERSION)
    expect(pf.format.appVersion).toBe('1.3.3')
    // ISO 8601 with local offset: YYYY-MM-DDTHH:mm:ss±HH:mm
    expect(pf.format.savedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/)
  })

  it('derives basename from path', () => {
    const pf = buildProjectFile({
      appVersion: '1.3.3',
      video: sampleVideo,
      transcribedTrackIndex: 2,
      entries: [],
      cuts: [],
      defaults: sampleDefaults,
      whisperModel: null,
      device: 'cpu',
    })
    expect(pf.source.fileName).toBe('input.mkv')
  })

  it('derives rawResult from entries.map(e => e.original)', () => {
    const pf = buildProjectFile({
      appVersion: '1.3.3',
      video: sampleVideo,
      transcribedTrackIndex: 2,
      entries: sampleEntries,
      cuts: [],
      defaults: sampleDefaults,
      whisperModel: null,
      device: 'cpu',
    })
    expect(pf.transcription.rawResult).toEqual(sampleEntries.map((e) => e.original))
  })

  it('produces pretty-printed 2-space JSON', () => {
    const pf = buildProjectFile({
      appVersion: '1.3.3',
      video: sampleVideo,
      transcribedTrackIndex: 2,
      entries: [],
      cuts: [],
      defaults: sampleDefaults,
      whisperModel: null,
      device: 'cpu',
    })
    const raw = serializeProjectFile(pf)
    // Top-level keys are on their own lines with a leading 2-space indent.
    expect(raw).toMatch(/\n {2}"format":/)
    expect(raw).toMatch(/\n {2}"source":/)
    expect(raw).toMatch(/\n {2}"transcription":/)
    expect(raw).toMatch(/\n {2}"editing":/)
  })
})

// ---------------------------------------------------------------------------
// videoInfoFromProject
// ---------------------------------------------------------------------------

describe('videoInfoFromProject', () => {
  it('reconstructs VideoInfo using the caller-supplied path', () => {
    const pf = buildProjectFile({
      appVersion: '1.3.3',
      video: sampleVideo,
      transcribedTrackIndex: 2,
      entries: [],
      cuts: [],
      defaults: sampleDefaults,
      whisperModel: null,
      device: 'cpu',
    })
    // Simulate the user re-picking the file at a new location.
    const newPath = 'D:\\media\\input.mkv'
    const vi = videoInfoFromProject(pf.source, newPath)
    expect(vi.path).toBe(newPath)
    expect(vi.widthPx).toBe(1920)
    expect(vi.heightPx).toBe(1080)
    expect(vi.durationSec).toBe(264.0)
    expect(vi.audioTracks).toEqual(sampleAudioTracks)
  })
})

// ---------------------------------------------------------------------------
// checkIdentity
// ---------------------------------------------------------------------------

describe('checkIdentity', () => {
  const savedSource = {
    filePath: 'a',
    fileName: 'a',
    hasVideoStream: true,
    resolution: { width: 1920, height: 1080 },
    durationSec: 264.0,
    fps: 30,
    container: 'mkv',
    videoCodec: 'h264',
    fileSizeBytes: 0,
    audioTracks: [],
    transcribedTrackIndex: 1,
  }

  it('passes when duration and resolution match exactly', () => {
    const r = checkIdentity({ saved: savedSource, current: sampleVideo })
    expect(r.ok).toBe(true)
  })

  it('tolerates small duration drift (< 0.5 s)', () => {
    const r = checkIdentity({
      saved: savedSource,
      current: { ...sampleVideo, durationSec: 264.3 },
    })
    expect(r.ok).toBe(true)
  })

  it('fails on duration drift ≥ 0.5 s', () => {
    const r = checkIdentity({
      saved: savedSource,
      current: { ...sampleVideo, durationSec: 265.0 },
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.mismatch.durationMismatch).toBe(true)
    expect(r.mismatch.resolutionMismatch).toBe(false)
  })

  it('fails on resolution mismatch even when duration matches', () => {
    const r = checkIdentity({
      saved: savedSource,
      current: { ...sampleVideo, widthPx: 1280, heightPx: 720 },
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.mismatch.durationMismatch).toBe(false)
    expect(r.mismatch.resolutionMismatch).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// collectUsedFontIds
// ---------------------------------------------------------------------------

describe('collectUsedFontIds', () => {
  it('collects explicit fontId overrides plus the inherited default', () => {
    const fonts = collectUsedFontIds(sampleEntries, 'noto-sans-jp-semibold')
    // e-002 has explicit `delagothicone`; e-001/e-003/e-004 inherit.
    expect(fonts).toContain('delagothicone')
    expect(fonts).toContain('noto-sans-jp-semibold')
    expect(fonts).toHaveLength(2)
  })

  it('returns [default] when nothing overrides', () => {
    const noOverride: SubtitleEntry[] = [makeEntry('e-001', 0, 1, 'a')]
    const fonts = collectUsedFontIds(noOverride, 'noto-sans-jp-semibold')
    expect(fonts).toEqual(['noto-sans-jp-semibold'])
  })
})

// ---------------------------------------------------------------------------
// parseProjectFile error paths
// ---------------------------------------------------------------------------

describe('parseProjectFile errors', () => {
  it('rejects invalid JSON', () => {
    const r = parseProjectFile('{ not: json')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('invalid-json')
  })

  it('rejects files without the MOJIOKO marker', () => {
    const r = parseProjectFile(JSON.stringify({ format: { app: 'OTHER', fileFormatVersion: 1 } }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('not-mojioko')
  })

  it('rejects future file-format versions', () => {
    const r = parseProjectFile(JSON.stringify({
      format: { app: 'MOJIOKO', fileFormatVersion: 999, appVersion: '1.3.3', savedAt: '' },
    }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('unsupported-version')
  })

  it('rejects files missing top-level groups', () => {
    const r = parseProjectFile(JSON.stringify({
      format: { app: 'MOJIOKO', fileFormatVersion: 1, appVersion: '1.3.3', savedAt: '' },
    }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('missing-fields')
  })
})
