/**
 * REQ-0530 — the GUI burn and the CLI burn select the SAME cues.
 *
 * The behavioural half (real burns, real pixels, both paths) is in
 * `scripts/cli-smoke.mjs`. What is pinned here is the set algebra: given one
 * project, the renderer's `isBurninTarget` filter and the headless path's
 * filter must agree, so the GUI can never again silently render a different
 * subtitle track from the one the CLI produces.
 *
 * NEGATIVE CONTROLS (§3-1, CLAUDE.md §18 "負の対照に git checkout を使わない"):
 * the pre-REQ-0530 predicate is written out in place and asserted to disagree.
 * No git, no source swap.
 *
 * BOTH SIDES (§3-3): every "it is now included" case is paired with an
 * assertion that the exclusions REQ-0530 did NOT touch are still excluding.
 * Checking only that something stopped being dropped would go green even if
 * the filter had been emptied entirely.
 */
import { describe, it, expect } from 'vitest'
import {
  computeEntryWarnings,
  isBurninTarget,
  isError,
  isWarning,
  type EntryWarnings,
} from '../../src/renderer/lib/entry-warnings'
import type { SubtitleEntry } from '../../src/shared/types'

const DUR = 7

const cue = (id: string, startSec: number, endSec: number, extra: Partial<SubtitleEntry> = {}): SubtitleEntry =>
  ({ id, startSec, endSec, text: 'x', fontSizePx: 48, isDeleted: false, ...extra } as unknown as SubtitleEntry)

/** The GUI's set, exactly as `burnin-drawer.tsx` builds it. */
function guiBurnSet(entries: readonly SubtitleEntry[], durationSec: number): string[] {
  const map = new Map<string, EntryWarnings>()
  let prevEnd: number | null = null
  for (const e of entries) {
    if (e.isDeleted) continue
    map.set(e.id, computeEntryWarnings(e, prevEnd, durationSec, false))
    prevEnd = e.endSec
  }
  return entries.filter((e) => {
    const w = map.get(e.id)
    return w !== undefined && isBurninTarget(e, w)
  }).map((e) => e.id)
}

/**
 * The headless set. `generateAss` filters on `!isDeleted` and nothing else —
 * that single line IS the CLI's whole cue gate (`ass-generator.ts`), so it is
 * reproduced here rather than imported (importing the generator would drag in
 * font metrics and ffmpeg staging for a one-line predicate).
 */
const cliBurnSet = (entries: readonly SubtitleEntry[]): string[] =>
  entries.filter((e) => !e.isDeleted).map((e) => e.id)

/** The pre-REQ-0530 GUI predicate, verbatim. */
function preFixGuiBurnSet(entries: readonly SubtitleEntry[], durationSec: number): string[] {
  const map = new Map<string, EntryWarnings>()
  let prevEnd: number | null = null
  for (const e of entries) {
    if (e.isDeleted) continue
    map.set(e.id, computeEntryWarnings(e, prevEnd, durationSec, false))
    prevEnd = e.endSec
  }
  return entries.filter((e) => {
    const w = map.get(e.id)
    if (w === undefined) return false
    return !e.isDeleted && !w.emptyText && !w.timeInvalid && !w.overDuration && !w.invalidSize
  }).map((e) => e.id)
}

describe('REQ-0530 §2-2 — the GUI and the CLI burn the same cues', () => {
  it('a cue straddling the end of the video is in BOTH sets', () => {
    const entries = [cue('ok', 0, 3), cue('straddle', 5, 16)]
    expect(guiBurnSet(entries, DUR)).toEqual(['ok', 'straddle'])
    expect(guiBurnSet(entries, DUR)).toEqual(cliBurnSet(entries))
  })

  it('a cue starting after the end is also in both (libass simply never shows it)', () => {
    const entries = [cue('ok', 0, 3), cue('past', 20, 25)]
    expect(guiBurnSet(entries, DUR)).toEqual(cliBurnSet(entries))
  })

  it('NEGATIVE CONTROL — the pre-fix predicate dropped the straddling cue', () => {
    const entries = [cue('ok', 0, 3), cue('straddle', 5, 16)]
    const before = preFixGuiBurnSet(entries, DUR)
    expect(before, 'sanity: the old filter really did drop it').toEqual(['ok'])
    expect(
      before.length === cliBurnSet(entries).length,
      'the control must FAIL the parity property this REQ adds — if it passes, ' +
        'the control has stopped perturbing anything',
    ).toBe(false)
  })

  it('★ the two sets agree across a mixed project', () => {
    const entries = [
      cue('a', 0, 2),
      cue('straddle', 5, 16),
      cue('past', 30, 40),
      cue('b', 2, 4),
    ]
    expect(guiBurnSet(entries, DUR)).toEqual(cliBurnSet(entries))
  })
})

describe('REQ-0530 §3-3 — the exclusions that must SURVIVE', () => {
  /*
   * The half that a one-sided gate would miss. If `isBurninTarget` had been
   * gutted rather than narrowed, every assertion above would still pass.
   */
  it('deleted cues are still dropped by the GUI', () => {
    const entries = [cue('ok', 0, 3), cue('gone', 1, 2, { isDeleted: true })]
    expect(guiBurnSet(entries, DUR)).toEqual(['ok'])
  })

  it('empty-text cues are still dropped by the GUI', () => {
    const entries = [cue('ok', 0, 3), cue('blank', 1, 2, { text: '   ' })]
    expect(guiBurnSet(entries, DUR)).toEqual(['ok'])
  })

  it('timeInvalid (end ≤ start) is still dropped — genuinely unrenderable', () => {
    const entries = [cue('ok', 0, 3), cue('bad', 5, 5)]
    expect(guiBurnSet(entries, DUR)).toEqual(['ok'])
  })

  it('invalidSize (fontSizePx ≤ 0) is still dropped — genuinely unrenderable', () => {
    const entries = [cue('ok', 0, 3), cue('tiny', 1, 2, { fontSizePx: 0 })]
    expect(guiBurnSet(entries, DUR)).toEqual(['ok'])
  })

  it('★ exactly ONE condition was relaxed, not several', () => {
    // Enumerate the four survivors: each alone must still remove its cue.
    const survivors: Array<[string, SubtitleEntry]> = [
      ['isDeleted', cue('x', 1, 2, { isDeleted: true })],
      ['emptyText', cue('x', 1, 2, { text: '\\N  ' })],
      ['timeInvalid', cue('x', 4, 4)],
      ['invalidSize', cue('x', 1, 2, { fontSizePx: -1 })],
    ]
    for (const [name, e] of survivors) {
      expect(guiBurnSet([e], DUR), `${name} stopped excluding — too much was relaxed`).toEqual([])
    }
    // …and the one that was relaxed is now included.
    expect(guiBurnSet([cue('x', 5, 16)], DUR)).toEqual(['x'])
  })
})

describe('REQ-0530 §2-4 — overDuration is a warning, not an error', () => {
  const w = (over: boolean): EntryWarnings =>
    computeEntryWarnings(cue('c', 0, over ? 16 : 3), null, DUR, false)

  it('it no longer blocks the export button (errorCount gate)', () => {
    expect(isError(w(true)), 'an over-duration cue must not disable 動画出力').toBe(false)
  })

  it('but it is still reported, so the Issues tab and badge keep it', () => {
    expect(isWarning(w(true))).toBe(true)
  })

  it('★ BOTH SIDES — an in-range cue is neither', () => {
    expect(isError(w(false))).toBe(false)
    expect(isWarning(w(false))).toBe(false)
  })

  it('NEGATIVE CONTROL — the pre-fix classification called it an error', () => {
    const preFixIsError = (x: EntryWarnings) => x.timeInvalid || x.overDuration || x.invalidSize
    expect(preFixIsError(w(true)), 'sanity: it really was an error').toBe(true)
    expect(
      preFixIsError(w(true)) === isError(w(true)),
      'the control must differ from the new classification',
    ).toBe(false)
  })
})
