import { describe, it, expect } from 'vitest'
import {
  computeSeekTargetEdited,
  computeZoom,
  TIMELINE_ZOOM_STEP_PX,
} from '../../src/renderer/lib/timeline-nav'
import type { SubtitleEntry } from '../../src/shared/types'
import type { CutList } from '../../src/shared/cuts'

/**
 * REQ-0132 §1.3 — pure logic for the timeline arrow-key shortcuts.
 * Pins the "clamp at edges, never wrap" rule and the zoom clamp.
 */

function makeEntry(id: string, startSec: number, endSec: number, isDeleted = false): SubtitleEntry {
  return {
    id,
    startSec,
    endSec,
    text: '',
    fontSizePx: 40,
    textColorHex: '#FFFFFF',
    outlineColorHex: '#000000',
    outlineThicknessPx: 2,
    fadeDurationSec: 0,
    subtitleBackground: { enabled: false, colorHex: '#000000', opacity: 0 },
    isDeleted,
    isEdited: false,
    original: {
      startSec,
      endSec,
      text: '',
      fontSizePx: 40,
      textColorHex: '#FFFFFF',
      outlineColorHex: '#000000',
      outlineThicknessPx: 2,
      fadeDurationSec: 0,
      subtitleBackground: { enabled: false, colorHex: '#000000', opacity: 0 },
    },
  } as SubtitleEntry
}

const NO_CUTS: CutList = []
const TOTAL = 60

describe('REQ-0132 — computeSeekTargetEdited', () => {
  const entries = [
    makeEntry('a', 5, 10),
    makeEntry('b', 20, 25),
    makeEntry('c', 40, 45),
  ]
  // Boundary set = [5, 10, 20, 25, 40, 45]

  it('start jumps to 0 regardless of current playhead', () => {
    expect(computeSeekTargetEdited('start', 33, entries, NO_CUTS, TOTAL)).toBe(0)
    expect(computeSeekTargetEdited('start', 0,  entries, NO_CUTS, TOTAL)).toBe(0)
  })

  it('end jumps to editedTotalSec regardless of current playhead', () => {
    expect(computeSeekTargetEdited('end', 12, entries, NO_CUTS, TOTAL)).toBe(TOTAL)
    expect(computeSeekTargetEdited('end', TOTAL, entries, NO_CUTS, TOTAL)).toBe(TOTAL)
  })

  it('next from mid-block finds the next boundary', () => {
    // At t=7 (inside a's span), next boundary is a.endSec = 10.
    expect(computeSeekTargetEdited('next', 7, entries, NO_CUTS, TOTAL)).toBe(10)
  })

  it('next from between blocks finds the next block start', () => {
    // At t=15, next boundary is b.startSec = 20.
    expect(computeSeekTargetEdited('next', 15, entries, NO_CUTS, TOTAL)).toBe(20)
  })

  it('next clamps to editedTotalSec when past every boundary', () => {
    // At t=50, no boundary is greater → return TOTAL (clamp, no wrap).
    expect(computeSeekTargetEdited('next', 50, entries, NO_CUTS, TOTAL)).toBe(TOTAL)
  })

  it('prev from mid-block finds the previous boundary', () => {
    // At t=22, prev is b.startSec = 20.
    expect(computeSeekTargetEdited('prev', 22, entries, NO_CUTS, TOTAL)).toBe(20)
  })

  it('prev clamps to 0 when before every boundary', () => {
    // At t=1, no boundary is smaller → return 0 (clamp, no wrap).
    expect(computeSeekTargetEdited('prev', 1, entries, NO_CUTS, TOTAL)).toBe(0)
  })

  it('deleted entries do not contribute boundaries', () => {
    const withDeleted = [
      makeEntry('a', 5, 10),
      makeEntry('b', 20, 25, true),
      makeEntry('c', 40, 45),
    ]
    // b is deleted → next from t=12 skips 20/25 and lands on 40.
    expect(computeSeekTargetEdited('next', 12, withDeleted, NO_CUTS, TOTAL)).toBe(40)
  })

  it('empty entries → next clamps to end, prev clamps to 0', () => {
    expect(computeSeekTargetEdited('next', 10, [], NO_CUTS, TOTAL)).toBe(TOTAL)
    expect(computeSeekTargetEdited('prev', 10, [], NO_CUTS, TOTAL)).toBe(0)
  })
})

describe('REQ-0132 — computeZoom', () => {
  it('positive delta zooms in', () => {
    expect(computeZoom(50, TIMELINE_ZOOM_STEP_PX)).toBe(60)
  })

  it('negative delta zooms out', () => {
    expect(computeZoom(50, -TIMELINE_ZOOM_STEP_PX)).toBe(40)
  })

  it('clamps at TIMELINE_PPS_MIN', () => {
    // Repeated zoom-out lands on 10 (min) and stays there.
    expect(computeZoom(15, -10)).toBe(10)
    expect(computeZoom(10, -10)).toBe(10)
    expect(computeZoom(10, -100)).toBe(10)
  })

  it('clamps at TIMELINE_PPS_MAX', () => {
    expect(computeZoom(395, 10)).toBe(400)
    expect(computeZoom(400, 10)).toBe(400)
    expect(computeZoom(400, 100)).toBe(400)
  })

  it('preserves the input when delta is 0', () => {
    expect(computeZoom(75, 0)).toBe(75)
  })
})
