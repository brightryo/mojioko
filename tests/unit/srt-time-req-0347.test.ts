import { describe, it, expect } from 'vitest'
import { execFileSync } from 'child_process'
import { readFileSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { formatSrtTime, SRT_TIME_PATTERN } from '../../src/shared/srt-time'
import { parseSrt } from '../../src/renderer/lib/srt-parse'

/**
 * REQ-0347 §1 — the SRT exporter cannot emit a milliseconds field of 1000.
 *
 * ## The defect
 *
 * `formatSrtTime` computed the seconds and the milliseconds independently:
 *
 *   const s  = Math.floor(sec % 60)
 *   const ms = Math.round((sec % 1) * 1000)
 *
 * so a `sec` whose fractional part rounds up to a whole second produced
 * `00:19:54,1000` — the carry belonged to one expression and was needed by
 * the other.  "Export as SRT (DaVinci Resolve compatible)" is a core feature,
 * and the file it wrote in that case was malformed.
 *
 * The same two lines existed in `scripts/generate-test-srt.mjs`; REQ-0346
 * fixed that copy and, because there were two, left the shipped one broken.
 *
 * ## Why these assertions are shaped this way
 *
 * The values that trigger this are ones nobody would think to write into a
 * golden file — `1194.9999999` arises from arithmetic, not from intent.  So
 * the tests state the RULE (the output always matches `SRT_TIME_PATTERN`;
 * milliseconds are always 000-999) and then sweep a large range looking for
 * a counter-example, rather than pinning a handful of outputs.  Same reasoning
 * as the karaoke-syllable gate in REQ-0338 §4-1.
 */
describe('REQ-0347 §1 — formatSrtTime', () => {
  it('never emits a milliseconds field outside 000-999', () => {
    // The exact family that produced the bug: values a hair below a whole
    // second, which `Math.round` lifts to 1000.
    const carriers = [
      1194.9999999, 1199.9999999, 0.9999999, 59.9999999, 3599.9999999,
      1194.99999999, 4.5999999999, 1e-9, 0.9995, 59.9995, 3599.9995,
    ]
    for (const sec of carriers) {
      const out = formatSrtTime(sec)
      expect(out, `formatSrtTime(${sec})`).toMatch(SRT_TIME_PATTERN)
      const ms = Number(out.slice(-3))
      expect(ms, `${sec} -> ${out}`).toBeLessThanOrEqual(999)
    }
  })

  it('carries into the seconds field instead of overflowing the milliseconds', () => {
    // The specific regression, stated as the behaviour rather than a string:
    // a value 0.1 ns below 1195 s is 19 m 55 s, not 19 m 54 s + 1000 ms.
    expect(formatSrtTime(1194.9999999)).toBe('00:19:55,000')
    expect(formatSrtTime(59.9999999)).toBe('00:01:00,000')
    expect(formatSrtTime(3599.9999999)).toBe('01:00:00,000')
  })

  it('matches the format for a wide sweep of ordinary values', () => {
    // 0 s to ~3 hours in irregular steps, so the sweep lands on many
    // different fractional remainders rather than a repeating pattern.
    for (let i = 0; i < 20000; i++) {
      const sec = i * 0.5407
      const out = formatSrtTime(sec)
      expect(out, `formatSrtTime(${sec})`).toMatch(SRT_TIME_PATTERN)
    }
  })

  it('clamps negatives rather than emitting a negative timestamp', () => {
    expect(formatSrtTime(-1)).toBe('00:00:00,000')
    expect(formatSrtTime(-0.4)).toBe('00:00:00,000')
  })

  it('round-trips through parseSrt', () => {
    // Formatting is only half the contract: the app must be able to read
    // back what it writes.
    const secs = [0, 1194.9999999, 59.9999999, 12.345, 3671.007]
    for (const s of secs) {
      const body = `1\n${formatSrtTime(s)} --> ${formatSrtTime(s + 2)}\nhello`
      const { cues, errors } = parseSrt('﻿' + body)
      expect(errors, `parse of ${s}`).toEqual([])
      expect(cues).toHaveLength(1)
      expect(cues[0].startSec).toBeCloseTo(Math.round(s * 1000) / 1000, 3)
    }
  })
})

/**
 * REQ-0347 §1-2 — the generator's own copy has not drifted from this one.
 *
 * `scripts/generate-test-srt.mjs` keeps a private copy of this function: it
 * is a plain `.mjs` run by bare `node`, so importing the TypeScript module
 * would mean adding `tsx` (or a build step) as a dependency of a dev script.
 * That was judged not worth doing immediately before a Store submission for a
 * script that never ships.
 *
 * Duplication that nothing checks is exactly what let this bug live in two
 * places, so the copies are diffed here against the real generator's real
 * output.  If someone edits one and not the other, this fails.
 */
describe('REQ-0347 §1-2 — generator timestamps agree with the shared formatter', () => {
  it('every timestamp the generator writes matches formatSrtTime', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mojioko-srt-time-'))
    const out = path.join(dir, 'out.srt')
    try {
      // 4.6 s cues over 1200 s is the exact shape that exposed the bug
      // (REQ-0346 §6-3): it accumulates remainders like 1194.9999999.
      execFileSync(
        process.execPath,
        [
          path.resolve(__dirname, '../../scripts/generate-test-srt.mjs'),
          '--count', '250', '--duration', '1200', '--cue', '5', '--gap', '0.2',
          '--kind', 'mixed', '--out', out,
        ],
        { encoding: 'utf8' },
      )
      const text = readFileSync(out, 'utf8')

      const stamps = [...text.matchAll(/^(\d{2}:\d{2}:\d{2},\d+) --> (\d{2}:\d{2}:\d{2},\d+)$/gm)]
      expect(stamps.length, 'generator produced timestamp lines').toBe(250)
      for (const [, start, end] of stamps) {
        expect(start, 'generator start timestamp').toMatch(SRT_TIME_PATTERN)
        expect(end, 'generator end timestamp').toMatch(SRT_TIME_PATTERN)
      }

      // Stronger than the format check: re-derive each timestamp from the
      // parsed seconds with THIS module and require the same string back.
      const { cues, errors } = parseSrt(text)
      expect(errors).toEqual([])
      for (let i = 0; i < cues.length; i++) {
        expect(formatSrtTime(cues[i].startSec), `cue ${i + 1} start`).toBe(stamps[i][1])
        expect(formatSrtTime(cues[i].endSec), `cue ${i + 1} end`).toBe(stamps[i][2])
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/**
 * REQ-0347 §1-4 — a file written by an older build is still readable.
 *
 * Versions up to v1.3.5 could write `,1000`.  Users have those files, and
 * "import the SRT I exported yesterday" must not fail because of a bug on the
 * writing side.  This pins whatever the reader actually does with them, so a
 * future parser change cannot quietly drop that compatibility.
 */
describe('REQ-0347 §1-4 — legacy malformed timestamps', () => {
  it('parseSrt accepts a `,1000` timestamp written by an older build', () => {
    const legacy = '﻿1\n00:19:54,1000 --> 00:19:59,800\nこんにちは'
    const { cues, errors } = parseSrt(legacy)
    expect(errors, 'a 4-digit ms field must not fail the import').toEqual([])
    expect(cues).toHaveLength(1)
    // Documenting the interpretation, not endorsing it: the reader takes the
    // field as milliseconds, so 1000 ms reads as a whole extra second — which
    // is what the writer meant before it lost the carry.
    expect(cues[0].startSec).toBeCloseTo(19 * 60 + 55, 3)
  })
})
