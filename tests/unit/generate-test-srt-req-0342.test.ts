import { describe, it, expect } from 'vitest'
import { execFileSync } from 'child_process'
import { readFileSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { parseSrt } from '../../src/renderer/lib/srt-parse'

/**
 * REQ-0342 §1 — the generated SRT is readable by the app that has to read it.
 *
 * The generator exists so performance work can start from a file of any size.
 * A generator whose output the importer rejects is worse than none: the
 * failure shows up as "the app can't open it" at the moment somebody is
 * trying to measure something else entirely.  So the acceptance criterion is
 * not "it looks like SRT" — it is `parseSrt` returning zero errors and the
 * right number of cues, checked by running the real script.
 *
 * This also pins the two format details that are easy to lose: the UTF-8 BOM
 * (DaVinci Resolve requires it) and multi-line captions joining with the
 * literal `\N` sentinel rather than a newline.
 */
const SCRIPT = path.resolve(__dirname, '../../scripts/generate-test-srt.mjs')

function generate(args: string[]): { text: string; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'mojioko-srt-'))
  const out = path.join(dir, 'out.srt')
  execFileSync(process.execPath, [SCRIPT, ...args, '--out', out], { encoding: 'utf8' })
  return { text: readFileSync(out, 'utf8'), dir }
}

describe('REQ-0342 §1 — generate-test-srt produces importable files', () => {
  for (const kind of ['ja', 'en', 'mixed', 'long']) {
    it(`--kind ${kind} parses with zero errors`, () => {
      const { text, dir } = generate(['--count', '25', '--duration', '600', '--kind', kind])
      try {
        const r = parseSrt(text)
        expect(r.errors).toEqual([])
        expect(r.cues).toHaveLength(25)
        for (const c of r.cues) {
          expect(c.endSec).toBeGreaterThan(c.startSec)
          expect(c.text.trim().length).toBeGreaterThan(0)
        }
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  }

  it('emits the UTF-8 BOM DaVinci Resolve requires', () => {
    const { text, dir } = generate(['--count', '3', '--duration', '60'])
    try {
      expect(text.charCodeAt(0)).toBe(0xfeff)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('every cue fits inside the requested timeline, in order', () => {
    // The import path DROPS cues past the video duration rather than clamping
    // them (step2.tsx runSrtImport), so a generator that overruns its own
    // --duration would silently produce fewer rows than asked for.
    const { text, dir } = generate(['--count', '500', '--duration', '3600', '--kind', 'ja'])
    try {
      const { cues, errors } = parseSrt(text)
      expect(errors).toEqual([])
      expect(cues).toHaveLength(500)
      expect(cues[0].startSec).toBeGreaterThanOrEqual(0)
      expect(cues[cues.length - 1].endSec).toBeLessThanOrEqual(3600)
      for (let i = 1; i < cues.length; i++) {
        expect(cues[i].startSec).toBeGreaterThanOrEqual(cues[i - 1].endSec)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('is deterministic — same arguments, same bytes', () => {
    // A benchmark whose input changes between runs is not a benchmark.
    const a = generate(['--count', '40', '--duration', '600', '--kind', 'mixed'])
    const b = generate(['--count', '40', '--duration', '600', '--kind', 'mixed'])
    try {
      expect(a.text).toBe(b.text)
    } finally {
      rmSync(a.dir, { recursive: true, force: true })
      rmSync(b.dir, { recursive: true, force: true })
    }
  })

  it('the four kinds really are different text, not the same corpus relabelled', () => {
    const dirs: string[] = []
    try {
      const texts = ['ja', 'en', 'mixed', 'long'].map((k) => {
        const g = generate(['--count', '8', '--duration', '120', '--kind', k])
        dirs.push(g.dir)
        return parseSrt(g.text).cues.map((c) => c.text).join('')
      })
      expect(new Set(texts).size).toBe(4)
      // `en` must contain spaces (the adjustBreak path needs Latin word
      // boundaries); `ja` must not (the CJK per-character path).
      expect(texts[1]).toMatch(/[A-Za-z] [A-Za-z]/)
      expect(texts[0]).not.toMatch(/[A-Za-z] [A-Za-z]/)
    } finally {
      for (const d of dirs) rmSync(d, { recursive: true, force: true })
    }
  })
})
