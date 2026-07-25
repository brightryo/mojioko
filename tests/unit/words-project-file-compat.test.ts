import { describe, it, expect } from 'vitest'
import { parseProjectFile } from '../../src/shared/project-file'

/**
 * REQ-0285 — backward-compat pin for `SubtitleEntry.words`.
 *
 * The rule: **existing project files (no `words` field on entries)
 * must load unchanged, and forward-format files with `words` must
 * also load without throwing**.  Both are structural invariants of
 * the `parseProjectFile` shape cast (it does not enforce a schema per
 * entry — deeper validation is deferred to hydration).  The tests
 * below just prove the assumption still holds after REQ-0285.
 *
 * If a future REQ tightens `parseProjectFile` (or hydration) with a
 * schema check, these tests catch any regression that would refuse
 * either shape.
 */

const V1_HEADER = {
  format: {
    app: 'MOJIOKO',
    fileFormatVersion: 1,
    appVersion: '1.3.5',
    savedAt: '2026-07-25T00:00:00.000Z',
  },
  source: {
    filePath: 'C:/videos/x.mp4',
    hasVideoStream: true,
    resolution: { width: 1920, height: 1080 },
    durationSec: 10,
    fps: 30,
    container: 'mp4',
    videoCodec: 'h264',
    audioTracks: [],
    fileSizeBytes: 0,
  },
  transcription: {
    defaults: {
      fontSizePx: 100,
      textColorHex: '#FFFFFF',
      outlineColorHex: '#000000',
      outlineThicknessPx: 3,
      whisperModel: 'large-v3',
    },
  },
  editing: {
    subtitles: [] as unknown[],
    cuts: [],
  },
}

function makeEntry(withWords: boolean) {
  const base = {
    id: 'e1',
    startSec: 0,
    endSec: 2,
    text: 'hello world',
    fontSizePx: 100,
    textColorHex: '#FFFFFF',
    outlineColorHex: '#000000',
    outlineThicknessPx: 3,
    fadeDurationSec: 0,
    horizontalPosition: 'center',
    verticalPosition: 'bottom',
    verticalMarginPx: 40,
    subtitleBackground: { enabled: false, color: 'black', opacityPercent: 50 },
    isDeleted: false,
    isEdited: false,
    original: {
      startSec: 0,
      endSec: 2,
      text: 'hello world',
      fontSizePx: 100,
      textColorHex: '#FFFFFF',
      outlineColorHex: '#000000',
      outlineThicknessPx: 3,
      fadeDurationSec: 0,
      horizontalPosition: 'center',
      verticalPosition: 'bottom',
      verticalMarginPx: 40,
      subtitleBackground: { enabled: false, color: 'black', opacityPercent: 50 },
    },
  }
  if (withWords) {
    ;(base as unknown as { words: unknown }).words = [
      { startSec: 0, endSec: 0.5, text: 'hello' },
      { startSec: 0.5, endSec: 1.0, text: ' world' },
    ]
  }
  return base
}

describe('REQ-0285 — SubtitleEntry.words project-file backward compat', () => {
  it('pre-REQ-0285 project file (entries without `words`) parses cleanly', () => {
    const project = {
      ...V1_HEADER,
      editing: {
        subtitles: [makeEntry(false), makeEntry(false)],
        cuts: [],
      },
    }
    const raw = JSON.stringify(project)
    const result = parseProjectFile(raw)
    expect(result.ok).toBe(true)
    if (result.ok) {
      const entries = result.project.editing.subtitles as unknown as Array<{ words?: unknown }>
      expect(entries.length).toBe(2)
      // The `words` field is genuinely absent on legacy entries (not
      // just undefined via key-in-parse).  Consumers reading
      // `entry.words` get `undefined`; validity helper short-circuits.
      expect('words' in entries[0]).toBe(false)
      expect('words' in entries[1]).toBe(false)
    }
  })

  it('post-REQ-0285 project file (entries WITH `words`) parses cleanly and preserves the array', () => {
    const project = {
      ...V1_HEADER,
      editing: {
        subtitles: [makeEntry(true)],
        cuts: [],
      },
    }
    const raw = JSON.stringify(project)
    const result = parseProjectFile(raw)
    expect(result.ok).toBe(true)
    if (result.ok) {
      const entries = result.project.editing.subtitles as unknown as Array<{
        words?: Array<{ startSec: number; endSec: number; text: string }>
      }>
      expect(entries[0].words).toEqual([
        { startSec: 0, endSec: 0.5, text: 'hello' },
        { startSec: 0.5, endSec: 1.0, text: ' world' },
      ])
    }
  })

  it('empty words array parses cleanly (segment carried no timed words)', () => {
    const project = {
      ...V1_HEADER,
      editing: {
        subtitles: [(() => {
          const e = makeEntry(false) as unknown as Record<string, unknown>
          e.words = []
          return e
        })()],
        cuts: [],
      },
    }
    const raw = JSON.stringify(project)
    const result = parseProjectFile(raw)
    expect(result.ok).toBe(true)
    if (result.ok) {
      const entries = result.project.editing.subtitles as unknown as Array<{ words?: unknown[] }>
      expect(entries[0].words).toEqual([])
    }
  })

  it('mixed project (some entries with words, some without) both survive', () => {
    const project = {
      ...V1_HEADER,
      editing: {
        subtitles: [makeEntry(true), makeEntry(false), makeEntry(true)],
        cuts: [],
      },
    }
    const raw = JSON.stringify(project)
    const result = parseProjectFile(raw)
    expect(result.ok).toBe(true)
    if (result.ok) {
      const entries = result.project.editing.subtitles as unknown as Array<{ words?: unknown[] }>
      expect(entries.length).toBe(3)
      expect(entries[0].words).toBeDefined()
      expect(entries[1].words).toBeUndefined()
      expect(entries[2].words).toBeDefined()
    }
  })
})
