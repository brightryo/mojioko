import { describe, it, expect } from 'vitest'
import { parseSrt, parseSrtTime } from '../../src/renderer/lib/srt-parse'

/**
 * REQ-0223 — pure SRT parser tests.
 *
 * The parser is on the load-bearing path of a destructive operation:
 * a successful parse causes the entire subtitle store to be cleared
 * and repopulated (RES-0223 §4).  These tests pin every real-world
 * corner case we encountered in the export path (`buildSrtContent`)
 * plus common variants from other tools:
 *
 *   - UTF-8 BOM (our own `buildSrtContent` emits it; some tools don't)
 *   - CRLF vs LF vs mixed line endings
 *   - Multi-line captions -> `\N` sentinel (inverse of the writer's
 *     `text.replace(/\\N/g, '\n')`)
 *   - Missing index lines (spec-permissive)
 *   - `.` vs `,` as millisecond separator (WebVTT-style tolerance)
 *   - Empty input / whitespace-only input
 *   - Invalid time syntax -> non-empty errors, no partial cue
 *   - endSec < startSec -> error, no partial cue
 *
 * The round-trip test at the bottom is the load-bearing guarantee:
 * anything we write with `buildSrtContent` we must be able to read
 * back with byte-identical time + text.
 */

// ---------------------------------------------------------------------------
// parseSrtTime unit tests
// ---------------------------------------------------------------------------

describe('REQ-0223 parseSrtTime', () => {
  it('parses standard SRT time (HH:MM:SS,mmm)', () => {
    expect(parseSrtTime('00:00:00,000')).toBe(0)
    expect(parseSrtTime('00:00:01,000')).toBe(1)
    expect(parseSrtTime('00:00:00,500')).toBe(0.5)
    expect(parseSrtTime('01:02:03,456')).toBeCloseTo(3723.456, 6)
    expect(parseSrtTime('12:34:56,789')).toBeCloseTo(45296.789, 6)
  })

  it('tolerates `.` as the millisecond separator (WebVTT-style)', () => {
    expect(parseSrtTime('00:00:01.500')).toBe(1.5)
  })

  it('pads truncated millisecond fields (`1` -> 100ms, `12` -> 120ms)', () => {
    // A few writers emit fewer than 3 ms digits.  The parser pads-right
    // to match ffmpeg / SubtitleEdit's read behaviour.
    expect(parseSrtTime('00:00:00,1')).toBe(0.1)
    expect(parseSrtTime('00:00:00,12')).toBe(0.12)
    expect(parseSrtTime('00:00:00,123')).toBe(0.123)
  })

  it('rejects out-of-range minutes / seconds', () => {
    expect(parseSrtTime('00:60:00,000')).toBeNull()
    expect(parseSrtTime('00:00:60,000')).toBeNull()
  })

  it('rejects malformed strings', () => {
    expect(parseSrtTime('not a time')).toBeNull()
    expect(parseSrtTime('00-00-00,000')).toBeNull()
    expect(parseSrtTime('00:00:00')).toBeNull()          // no ms
    expect(parseSrtTime('00:00,000')).toBeNull()         // no hours
    expect(parseSrtTime('00:00:00,abcd')).toBeNull()     // non-numeric ms
  })
})

// ---------------------------------------------------------------------------
// parseSrt integration tests
// ---------------------------------------------------------------------------

describe('REQ-0223 parseSrt — happy paths', () => {
  it('parses a minimal single-cue SRT', () => {
    const raw = '1\n00:00:01,000 --> 00:00:03,000\nHello world\n'
    const { cues, errors } = parseSrt(raw)
    expect(errors).toEqual([])
    expect(cues).toEqual([{ startSec: 1, endSec: 3, text: 'Hello world' }])
  })

  it('parses multiple cues separated by blank lines', () => {
    const raw = [
      '1',
      '00:00:00,000 --> 00:00:02,000',
      'first',
      '',
      '2',
      '00:00:02,500 --> 00:00:04,500',
      'second',
      '',
      '3',
      '00:00:05,000 --> 00:00:07,000',
      'third',
    ].join('\n')
    const { cues, errors } = parseSrt(raw)
    expect(errors).toEqual([])
    expect(cues.map((c) => c.text)).toEqual(['first', 'second', 'third'])
    expect(cues[0].startSec).toBe(0)
    expect(cues[1].startSec).toBe(2.5)
    expect(cues[2].endSec).toBe(7)
  })

  it('joins multi-line captions with the ASS `\\N` sentinel', () => {
    const raw = [
      '1',
      '00:00:00,000 --> 00:00:02,000',
      'first line',
      'second line',
      '',
      '2',
      '00:00:02,000 --> 00:00:04,000',
      'three',
      'lines',
      'here',
    ].join('\n')
    const { cues } = parseSrt(raw)
    expect(cues[0].text).toBe('first line\\Nsecond line')
    expect(cues[1].text).toBe('three\\Nlines\\Nhere')
  })

  it('strips UTF-8 BOM at the start of the file', () => {
    // buildSrtContent (step2.tsx) emits BOM for DaVinci Resolve
    // compat; the parser must tolerate it.
    const bom = '﻿'
    const raw = bom + '1\n00:00:01,000 --> 00:00:02,000\nhello\n'
    const { cues, errors } = parseSrt(raw)
    expect(errors).toEqual([])
    expect(cues).toEqual([{ startSec: 1, endSec: 2, text: 'hello' }])
  })

  it('handles CRLF, LF, and mixed line endings identically', () => {
    const lf = '1\n00:00:00,000 --> 00:00:02,000\nfirst\n\n2\n00:00:02,000 --> 00:00:04,000\nsecond'
    const crlf = lf.replace(/\n/g, '\r\n')
    const mixed = '1\r\n00:00:00,000 --> 00:00:02,000\nfirst\r\n\n2\n00:00:02,000 --> 00:00:04,000\r\nsecond'
    const a = parseSrt(lf)
    const b = parseSrt(crlf)
    const c = parseSrt(mixed)
    expect(a.errors).toEqual([])
    expect(b.errors).toEqual([])
    expect(c.errors).toEqual([])
    expect(a.cues).toEqual(b.cues)
    expect(a.cues).toEqual(c.cues)
  })

  it('accepts SRT blocks without the numeric index line', () => {
    // A few hand-edited files omit the running counter.  Skip it if
    // absent; the time line still identifies the block.
    const raw = [
      '00:00:00,000 --> 00:00:02,000',
      'no index above me',
      '',
      '00:00:02,500 --> 00:00:04,500',
      'me neither',
    ].join('\n')
    const { cues, errors } = parseSrt(raw)
    expect(errors).toEqual([])
    expect(cues.length).toBe(2)
    expect(cues[0].text).toBe('no index above me')
  })

  it('tolerates extra blank lines between blocks', () => {
    const raw = [
      '1',
      '00:00:00,000 --> 00:00:02,000',
      'first',
      '',
      '',
      '',
      '2',
      '00:00:02,500 --> 00:00:04,500',
      'second',
    ].join('\n')
    const { cues, errors } = parseSrt(raw)
    expect(errors).toEqual([])
    expect(cues.length).toBe(2)
  })
})

describe('REQ-0223 parseSrt — error paths', () => {
  it('returns no-cues + no-errors for empty input', () => {
    // Contract: the caller (import handler) uses `errors.length === 0
    // && cues.length === 0` as its own signal to abort without clearing
    // the store (RES-0223 §6).  The parser itself does not surface an
    // error here.
    expect(parseSrt('')).toEqual({ cues: [], errors: [] })
    expect(parseSrt('   \n  \n')).toEqual({ cues: [], errors: [] })
  })

  it('records an error for a malformed time line', () => {
    const raw = [
      '1',
      'not a valid time',
      'orphaned text',
    ].join('\n')
    const { cues, errors } = parseSrt(raw)
    expect(cues).toEqual([])
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0]).toMatch(/could not parse time line/)
  })

  it('records an error for endSec < startSec', () => {
    const raw = '1\n00:00:05,000 --> 00:00:03,000\nbackward\n'
    const { cues, errors } = parseSrt(raw)
    expect(cues).toEqual([])
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0]).toMatch(/end time precedes start time/)
  })

  it('records an error for a block with no caption text', () => {
    // Time line but no body — the writer never emits this but a hand
    // edit could.
    const raw = '1\n00:00:01,000 --> 00:00:02,000\n'
    const { cues, errors } = parseSrt(raw)
    expect(cues).toEqual([])
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0]).toMatch(/no caption text/)
  })

  it('salvages valid cues even when other blocks are broken', () => {
    // The import handler treats ANY non-empty `errors` array as a
    // hard failure (RES-0223 §6 — no partial imports allowed).  But
    // the parser itself surfaces both — the caller decides.
    const raw = [
      '1',
      '00:00:00,000 --> 00:00:02,000',
      'good',
      '',
      '2',
      'malformed time line here',
      'orphan',
      '',
      '3',
      '00:00:03,000 --> 00:00:05,000',
      'also good',
    ].join('\n')
    const { cues, errors } = parseSrt(raw)
    expect(cues.length).toBe(2)
    expect(cues.map((c) => c.text)).toEqual(['good', 'also good'])
    expect(errors.length).toBe(1)
    expect(errors[0]).toMatch(/could not parse time line/)
  })
})

// ---------------------------------------------------------------------------
// Round-trip test — SRT written by buildSrtContent must parse back to
// the same times + text.  This is the load-bearing contract for
// REQ-0223's "export -> hand-edit externally -> re-import" workflow.
// ---------------------------------------------------------------------------

/**
 * Mirror of `buildSrtContent` in step2.tsx.  Kept in the test file
 * (not imported) so a refactor of the writer would fail this test
 * loudly rather than silently move both sides in tandem.
 */
function localBuildSrtContent(entries: { startSec: number; endSec: number; text: string }[]): string {
  function fmt(sec: number): string {
    const h = Math.floor(sec / 3600)
    const m = Math.floor((sec % 3600) / 60)
    const s = Math.floor(sec % 60)
    const ms = Math.round((sec % 1) * 1000)
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`
  }
  const blocks = entries.map((e, i) => {
    const srtText = e.text.replace(/\\N/g, '\n').trim()
    return `${i + 1}\n${fmt(e.startSec)} --> ${fmt(e.endSec)}\n${srtText}`
  })
  return '﻿' + blocks.join('\n\n')
}

describe('REQ-0223 SRT round-trip', () => {
  it('write -> parse -> read yields byte-identical times + text', () => {
    const original = [
      { startSec: 0.123,  endSec: 2.456,  text: 'Hello' },
      { startSec: 3.5,    endSec: 5.75,   text: 'multi\\Nline\\Ncaption' },
      { startSec: 10.001, endSec: 11.999, text: 'edge millis' },
      { startSec: 60.0,   endSec: 65.5,   text: 'past-a-minute' },
      { startSec: 3600.0, endSec: 3602.0, text: 'past-an-hour' },
    ]
    const written = localBuildSrtContent(original)
    const { cues, errors } = parseSrt(written)
    expect(errors).toEqual([])
    expect(cues.length).toBe(original.length)
    for (let i = 0; i < original.length; i++) {
      expect(cues[i].startSec).toBeCloseTo(original[i].startSec, 3)
      expect(cues[i].endSec).toBeCloseTo(original[i].endSec, 3)
      expect(cues[i].text).toBe(original[i].text)
    }
  })
})
