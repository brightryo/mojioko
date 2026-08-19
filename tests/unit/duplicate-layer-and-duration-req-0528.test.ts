/**
 * REQ-0528 — two owner-reported bugs, pinned as pure-function contracts.
 *
 *   §1 duplicating a cue stacked the copy onto an occupied layer
 *   §2 the 「時間を調整」 dialog could push a cue past the end of the video,
 *      and the timeline ruler followed it out there
 *
 * NEGATIVE CONTROLS (REQ-0528 §3-2, CLAUDE.md §18 "負の対照に git checkout を
 * 使わない"): each fix ships next to the PRE-FIX expression, written out here
 * as a one-line function, and the test asserts the old form fails the same
 * check the new one passes.  Nothing is checked out, no source is swapped, and
 * the controls perturb exactly the one decision under test.
 *
 * BOTH SIDES (§3-3): every clamp/search case is paired with an in-range case
 * asserting the fix did NOT take away ordinary freedom — a cue inside the
 * video is left byte-identical, and a free layer is used rather than skipped.
 */
import { describe, it, expect } from 'vitest'
import {
  findFreeLayerAbove,
  cueTimesOverlap,
  resolveLayer,
  MAX_LAYER,
  type LayerOccupant,
} from '../../src/shared/cue-placement'
import { clampCueTimesToDuration, cueCeilingSec } from '../../src/renderer/lib/entry-edits'
import { layoutEntries } from '../../src/renderer/lib/timeline-layout'
import type { SubtitleEntry } from '../../src/shared/types'

const cue = (id: string, startSec: number, endSec: number, layer?: number, isDeleted = false): LayerOccupant =>
  ({ id, startSec, endSec, layer, isDeleted })

/** The pre-REQ-0528 layer decision, verbatim from `duplicate-entry.ts`. */
const preFixLayer = (source: { layer?: number }) => Math.max(0, resolveLayer(source) + 1)

describe('REQ-0528 §1 — the duplicate lands on a FREE layer', () => {
  it('stacks 1 → 2 → 3 when the same cue is duplicated three times', () => {
    const source = cue('src', 0, 5, 0)
    const world: LayerOccupant[] = [source]
    const got: number[] = []

    for (let i = 0; i < 3; i++) {
      const layer = findFreeLayerAbove(cue('new', 0, 5), resolveLayer(source) + 1, world)
      expect(layer, 'a free layer should exist this early').not.toBeNull()
      got.push(layer as number)
      // The copy now occupies that layer, exactly as `addEntry` would leave it.
      world.push(cue(`copy-${i}`, 0, 5, layer as number))
    }

    expect(got, 'three duplicates of one cue must climb, not pile up').toEqual([1, 2, 3])
  })

  it('NEGATIVE CONTROL — the pre-fix "source + 1" puts every copy on layer 1', () => {
    const source = cue('src', 0, 5, 0)
    const got = [0, 1, 2].map(() => preFixLayer(source))
    expect(got, 'sanity: the old expression really did ignore what was there').toEqual([1, 1, 1])
    expect(
      new Set(got).size,
      'the old form must FAIL the "climb" property this REQ adds — if this ever ' +
        'passes, the control has stopped perturbing anything',
    ).not.toBe(3)
  })

  it('★ BOTH SIDES — a cue that does not overlap reuses the low layer instead of climbing', () => {
    // Layer 1 is occupied, but at a completely different time.
    const world = [cue('src', 0, 5, 0), cue('elsewhere', 100, 105, 1)]
    expect(
      findFreeLayerAbove(cue('new', 0, 5), 1, world),
      'a busy-but-not-overlapping layer must still be usable — the fix must not ' +
        'turn into "always take the topmost free layer"',
    ).toBe(1)
  })

  it('★ touching endpoints do NOT count as overlap (end-exclusive convention)', () => {
    expect(cueTimesOverlap({ startSec: 0, endSec: 3 }, { startSec: 3, endSec: 6 })).toBe(false)
    expect(cueTimesOverlap({ startSec: 0, endSec: 3 }, { startSec: 2.99, endSec: 6 })).toBe(true)

    // …and the layer search inherits it: a cue butting up against the occupant
    // shares its layer.
    const world = [cue('src', 3, 6, 0), cue('before', 0, 3, 1)]
    expect(findFreeLayerAbove(cue('new', 3, 6), 1, world), 'abutting cues may share a layer').toBe(1)
  })

  it('deleted cues do not occupy a layer', () => {
    const world = [cue('src', 0, 5, 0), cue('ghost', 0, 5, 1, true)]
    expect(findFreeLayerAbove(cue('new', 0, 5), 1, world)).toBe(1)
  })

  it('a cue never collides with itself', () => {
    const self = cue('self', 0, 5, 3)
    expect(findFreeLayerAbove(self, 3, [self])).toBe(3)
  })

  it('returns null — not a clamp — when every layer up to MAX_LAYER is taken', () => {
    const world: LayerOccupant[] = []
    for (let l = 0; l <= MAX_LAYER; l++) world.push(cue(`occ-${l}`, 0, 5, l))

    expect(
      findFreeLayerAbove(cue('new', 0, 5), 1, world),
      'exhaustion must be reported, not clamped onto MAX_LAYER — clamping is ' +
        'what would silently recreate the stacking bug at the top of the range',
    ).toBeNull()
  })

  it('a source already at MAX_LAYER has nowhere to go', () => {
    const source = cue('src', 0, 5, MAX_LAYER)
    expect(findFreeLayerAbove(cue('new', 0, 5), MAX_LAYER + 1, [source])).toBeNull()
  })
})

describe('REQ-0528 §2 — cue times cannot leave the video', () => {
  const DUR = 7

  it('clamps the owner-reported case: 16 s on a 7 s video', () => {
    const r = clampCueTimesToDuration(2, 16, DUR)
    expect(r.endSec).toBe(7)
    expect(r.clamped).toBe(true)
  })

  it('NEGATIVE CONTROL — the pre-fix path (no clamp at all) keeps the 16 s', () => {
    const preFix = (_s: number, e: number) => e
    expect(preFix(2, 16), 'sanity: unclamped really did pass 16 straight through').toBe(16)
    expect(
      preFix(2, 16) <= DUR,
      'the unclamped form must FAIL the ceiling this REQ adds',
    ).toBe(false)
  })

  it('★ BOTH SIDES — a cue inside the video is returned untouched', () => {
    const r = clampCueTimesToDuration(1.25, 6.5, DUR)
    expect({ startSec: r.startSec, endSec: r.endSec }).toEqual({ startSec: 1.25, endSec: 6.5 })
    expect(r.clamped, 'no toast should fire for an ordinary in-range edit').toBe(false)
  })

  it('★ BOTH SIDES — the exact end of the video is allowed', () => {
    const r = clampCueTimesToDuration(0, 7, DUR)
    expect(r.endSec).toBe(7)
    expect(r.clamped).toBe(false)
  })

  it('the ceiling floors to a centisecond so HALF-UP rounding cannot exceed it', () => {
    // 7.235 → 7.23, not 7.24: rounding the clamped value must stay ≤ duration.
    expect(cueCeilingSec(7.235)).toBe(7.23)
    expect(Math.round(cueCeilingSec(7.235) * 100) / 100).toBeLessThanOrEqual(7.235)
  })

  it('no video / audio-only (Infinity) imposes no ceiling', () => {
    const r = clampCueTimesToDuration(0, 999, Infinity)
    expect({ ...r }).toEqual({ startSec: 0, endSec: 999, clamped: false })
  })
})

describe('REQ-0528 §2-3 — the timeline stops at the end of the video', () => {
  const entry = (id: string, startSec: number, endSec: number): SubtitleEntry =>
    ({ id, startSec, endSec, text: 't', layer: 0 } as unknown as SubtitleEntry)

  it('an over-long legacy cue no longer stretches the ruler', () => {
    const layout = layoutEntries([entry('a', 0, 16)], 7, 0, 7)
    expect(layout.totalSec, 'the ruler must end where the footage does').toBe(7)
  })

  it('NEGATIVE CONTROL — the pre-fix max() followed the cue out to 16 s', () => {
    const preFixTotal = Math.max(7, 16)
    expect(preFixTotal, 'sanity: the old expression really did extend the ruler').toBe(16)
    expect(preFixTotal === 7, 'the old form must FAIL the fixed-length property').toBe(false)
  })

  it('★ BOTH SIDES — with no hard duration the ruler still spans the entries', () => {
    const layout = layoutEntries([entry('a', 0, 16)], 10, 0, undefined)
    expect(
      layout.totalSec,
      'audio-only / no-video must keep the entry-spanning behaviour, or those ' +
        'modes lose access to their own cues',
    ).toBe(16)
  })

  it('★ BOTH SIDES — an ordinary in-range project is unaffected', () => {
    const layout = layoutEntries([entry('a', 0, 5)], 7, 0, 7)
    expect(layout.totalSec).toBe(7)
  })

  it('Infinity (audio-only) is treated as "no hard duration"', () => {
    const layout = layoutEntries([entry('a', 0, 16)], 10, 0, Infinity)
    expect(layout.totalSec).toBe(16)
  })
})
