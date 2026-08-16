import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import React from 'react'
import { SubtitleOverlay } from '../../src/renderer/components/subtitle-overlay/subtitle-overlay'
import type { SubtitleEntry } from '../../src/shared/types'

/**
 * REQ-0514 — the scale animation's origin does not move when a cue is dragged.
 *
 * ## The defect
 *
 * The overlay composed its transform as `var(--cue-anim-transform) <layout>`.
 * A CSS transform list applies right-to-left about ONE origin, so the layout
 * transform sat *inside* the animation's `scale()` and was multiplied by it.
 * A cue pinned by a drag carries `translate(-50%, -50%)` as that layout
 * transform, so at S = 0.7 the cue's own centre landed 0.15 · width to the
 * right of the pinned point and slid back as it grew.  That is the owner's
 * report: a cue dragged to 463/263 shrinks *rightward*, toward where it used
 * to be.
 *
 * The fix is ordering plus a single unconditional origin:
 *
 *     transform:        <layout> <rotation> var(--cue-anim-transform)
 *     transform-origin: the cue's own `\an` anchor
 *
 * ## Why the origin is the `\an` anchor and not `50% 50%`
 *
 * Measured in real burned pixels (`scripts/verify-scale-origin`): libass
 * anchors the SCALED text box by the cue's `\an`, and `\frz` rotates about that
 * same point — no `\org` is ever emitted.  So one origin serves both, and it is
 * the one that makes the preview reproduce the burn.  For a CENTRE/CENTRE cue —
 * the owner's configuration, and what the drag path produces — that anchor IS
 * the cue's own centre, which is the behaviour REQ-0514 §2-1 asks for.
 *
 * ## What this test is for, given the pixel gate exists
 *
 * `npm run verify:scale-origin` is the authority: it measures the fixed point
 * of the scaling in real pixels from BOTH engines, and it is the only thing
 * that can prove parity.  It also takes minutes and needs ffmpeg + chromium.
 * This file pins the two structural properties that gate depends on — the
 * animation layer is LAST, and the origin is unconditional — so the ordinary
 * `npm run test` run catches a regression in seconds.  Neither replaces the
 * other: this cannot see pixels, and the gate cannot run on every save.
 */

function makeEntry(patch: Partial<SubtitleEntry> = {}): SubtitleEntry {
  const base = {
    startSec: 0, endSec: 2, text: 'HEIT',
    fontSizePx: 100, textColorHex: '#FFFFFF', outlineColorHex: '#000000',
    outlineThicknessPx: 3, fadeDurationSec: 0,
    horizontalPosition: 'center' as const, verticalPosition: 'bottom' as const,
    verticalMarginPx: 40,
    subtitleBackground: { enabled: false, color: 'black' as const, opacityPercent: 60 },
  }
  return {
    id: 'e1', ...base, isDeleted: false, isEdited: false, original: { ...base }, ...patch,
  } as SubtitleEntry
}

/** The inline style of the OUTER positioned span (the transform carrier). */
function outerStyle(entry: SubtitleEntry): string {
  const html = renderToStaticMarkup(
    React.createElement(SubtitleOverlay, {
      entry, videoWidthPx: 1920, containerWidthPx: 1920,
    }),
  )
  // The outer span is the first element in the markup and the only one
  // carrying `--cue-anim-transform`.
  const m = html.match(/style="([^"]*--cue-anim-transform[^"]*)"/)
  expect(m, `no outer span in:\n${html.slice(0, 400)}`).not.toBeNull()
  return m![1].replace(/&quot;/g, '"')
}

function transformOf(style: string): string {
  const m = style.match(/(?:^|;)\s*transform:\s*([^;]*)/)
  return m === null ? '' : m[1].trim()
}

function originOf(style: string): string {
  const m = style.match(/transform-origin:\s*([^;]*)/)
  return m === null ? '' : m[1].trim()
}

const SCALE_ANIM = {
  animationType: 'scale' as const,
  animationInEnabled: true,
  animationOutEnabled: true,
  animationDurationSec: 0.4,
  animationStartScalePercent: 30,
}

const H3 = ['left', 'center', 'right'] as const
const V3 = ['top', 'center', 'bottom'] as const
const EXPECT_X = { left: '0%', center: '50%', right: '100%' }
const EXPECT_Y = { top: '0%', center: '50%', bottom: '100%' }

describe('REQ-0514 — the animation layer is the LAST transform function', () => {
  const cases: [string, Partial<SubtitleEntry>][] = [
    ['unpinned, bottom', {}],
    ['unpinned, centre (carries translateY)', { verticalPosition: 'center' }],
    ['DRAGGED (carries the pinned-anchor translate)', { posX: 463, posY: 263, verticalPosition: 'center' }],
    ['DRAGGED + rotated', { posX: 463, posY: 263, verticalPosition: 'center', rotation: 30 }],
    ['rotated only', { rotation: 30 }],
  ]
  for (const [label, patch] of cases) {
    it(`${label}: transform ends with var(--cue-anim-transform)`, () => {
      const t = transformOf(outerStyle(makeEntry({ ...SCALE_ANIM, ...patch })))
      expect(t).toMatch(/var\(--cue-anim-transform\)\s*$/)
      // ★ And nothing follows it.  A layout transform placed AFTER the
      // animation is inside the scale again — the exact defect.
      expect(t.indexOf('var(--cue-anim-transform)')).toBe(
        t.length - 'var(--cue-anim-transform)'.length,
      )
    })
  }

  it('the pinned-anchor translate is present but OUTSIDE the animation', () => {
    const t = transformOf(outerStyle(makeEntry({
      ...SCALE_ANIM, posX: 463, posY: 263, verticalPosition: 'center',
    })))
    expect(t).toContain('translate(-50%, -50%)')
    expect(t.indexOf('translate(-50%, -50%)')).toBeLessThan(t.indexOf('var(--cue-anim-transform)'))
  })
})

describe('REQ-0514 — transform-origin is the `\\an` anchor, unconditionally', () => {
  for (const h of H3) {
    for (const v of V3) {
      it(`${h}/${v} → "${EXPECT_X[h]} ${EXPECT_Y[v]}"`, () => {
        const style = outerStyle(makeEntry({
          ...SCALE_ANIM, horizontalPosition: h, verticalPosition: v,
        }))
        expect(originOf(style)).toBe(`${EXPECT_X[h]} ${EXPECT_Y[v]}`)
      })
    }
  }

  it('★ does not depend on whether the cue is DRAGGED — the REQ-0514 symptom', () => {
    const free = outerStyle(makeEntry({ ...SCALE_ANIM, verticalPosition: 'center' }))
    const pinned = outerStyle(makeEntry({
      ...SCALE_ANIM, verticalPosition: 'center', posX: 463, posY: 263,
    }))
    expect(originOf(pinned)).toBe(originOf(free))
  })

  it('★ does not depend on rotation — the pre-REQ-0514 `center center` branch is gone', () => {
    for (const h of H3) {
      for (const v of V3) {
        const flat = outerStyle(makeEntry({ ...SCALE_ANIM, horizontalPosition: h, verticalPosition: v }))
        const spun = outerStyle(makeEntry({
          ...SCALE_ANIM, horizontalPosition: h, verticalPosition: v, rotation: 30,
        }))
        expect(originOf(spun), `${h}/${v}`).toBe(originOf(flat))
      }
    }
  })

  it('★ does not depend on the animation type — `pop` scales too, and `none` still rotates', () => {
    const base = { horizontalPosition: 'left' as const, verticalPosition: 'top' as const }
    const scale = originOf(outerStyle(makeEntry({ ...SCALE_ANIM, ...base })))
    const pop = originOf(outerStyle(makeEntry({ ...SCALE_ANIM, ...base, animationType: 'pop' })))
    const fade = originOf(outerStyle(makeEntry({ ...SCALE_ANIM, ...base, animationType: 'fade' })))
    const none = originOf(outerStyle(makeEntry({ ...base, rotation: 30 })))
    expect(pop).toBe(scale)
    expect(fade).toBe(scale)
    expect(none).toBe(scale)
    expect(scale).toBe('0% 0%')
  })
})
