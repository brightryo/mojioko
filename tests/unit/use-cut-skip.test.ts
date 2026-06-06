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
})
