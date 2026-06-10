import { describe, it, expect } from 'vitest'
import { findCutSkipTarget } from '../../src/renderer/hooks/use-cut-skip'
import type { Cut } from '../../src/shared/cuts'

function cut(startSec: number, endSec: number, id?: string): Cut {
  return { startSec, endSec, id: id ?? `c-${startSec}-${endSec}` }
}

describe('findCutSkipTarget', () => {
  const cuts: Cut[] = [cut(10, 15), cut(20, 22)]

  it('returns null when t is before all cuts', () => {
    expect(findCutSkipTarget(5, cuts)).toBeNull()
  })

  it('returns null when t equals cut.startSec (do not skip at the entry edge)', () => {
    expect(findCutSkipTarget(10, cuts)).toBeNull()
  })

  it('returns cut.endSec when t falls strictly inside a cut', () => {
    expect(findCutSkipTarget(12, cuts)).toBe(15)
  })

  it('returns null when t equals cut.endSec (already past)', () => {
    expect(findCutSkipTarget(15, cuts)).toBeNull()
  })

  it('returns null when t is between cuts', () => {
    expect(findCutSkipTarget(18, cuts)).toBeNull()
  })

  it('returns the SECOND cut.endSec when t falls inside the second cut', () => {
    expect(findCutSkipTarget(21, cuts)).toBe(22)
  })

  it('returns null when t is past every cut', () => {
    expect(findCutSkipTarget(100, cuts)).toBeNull()
  })

  it('returns null when cuts is empty', () => {
    expect(findCutSkipTarget(50, [])).toBeNull()
  })

  // ---------------------------------------------------------------------------
  // REQ-105 Phase 3 — overlapping cuts in storage (Phase 2 shape).  The early-
  // return on the first cut whose interval contains `t` makes findCutSkipTarget
  // overlap-tolerant without any code change; these tests lock the contract.
  // ---------------------------------------------------------------------------

  it('nested cuts: t inside the OUTER returns outer.endSec (outer fires first)', () => {
    // sanitize puts the wider one first when starts coincide; for
    // strictly-nested distinct starts it puts the outer first by
    // startSec ASC.  Either way the outer's endSec is what the user
    // perceives as "the far side of the cut".
    const cuts: Cut[] = [cut(10, 30, 'outer'), cut(15, 20, 'inner')]
    expect(findCutSkipTarget(18, cuts)).toBe(30)
    expect(findCutSkipTarget(12, cuts)).toBe(30)
  })

  it('nested cuts: removing the outer leaves the inner functional', () => {
    // Staged-unbind preview: after the outer is removed (Phase 4 UI),
    // the inner cut still skips its own interval.
    const cutsAfter: Cut[] = [cut(15, 20, 'inner')]
    expect(findCutSkipTarget(18, cutsAfter)).toBe(20)
    expect(findCutSkipTarget(12, cutsAfter)).toBeNull()  // outside inner
  })

  it('touching cuts (endSec === next startSec): t at the boundary lands on the second cut.endSec via re-entry', () => {
    // Cuts [10,15] and [15,20].  t=12 is inside the first → returns 15.
    // The hosting media element will then re-fire timeupdate at 15,
    // which equals the second cut's startSec — edge semantics returns
    // null (we are AT the boundary, not strictly inside) — so the next
    // tick at 15.001 inside the second cut returns 20.
    const cuts: Cut[] = [cut(10, 15), cut(15, 20)]
    expect(findCutSkipTarget(12, cuts)).toBe(15)
    expect(findCutSkipTarget(15, cuts)).toBeNull()    // at edge → no skip
    expect(findCutSkipTarget(17, cuts)).toBe(20)
  })

  it('3-way overlap chain: t in the union span returns the FIRST cut.endSec the scan hits', () => {
    // The hop-by-hop convention — each timeupdate tick may need multiple
    // jumps to clear a chain of overlapping cuts.  This matches how the
    // production hook works (one jump per timeupdate event).
    const cuts: Cut[] = [cut(10, 18, 'a'), cut(15, 22, 'b'), cut(20, 30, 'c')]
    // t=12 is inside [10,18] only → 18.
    expect(findCutSkipTarget(12, cuts)).toBe(18)
    // t=19 is inside [15,22] (past 'a'.endSec=18 already) → 22.
    expect(findCutSkipTarget(19, cuts)).toBe(22)
    // t=25 is inside [20,30] → 30.
    expect(findCutSkipTarget(25, cuts)).toBe(30)
  })
})
