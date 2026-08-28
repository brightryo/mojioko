/**
 * REQ-0529 — cues that reach past the end of the video are reported headlessly.
 *
 * The behavioural half (a real burn, real pixels, the warning actually riding
 * the result JSON) is in `scripts/cli-smoke.mjs` / `mcp-smoke.mjs`. What is
 * pinned here is the judgement itself, its two-way split, and — most
 * importantly — that the GUI badge and the CLI warning are ONE predicate.
 *
 * NEGATIVE CONTROLS (§3-3, CLAUDE.md §18 "負の対照に git checkout を使わない"):
 * the pre-REQ-0529 behaviour is written out in place as a one-line function and
 * asserted to fail the checks the new code passes. No git, no source swap.
 *
 * BOTH SIDES (§3-1): every "it warns" case is paired with an in-range case
 * asserting silence, because a detector that always fires is the same as no
 * detector (this module's own bar, `no-op-warnings.ts` docstring).
 */
import { describe, it, expect } from 'vitest'
import {
  isCueBeyondVideoEnd,
  classifyCuesBeyondVideoEnd,
} from '../../src/shared/cue-duration'
import { computeEntryWarnings } from '../../src/renderer/lib/entry-warnings'
import { detectCuesBeyondVideoEnd } from '../../src/main/cli/no-op-warnings'
import type { SubtitleEntry } from '../../src/shared/types'

const cue = (id: string, startSec: number, endSec: number, extra: Partial<SubtitleEntry> = {}): SubtitleEntry =>
  ({ id, startSec, endSec, text: 'x', fontSizePx: 48, isDeleted: false, ...extra } as unknown as SubtitleEntry)

const DUR = 7

describe('REQ-0529 §1-1 — the GUI badge and the CLI warning are one predicate', () => {
  /**
   * The point of moving the predicate to `shared/`. If someone re-inlines a
   * copy in either place, these disagree and this fails — which is the whole
   * reason the move was made rather than writing a second test.
   */
  it('computeEntryWarnings().overDuration === isCueBeyondVideoEnd()', () => {
    const cases: Array<[number, number]> = [
      [0, 5], [0, 7], [0, 7.001], [6.9, 7], [7, 8], [7.5, 9], [0, 0.001],
    ]
    for (const [s, e] of cases) {
      const viaGui = computeEntryWarnings(cue('c', s, e), null, DUR, false).overDuration
      const viaShared = isCueBeyondVideoEnd({ startSec: s, endSec: e }, DUR)
      expect(viaShared, `disagreement at ${s}->${e}`).toBe(viaGui)
    }
  })

  it('NEGATIVE CONTROL — a plausible re-implementation (>=) disagrees, and is caught', () => {
    // The obvious "tidy" rewrite someone might make: treat a cue ending exactly
    // at the duration as over. It differs on precisely one of the cases above.
    const rewritten = (s: number, e: number) => s >= DUR || e >= DUR
    const disagreements = ([[0, 7], [7, 8]] as Array<[number, number]>).filter(
      ([s, e]) => rewritten(s, e) !== isCueBeyondVideoEnd({ startSec: s, endSec: e }, DUR),
    )
    expect(
      disagreements.length,
      'the control no longer perturbs anything — a second implementation would ' +
        'now be indistinguishable, so this test has stopped protecting the move to shared/',
    ).toBeGreaterThan(0)
  })

  it('a cue ending exactly at the duration is NOT beyond it', () => {
    expect(isCueBeyondVideoEnd({ startSec: 0, endSec: DUR }, DUR)).toBe(false)
  })

  it('Infinity (audio-only / no video) is never beyond', () => {
    expect(isCueBeyondVideoEnd({ startSec: 0, endSec: 99999 }, Infinity)).toBe(false)
  })
})

describe('REQ-0529 §1-6 — the two cases are counted apart', () => {
  it('a cue that OVERHANGS the end counts as truncated, not missing', () => {
    const r = classifyCuesBeyondVideoEnd([cue('a', 5, 16)], DUR)
    expect(r).toEqual({ cueCount: 1, notShownCount: 0, truncatedCount: 1, videoDurationSec: DUR })
  })

  it('a cue that STARTS after the end counts as never drawn', () => {
    const r = classifyCuesBeyondVideoEnd([cue('a', 9, 12)], DUR)
    expect(r).toEqual({ cueCount: 1, notShownCount: 1, truncatedCount: 0, videoDurationSec: DUR })
  })

  /**
   * ★ Why the split exists at all. REQ-0529 framed every such cue as "not in
   * the output"; measured on real pixels (RES-0529 §1-2) an overhanging cue is
   * drawn right up to the final frame. Calling it missing would send the user
   * hunting for a subtitle that is on screen.
   */
  it('a mixed project reports both counts', () => {
    const r = classifyCuesBeyondVideoEnd(
      [cue('ok', 0, 3), cue('over', 5, 16), cue('past', 9, 12), cue('past2', 20, 22)],
      DUR,
    )
    expect(r.cueCount).toBe(3)
    expect(r.truncatedCount).toBe(1)
    expect(r.notShownCount).toBe(2)
  })

  it('★ BOTH SIDES — an entirely in-range project reports nothing', () => {
    const r = classifyCuesBeyondVideoEnd([cue('a', 0, 3), cue('b', 3, DUR)], DUR)
    expect(r).toEqual({ cueCount: 0, notShownCount: 0, truncatedCount: 0, videoDurationSec: DUR })
  })

  it('deleted cues are ignored — generateAss drops them before rendering', () => {
    const r = classifyCuesBeyondVideoEnd([cue('gone', 5, 16, { isDeleted: true })], DUR)
    expect(r.cueCount).toBe(0)
  })
})

describe('REQ-0529 §1 — the emitted warning', () => {
  it('fires with the counts and a remedy the user can act on', () => {
    const w = detectCuesBeyondVideoEnd([cue('a', 5, 16), cue('b', 9, 12)], DUR)
    expect(w).toHaveLength(1)
    expect(w[0].code).toBe('CUE_BEYOND_VIDEO_END')
    const d = w[0].detail as Record<string, unknown>
    expect(d.cueCount).toBe(2)
    expect(d.truncatedCount).toBe(1)
    expect(d.notShownCount).toBe(1)
    expect(String(d.remedy)).toContain('時間を調整')
    // The message must carry the count — a caller logging only `message`
    // should still learn how many cues are affected.
    expect(w[0].message).toContain('2 件')
  })

  it('NEGATIVE CONTROL — the pre-REQ-0529 path emitted nothing at all', () => {
    const preFix = (_e: readonly SubtitleEntry[], _d: number) => []
    expect(preFix([cue('a', 5, 16)], DUR), 'sanity: headless really was silent').toEqual([])
    expect(
      preFix([cue('a', 5, 16)], DUR).length > 0,
      'the pre-fix behaviour must FAIL the "it warns" property this REQ adds',
    ).toBe(false)
    // …and the fixed path passes the same property.
    expect(detectCuesBeyondVideoEnd([cue('a', 5, 16)], DUR).length > 0).toBe(true)
  })

  it('★ BOTH SIDES — silent for an in-range project', () => {
    expect(detectCuesBeyondVideoEnd([cue('a', 0, 3), cue('b', 3, DUR)], DUR)).toEqual([])
  })

  it('silent when the duration is unknown (0 / synthetic video)', () => {
    // `convert` without --video writes durationSec: 0. Warning on every cue
    // there would be the "always fires" failure the module bars.
    expect(detectCuesBeyondVideoEnd([cue('a', 5, 16)], 0)).toEqual([])
    expect(detectCuesBeyondVideoEnd([cue('a', 5, 16)], Infinity)).toEqual([])
  })
})
