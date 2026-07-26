import { describe, it, expect } from 'vitest'
import type { SubtitleEntry, TranscriptionDefaults } from '../../src/shared/types'
import { getAnchorAssPosition } from '../../src/renderer/lib/preview-coords'
import { makeEntryLayoutDefaults } from '../../src/shared/burnin-defaults'

/**
 * REQ-0295 — pure-logic pin for the entry-seeding rules the transcribed
 * cue-builder in `step1.tsx` applies.  The builder is inline in the
 * route (`segments.map`) and drags in enough IPC / store plumbing to
 * be awkward to spin up in vitest, so this test replicates the
 * seeding rules in a local pure helper and pins:
 *
 *   1. Each REQ-0295 TranscriptionDefaults field lands on the seeded
 *      entry (or stays undefined when the default was undefined).
 *   2. Non-zero `posOffsetX/Y` produce absolute `posX/posY` computed
 *      from the layout anchor (matching the `getAnchorAssPosition`
 *      formula the route uses).
 *   3. Zero-offset defaults leave `posX/posY` undefined so the row
 *      uses alignment-based positioning (no `\pos` tag).
 *
 * If `step1.tsx`'s inline builder ever drifts from these rules, this
 * test won't catch it directly, but the shape of the pure helper
 * matches the source exactly so it's easy to keep in sync.
 */

interface SeededEntry {
  fontSizePx: number
  textColorHex: string
  outlineColorHex: string
  outlineThicknessPx: number
  shadowDepth?: number
  shadowColor?: string
  shadowAlpha?: number
  karaokeEnabled?: boolean
  karaokeHighlightColor?: string
  casing?: 'none' | 'uppercase'
  rotation?: number
  horizontalPosition: 'left' | 'center' | 'right'
  verticalPosition: 'top' | 'center' | 'bottom'
  verticalMarginPx: number
  posX?: number
  posY?: number
}

/** Replicates step1.tsx's REQ-0295 seeding rules for a single cue. */
function seedEntryFromDefaults(
  runDefaults: TranscriptionDefaults,
  video: { widthPx: number; heightPx: number },
): SeededEntry {
  const layoutH = runDefaults.horizontalPosition ?? makeEntryLayoutDefaults().horizontalPosition
  const layoutV = runDefaults.verticalPosition ?? makeEntryLayoutDefaults().verticalPosition
  const layoutMV = runDefaults.verticalMarginPx ?? makeEntryLayoutDefaults().verticalMarginPx
  const offX = runDefaults.posOffsetX ?? 0
  const offY = runDefaults.posOffsetY ?? 0
  let posX: number | undefined
  let posY: number | undefined
  if (offX !== 0 || offY !== 0) {
    const anchor = getAnchorAssPosition(layoutH, layoutV, layoutMV, video.widthPx, video.heightPx)
    posX = anchor.x + offX
    posY = anchor.y + offY
  }
  return {
    fontSizePx: runDefaults.fontSizePx,
    textColorHex: runDefaults.textColorHex,
    outlineColorHex: runDefaults.outlineColorHex,
    outlineThicknessPx: runDefaults.outlineThicknessPx,
    shadowDepth: runDefaults.shadowDepth,
    shadowColor: runDefaults.shadowColor,
    shadowAlpha: runDefaults.shadowAlpha,
    karaokeEnabled: runDefaults.karaokeEnabled,
    karaokeHighlightColor: runDefaults.karaokeHighlightColor,
    casing: runDefaults.casing,
    rotation: runDefaults.rotation,
    horizontalPosition: layoutH,
    verticalPosition: layoutV,
    verticalMarginPx: layoutMV,
    posX,
    posY,
  }
}

const VIDEO = { widthPx: 1920, heightPx: 1080 }

function baseDefaults(overrides: Partial<TranscriptionDefaults> = {}): TranscriptionDefaults {
  return {
    fontSizePx: 100,
    textColorHex: '#FFFFFF',
    outlineColorHex: '#000000',
    outlineThicknessPx: 3,
    whisperModel: 'large-v3',
    ...overrides,
  }
}

describe('REQ-0295 — new TranscriptionDefaults fields flow to seeded entry', () => {
  it('no new-field defaults set → new-field entry props stay undefined (backward compat)', () => {
    const seeded = seedEntryFromDefaults(baseDefaults(), VIDEO)
    expect(seeded.shadowDepth).toBeUndefined()
    expect(seeded.karaokeEnabled).toBeUndefined()
    expect(seeded.casing).toBeUndefined()
    expect(seeded.rotation).toBeUndefined()
    expect(seeded.posX).toBeUndefined()
    expect(seeded.posY).toBeUndefined()
    // Layout falls back to `makeEntryLayoutDefaults` (=BURNIN_DEFAULTS).
    expect(seeded.horizontalPosition).toBe('center')
    expect(seeded.verticalPosition).toBe('bottom')
    expect(seeded.verticalMarginPx).toBe(40)
  })

  it('shadow / karaoke / casing / rotation defaults copy verbatim to the entry', () => {
    const seeded = seedEntryFromDefaults(baseDefaults({
      shadowDepth: 25,
      shadowColor: '#FF00FF',
      shadowAlpha: 80,
      karaokeEnabled: true,
      karaokeHighlightColor: '#00FF00',
      casing: 'uppercase',
      rotation: 45,
    }), VIDEO)
    expect(seeded.shadowDepth).toBe(25)
    expect(seeded.shadowColor).toBe('#FF00FF')
    expect(seeded.shadowAlpha).toBe(80)
    expect(seeded.karaokeEnabled).toBe(true)
    expect(seeded.karaokeHighlightColor).toBe('#00FF00')
    expect(seeded.casing).toBe('uppercase')
    expect(seeded.rotation).toBe(45)
  })

  it('layout H/V/margin defaults override the BURNIN_DEFAULTS baseline', () => {
    const seeded = seedEntryFromDefaults(baseDefaults({
      horizontalPosition: 'left',
      verticalPosition: 'top',
      verticalMarginPx: 60,
    }), VIDEO)
    expect(seeded.horizontalPosition).toBe('left')
    expect(seeded.verticalPosition).toBe('top')
    expect(seeded.verticalMarginPx).toBe(60)
  })

  it('non-zero posOffsetX/Y → posX/Y = anchor + offset (pinned via \\pos)', () => {
    // Default anchor for bottom-center on 1920×1080 with 40 marginV
    // = { x: 960, y: 1040 }.  Offset (+25, -10) → posX=985, posY=1030.
    const seeded = seedEntryFromDefaults(baseDefaults({
      posOffsetX: 25,
      posOffsetY: -10,
    }), VIDEO)
    expect(seeded.posX).toBe(985)
    expect(seeded.posY).toBe(1030)
  })

  it('anchor computation uses the effective layout H/V/margin from defaults', () => {
    // Anchor for top-left on 1920×1080 with 60 marginV → x=ASS_MARGIN_LR_PX
    // (=10), y=60.  Offset (+50, +100) → posX=60, posY=160.
    const seeded = seedEntryFromDefaults(baseDefaults({
      horizontalPosition: 'left',
      verticalPosition: 'top',
      verticalMarginPx: 60,
      posOffsetX: 50,
      posOffsetY: 100,
    }), VIDEO)
    expect(seeded.posX).toBe(10 + 50)
    expect(seeded.posY).toBe(60 + 100)
  })

  it('zero-only offset defaults → NO posX/posY seeded (alignment-based fallback)', () => {
    const seeded = seedEntryFromDefaults(baseDefaults({
      posOffsetX: 0,
      posOffsetY: 0,
    }), VIDEO)
    expect(seeded.posX).toBeUndefined()
    expect(seeded.posY).toBeUndefined()
  })

  it('SubtitleEntry shape sanity — seeded row assigns into a SubtitleEntry without type errors', () => {
    // Compile-time pin: the seeded row's shape must satisfy the
    // `SubtitleEntry` field types (via a narrowing assignment).
    // Failing this would surface as a typecheck error at CI time.
    const seeded = seedEntryFromDefaults(baseDefaults({
      shadowDepth: 10, karaokeEnabled: true, karaokeHighlightColor: '#FFFF00',
      casing: 'uppercase', rotation: 15,
    }), VIDEO)
    const entry: Partial<SubtitleEntry> = { ...seeded }
    expect(entry.shadowDepth).toBe(10)
    expect(entry.karaokeEnabled).toBe(true)
    expect(entry.casing).toBe('uppercase')
    expect(entry.rotation).toBe(15)
  })
})
