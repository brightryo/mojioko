/**
 * REQ-0312 §2 — 禁則処理 (kinsoku).
 *
 * Wrap geometry used throughout: `applyAutoLineBreak(text, 50, 3, 1920)` gives
 * effectivePx = 1920 - 2*10 - 2*3 = 1894, and a wide glyph measures
 * 50 * FALLBACK_LIBASS_SCALE = 34.53px, so exactly 54 wide glyphs fit
 * (54 * 34.53 = 1864.6 <= 1894 < 55 * 34.53).  The raw break therefore lands at
 * index 54 — the same geometry the REQ-0303 pin uses, so these fixtures differ
 * from it only by which character sits at the boundary.
 */
import { describe, it, expect } from 'vitest'
import { applyAutoLineBreak } from '../../src/renderer/lib/auto-line-break'
import {
  applyKinsoku,
  KINSOKU_NO_LINE_START,
  KINSOKU_NO_LINE_END,
  KINSOKU_MAX_SHIFT,
} from '../../src/shared/kinsoku'

const FONT = 50
const OUT = 3
const W = 1920
const wrap = (t: string) => applyAutoLineBreak(t, FONT, OUT, W)
const lines = (t: string) => wrap(t).split('\\N')

describe('applyKinsoku — the pure rule', () => {
  it('pulls the break back off a line-start-prohibited character', () => {
    // index 3 is '。' → must not start a line
    expect(applyKinsoku('あいう。えお', 3)).toBe(2)
  })

  it('pulls the break back off a line-end-prohibited character', () => {
    // index 4 would leave '「' (index 3) ending the line
    expect(applyKinsoku('あいう「え', 4)).toBe(3)
  })

  it('walks past a run of prohibited characters', () => {
    // 'あいう」。えお': breaking at 4 would start line 2 with '。'; stepping back
    // to 3 would start it with '」', also prohibited; 2 is the first legal spot.
    expect(applyKinsoku('あいう」。えお', 4)).toBe(2)
  })

  it('leaves a position legal by construction alone', () => {
    // Breaking at 5 puts '」。' at the END of line 1, which no rule forbids.
    expect(applyKinsoku('あいう」。えお', 5)).toBe(5)
  })

  it('leaves a legal position untouched', () => {
    expect(applyKinsoku('あいうえお', 3)).toBe(3)
  })

  it('never moves the break later', () => {
    for (let i = 1; i < 6; i++) {
      expect(applyKinsoku('あ。い」う。え', i)).toBeLessThanOrEqual(i)
    }
  })

  it('falls back to the original when the run exceeds the shift budget', () => {
    const run = '。'.repeat(KINSOKU_MAX_SHIFT + 2)
    const text = 'あいう' + run + 'えお'
    const at = 3 + run.length - 1 // deep inside the run
    expect(applyKinsoku(text, at)).toBe(at)
  })

  it('falls back rather than empty the left line', () => {
    expect(applyKinsoku('。。。あ', 3)).toBe(3)
    expect(applyKinsoku('。あ', 1)).toBe(1)
  })

  it('is a no-op at the segment edges', () => {
    expect(applyKinsoku('あいう', 0)).toBe(0)
    expect(applyKinsoku('あいう', 3)).toBe(3)
  })

  it('is idempotent', () => {
    const t = 'あいう」。えお'
    const once = applyKinsoku(t, 5)
    expect(applyKinsoku(t, once)).toBe(once)
  })
})

describe('REQ-0312 §2 — 行頭禁則 (no line may START with these)', () => {
  for (const ch of ['。', '、', '）', '」', 'っ', 'ー', '！', '？', '々', 'ャ']) {
    it(`'${ch}' is not left at the start of line 2`, () => {
      const text = 'あ'.repeat(54) + ch + 'い'.repeat(10)
      const [l1, l2] = lines(text)
      // 追い出し moves the BREAK earlier, so the prohibited character travels to
      // line 2 together with the character before it — it is no longer leading.
      expect(l2.startsWith(ch)).toBe(false)
      expect(l2[1]).toBe(ch)
      expect(l1.endsWith(ch)).toBe(false)
      expect(l1 + l2).toBe(text) // nothing lost
    })
  }

  it('handles a two-character run 」。 together', () => {
    const text = 'あ'.repeat(53) + '」。' + 'い'.repeat(10)
    const [l1, l2] = lines(text)
    // Break steps back off '。' and then off '」', landing two characters early.
    expect(l1).toBe('あ'.repeat(52))
    expect(l2.startsWith('あ」。')).toBe(true)
    expect(l1 + l2).toBe(text)
  })
})

describe('REQ-0312 §2 — 行末禁則 (no line may END with these)', () => {
  for (const ch of ['「', '（', '『', '【', '〈']) {
    it(`'${ch}' is not left at the end of line 1`, () => {
      const text = 'あ'.repeat(53) + ch + 'い'.repeat(12)
      const [l1, l2] = lines(text)
      expect(l1.endsWith(ch)).toBe(false)
      expect(l2.startsWith(ch)).toBe(true)
      expect(l1 + l2).toBe(text)
    })
  }
})

describe('REQ-0312 §2 — fallback never breaks the layout', () => {
  it('keeps the original break when prohibited characters exceed the budget', () => {
    const text = 'あ'.repeat(54) + '。'.repeat(KINSOKU_MAX_SHIFT + 2) + 'い'.repeat(6)
    const out = wrap(text)
    // It still wraps, still loses nothing, and still never overflows.
    expect(out.split('\\N').join('')).toBe(text)
    expect(out).toContain('\\N')
  })

  it('never produces an empty line', () => {
    for (const t of [
      '。'.repeat(60),
      '「'.repeat(60),
      'あ'.repeat(54) + '。」）',
      '（' + 'あ'.repeat(60),
    ]) {
      for (const line of wrap(t).split('\\N')) {
        expect(line.length).toBeGreaterThan(0)
      }
    }
  })
})

describe('REQ-0312 §2 — nothing else moves', () => {
  it('the REQ-0303 Japanese pin is byte-identical', () => {
    // No kinsoku character anywhere → the wrap must be exactly as before.
    expect(wrap('あ'.repeat(60))).toBe('あ'.repeat(54) + '\\N' + 'あ'.repeat(6))
  })

  it('kinsoku-free Japanese of many lengths is unchanged', () => {
    for (const n of [55, 60, 80, 109, 120]) {
      const out = wrap('あ'.repeat(n))
      // Character-level wrapping at 54 per line, exactly as pre-REQ-0312.
      const expected: string[] = []
      for (let i = 0; i < n; i += 54) expected.push('あ'.repeat(Math.min(54, n - i)))
      expect(out).toBe(expected.join('\\N'))
    }
  })

  it('English wrapping is untouched — no ASCII punctuation is in the tables', () => {
    for (const ch of [')', ']', '}', '!', '?', '.', ',', "'", '’']) {
      expect(KINSOKU_NO_LINE_START.includes(ch)).toBe(false)
      expect(KINSOKU_NO_LINE_END.includes(ch)).toBe(false)
    }
  })

  /**
   * The strongest available statement of "English is unchanged": kinsoku is the
   * IDENTITY function at every index of an ASCII string, so it cannot influence
   * the break the rest of the pipeline picks.  Asserting properties of the
   * resulting lines instead would also pin unrelated pre-existing quirks of the
   * wrap (it can, for instance, leave a leading space on a line); that predates
   * this REQ and is deliberately left alone.
   */
  it('kinsoku is the identity function on ASCII, so English cannot shift', () => {
    const samples = [
      'the quick brown fox jumps over the lazy dog, and then it runs away today!',
      "don't split l'ami (parenthesised) [bracketed] {braced} - really!",
      'A sentence. Another one? Yes!',
    ]
    for (const en of samples) {
      for (let i = 0; i <= en.length; i++) {
        expect(applyKinsoku(en, i), `${en} @${i}`).toBe(i)
      }
    }
  })

  it('English words are still never split (REQ-0303 guarantee holds)', () => {
    const en = 'the quick brown fox jumps over the lazy dog, and then it runs away today'
    const out = applyAutoLineBreak(en, 50, 0, 300)
    // Word-wrap CONSUMES the whitespace it breaks at, so the lines rejoin with
    // a space rather than concatenating — every token must survive intact.
    const rejoined = out.split('\\N').join(' ').replace(/\s+/g, ' ').trim()
    for (const word of en.split(' ')) {
      expect(rejoined.split(' ')).toContain(word)
    }
  })
})

describe('REQ-0312 §2 — idempotency (REQ-0309 acceptance condition)', () => {
  const cases = [
    'あ'.repeat(54) + '。' + 'い'.repeat(10),
    'あ'.repeat(53) + '」。' + 'い'.repeat(10),
    'あ'.repeat(53) + '「' + 'い'.repeat(12),
    '「こんにちは、世界」と彼は静かに言った。'.repeat(4),
    'これはとても長い日本語の説明文であり、テスト用に用意された文章です。'.repeat(3),
    'mixed これは wonderful text with 日本語 and english words together、そして続く。',
    '。'.repeat(60),
  ]
  for (const [i, t] of cases.entries()) {
    it(`case ${i} converges on the first press`, () => {
      const once = wrap(t)
      expect(wrap(once)).toBe(once)
      expect(wrap(wrap(once))).toBe(once)
    })
  }
})

describe('REQ-0312 §2 — the tables', () => {
  it('cover every character the REQ lists for 行頭禁則', () => {
    for (const ch of '。、，．・：；？！ー゛゜ヽヾゝゞ々') {
      expect(KINSOKU_NO_LINE_START.includes(ch), ch).toBe(true)
    }
    for (const ch of 'ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ') {
      expect(KINSOKU_NO_LINE_START.includes(ch), ch).toBe(true)
    }
    for (const ch of '）］｝」』】〉》〕') {
      expect(KINSOKU_NO_LINE_START.includes(ch), ch).toBe(true)
    }
  })

  it('cover every character the REQ lists for 行末禁則', () => {
    for (const ch of '（［｛「『【〈《〔“‘〝') {
      expect(KINSOKU_NO_LINE_END.includes(ch), ch).toBe(true)
    }
  })

  it('keep the two sets disjoint', () => {
    for (const ch of KINSOKU_NO_LINE_START) {
      expect(KINSOKU_NO_LINE_END.includes(ch), ch).toBe(false)
    }
  })
})

/**
 * REQ-0315 §5 — characters added after RES-0314 §4-1 / §4-2 measured the gaps.
 *
 * `…` is the one that actually bit: common in transcripts, and measured leading
 * a line at videoWidth 1892.  `〜` did so even at the default 1920.  RES-0314
 * §4-4 verified in advance that adding all of these leaves every existing pin
 * untouched.
 */
describe('REQ-0315 §5 — widened tables', () => {
  for (const ch of ['…', '‥', '〜', 'ゕ', 'ゖ', '〻', '‼', '⁇', '⁈', '⁉']) {
    it(`'${ch}' may not START a line`, () => {
      expect(KINSOKU_NO_LINE_START.includes(ch)).toBe(true)
      const text = 'あ'.repeat(54) + ch + 'い'.repeat(10)
      const [l1, l2] = lines(text)
      expect(l2.startsWith(ch)).toBe(false)
      expect(l1 + l2).toBe(text)
    })
  }

  for (const ch of ['〖', '〘', '⦅']) {
    it(`'${ch}' may not END a line`, () => {
      expect(KINSOKU_NO_LINE_END.includes(ch)).toBe(true)
      const text = 'あ'.repeat(53) + ch + 'い'.repeat(12)
      const [l1, l2] = lines(text)
      expect(l1.endsWith(ch)).toBe(false)
      expect(l1 + l2).toBe(text)
    })
  }

  it('half-width forms remain EXCLUDED, keeping kinsoku identity on ASCII', () => {
    for (const ch of ['･', 'ﾞ', 'ﾟ', 'ｰ', '｡', '｣', '､', '｢']) {
      expect(KINSOKU_NO_LINE_START.includes(ch)).toBe(false)
      expect(KINSOKU_NO_LINE_END.includes(ch)).toBe(false)
    }
  })

  it('the REQ-0303 pin is still byte-identical after widening', () => {
    // Expressed through `lines()` so the ASS sentinel never has to appear
    // as a literal here (a mangled escape silently broke this once).
    expect(lines('あ'.repeat(60))).toEqual(['あ'.repeat(54), 'あ'.repeat(6)])
  })

  it('the widened set stays idempotent', () => {
    for (const t of [
      'あ'.repeat(54) + '…' + 'い'.repeat(10),
      'あ'.repeat(53) + '〖' + 'い'.repeat(12),
      'そうですね…だからこそ、今回の判断は難しい…でも、やるしかない',
    ]) {
      const once = wrap(t)
      expect(wrap(once)).toBe(once)
    }
  })
})
