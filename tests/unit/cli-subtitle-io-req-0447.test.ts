import { describe, it, expect } from 'vitest'
import { detectFormat, entriesToSrt } from '../../src/main/cli/subtitle-io'
import type { SubtitleEntry } from '../../src/shared/types'

/** REQ-0447 — pure CLI subtitle I/O guards (format detection + SRT serialize). */
describe('REQ-0447 — detectFormat', () => {
  it('uses explicit --format, else the extension', () => {
    expect(detectFormat('out.mojioko')).toBe('mojioko')
    expect(detectFormat('out.srt')).toBe('srt')
    expect(detectFormat('OUT.SRT')).toBe('srt')
    expect(detectFormat('out.mp4', 'srt')).toBe('srt') // override wins
    expect(detectFormat('out.xyz')).toBeNull()
    expect(detectFormat('out.srt', 'bogus')).toBeNull() // explicit but unknown
  })
})

describe('REQ-0447 — entriesToSrt', () => {
  const e = (over: Partial<SubtitleEntry>): SubtitleEntry =>
    ({ id: 'x', startSec: 0, endSec: 1, text: 'x', isDeleted: false, isEdited: false, ...over }) as SubtitleEntry

  it('numbers cues, converts \\N to newline, drops deleted/empty, prepends BOM', () => {
    const entries = [
      e({ startSec: 0, endSec: 1.5, text: 'line1\\Nline2' }),
      e({ startSec: 2, endSec: 3, text: '   ', isDeleted: false }), // empty → dropped
      e({ startSec: 4, endSec: 5, text: 'gone', isDeleted: true }), // deleted → dropped
      e({ startSec: 6, endSec: 7.25, text: 'こんにちは' }),
    ]
    const srt = entriesToSrt(entries)
    expect(srt.charCodeAt(0)).toBe(0xfeff) // BOM
    expect(srt).toContain('1\n00:00:00,000 --> 00:00:01,500\nline1\nline2')
    expect(srt).toContain('2\n00:00:06,000 --> 00:00:07,250\nこんにちは')
    expect(srt).not.toContain('gone')
    // only two blocks survived → highest index is 2
    expect(srt).not.toContain('3\n00')
  })
})
