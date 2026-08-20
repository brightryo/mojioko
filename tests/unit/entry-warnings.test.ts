import { describe, it, expect } from 'vitest'
import {
  isError,
  isWarning,
  hasAnyError,
  hasAnyWarning,
  type EntryWarnings,
} from '../../src/renderer/lib/entry-warnings'

const NONE: EntryWarnings = {
  timeInvalid: false,
  overDuration: false,
  overlap: false,
  emptyText: false,
  invalidSize: false,
  overflow: false,
  verticalOverflow: false,
}

// ---------------------------------------------------------------------------
// REQ-121 — pure-function classification of the six EntryWarnings flags
// into errors (export-blocking) vs warnings (does not block export).
// ---------------------------------------------------------------------------

describe('REQ-121: isError', () => {
  it('all-clear flags → not an error', () => {
    expect(isError(NONE)).toBe(false)
  })

  it('timeInvalid (start ≥ end) → error', () => {
    expect(isError({ ...NONE, timeInvalid: true })).toBe(true)
  })

  /*
   * REQ-0530 — overDuration moved error → warning.  The REQ-121 classification
   * grouped it with timeInvalid / invalidSize as "physically un-renderable"
   * (RES-20260601-120 §3.1); REQ-0529 measured that claim and refuted it — the
   * in-video portion of such a cue really is drawn.  Being an error also meant
   * `errorCount` disabled the 動画出力 button, so the project could not be
   * burned at all.  The assertion is INVERTED rather than deleted, so the
   * change is visible in the diff of the file that pinned the old rule.
   */
  it('overDuration is NOT an error — REQ-0530 (was, until it was measured)', () => {
    expect(isError({ ...NONE, overDuration: true })).toBe(false)
  })

  it('invalidSize (fontSizePx ≤ 0) → error', () => {
    expect(isError({ ...NONE, invalidSize: true })).toBe(true)
  })

  it('emptyText is NOT an error (warning by REQ-121)', () => {
    expect(isError({ ...NONE, emptyText: true })).toBe(false)
  })

  it('overlap is NOT an error', () => {
    expect(isError({ ...NONE, overlap: true })).toBe(false)
  })

  it('overflow is NOT an error', () => {
    expect(isError({ ...NONE, overflow: true })).toBe(false)
  })

  it('multiple flags including at least one error → error', () => {
    expect(isError({ ...NONE, timeInvalid: true, overlap: true })).toBe(true)
  })
})

describe('REQ-121: isWarning', () => {
  it('all-clear flags → not a warning', () => {
    expect(isWarning(NONE)).toBe(false)
  })

  it('emptyText → warning (REQ-121 promotion)', () => {
    expect(isWarning({ ...NONE, emptyText: true })).toBe(true)
  })

  it('overlap → warning', () => {
    expect(isWarning({ ...NONE, overlap: true })).toBe(true)
  })

  it('overflow → warning', () => {
    expect(isWarning({ ...NONE, overflow: true })).toBe(true)
  })

  it('timeInvalid is NOT a warning (error)', () => {
    expect(isWarning({ ...NONE, timeInvalid: true })).toBe(false)
  })

  it('overDuration IS a warning — REQ-0530 (the row ships, truncated)', () => {
    expect(isWarning({ ...NONE, overDuration: true })).toBe(true)
  })

  it('invalidSize is NOT a warning (error)', () => {
    expect(isWarning({ ...NONE, invalidSize: true })).toBe(false)
  })
})

describe('REQ-121: error / warning partition over every flag', () => {
  it('every flag falls in exactly one of {error, warning}', () => {
    // Concrete enumeration: set each flag in isolation and confirm
    // the partition.
    //
    // REQ-0530 — `verticalOverflow` added to the list.  It has been a warning
    // since REQ-0456 but was never enumerated here, so the "partition covers
    // everything" claim had a hole; a flag classified in neither predicate
    // would have gone unnoticed.  Counts move 3/3 → 2/5 with overDuration's
    // reclassification plus this addition.
    type Field = keyof EntryWarnings
    const fields: Field[] = [
      'timeInvalid',
      'overDuration',
      'invalidSize',
      'emptyText',
      'overlap',
      'overflow',
      'verticalOverflow',
    ]
    let errors = 0
    let warnings = 0
    for (const f of fields) {
      const w: EntryWarnings = { ...NONE, [f]: true }
      const inError = isError(w)
      const inWarning = isWarning(w)
      // XOR: exactly one of the predicates is true for a single-flag input.
      expect(inError !== inWarning).toBe(true)
      if (inError) errors++
      if (inWarning) warnings++
    }
    // REQ-0530: errors = timeInvalid, invalidSize.
    expect(errors).toBe(2)
    // emptyText, overlap, overflow, verticalOverflow, overDuration.
    expect(warnings).toBe(5)
    // …and together they still account for every field enumerated.
    expect(errors + warnings).toBe(fields.length)
  })

  it('a row with BOTH an error and a warning falls in both predicates', () => {
    const w: EntryWarnings = { ...NONE, timeInvalid: true, overlap: true }
    expect(isError(w)).toBe(true)
    expect(isWarning(w)).toBe(true)
  })
})

describe('REQ-121: hasAnyError / hasAnyWarning aliases', () => {
  it('hasAnyError === isError (per-row alias)', () => {
    expect(hasAnyError({ ...NONE, timeInvalid: true })).toBe(true)
    expect(hasAnyError({ ...NONE, overlap: true })).toBe(false)
  })

  it('hasAnyWarning === isWarning after REQ-121 (no longer mixed)', () => {
    // The pre-REQ-121 implementation of hasAnyWarning included errors;
    // REQ-121 narrows it to warnings only.  Lock the new contract.
    expect(hasAnyWarning({ ...NONE, emptyText: true })).toBe(true)
    expect(hasAnyWarning({ ...NONE, overlap: true })).toBe(true)
    expect(hasAnyWarning({ ...NONE, overflow: true })).toBe(true)
    // REQ-0456 — vertical overflow is a warning (row still ships).
    expect(hasAnyWarning({ ...NONE, verticalOverflow: true })).toBe(true)
    expect(hasAnyWarning({ ...NONE, timeInvalid: true })).toBe(false)
    // REQ-0530 — now a warning (see the isError/isWarning blocks above).
    expect(hasAnyWarning({ ...NONE, overDuration: true })).toBe(true)
    expect(hasAnyWarning({ ...NONE, invalidSize: true })).toBe(false)
  })
})
