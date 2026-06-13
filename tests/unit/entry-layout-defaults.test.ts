import { describe, expect, it } from 'vitest'
import {
  BURNIN_DEFAULTS,
  makeEntryLayoutDefaults
} from '../../src/shared/burnin-defaults'

/**
 * REQ-20260613-016 / v1.2.2 機能A — `makeEntryLayoutDefaults` is the single
 * source of truth for the per-row layout / background values seeded onto
 * every new SubtitleEntry.  These tests pin two invariants the rest of the
 * codebase relies on:
 *
 *   1. The values match `BURNIN_DEFAULTS` (= the v1.0/v1.1 global defaults
 *      that were on display in the soon-to-be-retired Step 2 panel).  If
 *      Phase 4 retires the panel and the constant moves, this test will
 *      fail-loud if any drift sneaks in.
 *   2. Every call returns a FRESH `subtitleBackground` object.  Sharing
 *      identity across entries would let a per-row UI edit leak across
 *      every entry that was seeded from the same call, which is exactly
 *      the bug the v1.2.2 data model is designed to avoid.
 */

describe('makeEntryLayoutDefaults — values match BURNIN_DEFAULTS', () => {
  it('layout fields are byte-equal to BURNIN_DEFAULTS', () => {
    const d = makeEntryLayoutDefaults()
    expect(d.horizontalPosition).toBe(BURNIN_DEFAULTS.horizontalPosition)
    expect(d.verticalPosition).toBe(BURNIN_DEFAULTS.verticalPosition)
    expect(d.verticalMarginPx).toBe(BURNIN_DEFAULTS.verticalMarginPx)
  })

  it('subtitleBackground content matches BURNIN_DEFAULTS.subtitleBackground', () => {
    const d = makeEntryLayoutDefaults()
    expect(d.subtitleBackground.enabled).toBe(BURNIN_DEFAULTS.subtitleBackground.enabled)
    expect(d.subtitleBackground.color).toBe(BURNIN_DEFAULTS.subtitleBackground.color)
    expect(d.subtitleBackground.opacityPercent).toBe(
      BURNIN_DEFAULTS.subtitleBackground.opacityPercent
    )
  })
})

describe('makeEntryLayoutDefaults — fresh object per call', () => {
  it('two consecutive calls produce distinct subtitleBackground references', () => {
    const a = makeEntryLayoutDefaults()
    const b = makeEntryLayoutDefaults()
    expect(a.subtitleBackground).not.toBe(b.subtitleBackground)
  })

  it('mutating one returned subtitleBackground does NOT leak to the BURNIN_DEFAULTS source', () => {
    const a = makeEntryLayoutDefaults()
    a.subtitleBackground.opacityPercent = 99
    // The frozen BURNIN_DEFAULTS still reads its original value.
    expect(BURNIN_DEFAULTS.subtitleBackground.opacityPercent).toBe(50)
    // And a fresh call returns the original default again — proving the
    // mutation above lived only on `a`.
    const c = makeEntryLayoutDefaults()
    expect(c.subtitleBackground.opacityPercent).toBe(50)
  })
})
