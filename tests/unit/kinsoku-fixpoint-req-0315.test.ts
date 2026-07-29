import { describe, it, expect } from 'vitest'
import { applyAutoLineBreak } from '../../src/renderer/lib/auto-line-break'
import { isNoLineEndChar, isNoLineStartChar } from '../../src/shared/kinsoku'

const NL = String.fromCharCode(92) + 'N'
const lines = (t: string, w = 1920) => applyAutoLineBreak(t, 50, 3, w).split(NL)

/**
 * REQ-0315 §6 — kinsoku and the Latin word rule must reach a FIXED POINT.
 *
 * Running kinsoku only BEFORE `adjustBreak` left a hole: `adjustBreak` moves the
 * break back to the preceding whitespace, and the character that then ends the
 * line is whatever preceded that space — which may itself be prohibited.  The
 * reproduction found in RES-0314 §4-3 is the first test below.
 *
 * A single extra pass would not close it either, because that pass can land the
 * break inside a Latin word and require `adjustBreak` once more.
 */
describe('REQ-0315 §6 — no rule may leave a violation behind', () => {
  it('the RES-0314 §4-3 reproduction is fixed', () => {
    const text = 'あ'.repeat(50) + '「 supercalifragilistic'
    const [l1] = lines(text)
    expect(isNoLineEndChar(l1[l1.length - 1])).toBe(false)
  })

  it('holds across the window where the reproduction was found', () => {
    for (let n = 46; n <= 56; n++) {
      const text = 'あ'.repeat(n) + '「 supercalifragilistic'
      const ls = lines(text)
      if (ls.length < 2) continue
      for (let i = 0; i < ls.length; i++) {
        const line = ls[i]
        if (i < ls.length - 1) {
          expect(isNoLineEndChar(line[line.length - 1]), `n=${n} line${i} end`).toBe(false)
        }
        if (i > 0) expect(isNoLineStartChar(line[0]), `n=${n} line${i} start`).toBe(false)
      }
    }
  })

  it('mixed JA/EN with brackets around Latin words stays legal on both edges', () => {
    const fixtures = [
      'これは「 wonderful 」というテストです' + 'あ'.repeat(40),
      'あ'.repeat(48) + '（ parenthesised ）続きの文章です',
      'テスト「 alpha bravo charlie delta echo foxtrot 」おわり',
    ]
    for (const t of fixtures) {
      for (const w of [1920, 1400, 1000, 760]) {
        const ls = lines(t, w)
        for (let i = 0; i < ls.length; i++) {
          if (ls[i].length === 0) continue
          if (i < ls.length - 1) expect(isNoLineEndChar(ls[i][ls[i].length - 1])).toBe(false)
          if (i > 0) expect(isNoLineStartChar(ls[i][0])).toBe(false)
        }
      }
    }
  })

  it('terminates and stays idempotent on the adversarial fixtures', () => {
    for (const t of [
      'あ'.repeat(50) + '「 supercalifragilistic',
      'これは「 wonderful 」というテストです' + 'あ'.repeat(40),
      '「'.repeat(30) + ' word ' + '」'.repeat(30),
    ]) {
      const once = applyAutoLineBreak(t, 50, 3, 1920)
      expect(applyAutoLineBreak(once, 50, 3, 1920)).toBe(once)
    }
  })

  it('kinsoku-free Japanese is still byte-identical (REQ-0303 pin)', () => {
    expect(lines('あ'.repeat(60))).toEqual(['あ'.repeat(54), 'あ'.repeat(6)])
  })

  it('English-only text is untouched — kinsoku never engages', () => {
    const en = 'the quick brown fox jumps over the lazy dog and runs away today'
    const before = applyAutoLineBreak(en, 50, 0, 300)
    expect(applyAutoLineBreak(before, 50, 0, 300)).toBe(before)
    for (const line of before.split(NL)) expect(line.length).toBeGreaterThan(0)
  })
})
