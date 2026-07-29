import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { OutlineThicknessSlider } from '../../src/renderer/components/subtitle-table/outline-thickness-slider'
import { OUTLINE_THICKNESS_MAX_PX } from '../../src/shared/constants'

/**
 * REQ-0344 §2-1 — outline 0 is not selectable while the background box is on.
 *
 * ## Why the combination is broken
 *
 * The background box is `BorderStyle=3`, which libass draws by growing the
 * GLYPH OUTLINE by `\bord`.  At `\bord0` there is nothing to grow, so the box
 * collapses into the glyph and the burn carries no background whatsoever —
 * measured in RES-0340 §1-4 as zero white pixels in the exported frame.  The
 * preview does not reproduce this (it paints its box from a separate canvas
 * layer), so the user sees a background right up until they export.
 *
 * ## What is pinned, and what deliberately is NOT
 *
 * Pinned: the floor reaches the `<input>`, so the browser itself refuses the
 * value; and both surfaces that can reach the state pass it.
 *
 * NOT pinned, because it must not happen: any rewriting of a stored 0.  The
 * slider renders the real value even when it sits below the floor — a project
 * saved with 0 keeps its 0 and keeps its output.  The floor governs what the
 * user can pick next, not what is already on disk.  A test that asserted the
 * value was clamped would be asserting the bug this REQ was told to avoid.
 */
function html(props: Parameters<typeof OutlineThicknessSlider>[0]): string {
  return renderToStaticMarkup(React.createElement(OutlineThicknessSlider, props))
}

const BASE = {
  onCommit: () => {},
  ariaLabel: 'outline',
} as const

describe('REQ-0344 §2-1 — outline thickness floor under a background box', () => {
  it('defaults to a floor of 0, so surfaces without a background box are unchanged', () => {
    const out = html({ ...BASE, value: 0 })
    expect(out).toContain('min="0"')
    expect(out).toContain(`max="${OUTLINE_THICKNESS_MAX_PX}"`)
  })

  it('puts the floor on the input itself when raised, so the control cannot reach 0', () => {
    const out = html({ ...BASE, value: 3, min: 1, minReason: 'because' })
    expect(out).toContain('min="1"')
  })

  it('carries the explanation as a tooltip whenever the floor is raised', () => {
    // A control that silently refuses a value the user could pick a moment ago
    // is worse than one that never offered it.
    const out = html({ ...BASE, value: 3, min: 1, minReason: 'BG needs >= 1' })
    expect(out).toContain('BG needs &gt;= 1')
  })

  it('does not attach the tooltip when there is no floor to explain', () => {
    const out = html({ ...BASE, value: 3, min: 0, minReason: 'BG needs >= 1' })
    expect(out).not.toContain('BG needs &gt;= 1')
  })

  it('shows a stored value that is below the floor AS IT IS, not clamped', () => {
    // The legacy project case.  Rewriting this 0 would change what that
    // project renders, on open, without being asked.
    const out = html({ ...BASE, value: 0, min: 1, minReason: 'because' })
    expect(out).toMatch(/>0</)
  })

  it('marks a below-floor value in the warning colour so the dead box is visible', () => {
    const below = html({ ...BASE, value: 0, min: 1, minReason: 'because' })
    const ok = html({ ...BASE, value: 1, min: 1, minReason: 'because' })
    expect(below).toContain('text-warning-soft')
    expect(ok).not.toContain('text-warning-soft')
  })

  it('both surfaces that can reach the state key the floor off their own background flag', () => {
    // The settings "subtitle style" surface is intentionally absent: it edits
    // `TranscriptionDefaults`, which carries no `subtitleBackground` at all, so
    // no combination of its controls can produce the broken pair.
    const cases: [string, RegExp][] = [
      [
        'src/renderer/components/timeline-view/timeline-block-inspector.tsx',
        /min=\{entry\.subtitleBackground\.enabled \? 1 : 0\}/,
      ],
      [
        'src/renderer/components/subtitle-table/bulk-edit-bar.tsx',
        /min=\{bgEnabledDraft \? 1 : 0\}/,
      ],
    ]
    for (const [rel, re] of cases) {
      const src = readFileSync(path.resolve(__dirname, '../..', rel), 'utf8')
      expect(src, `${rel} passes a background-derived min`).toMatch(re)
      expect(src, `${rel} passes the reason`).toContain('outlineWidthBgMinNote')
    }
  })

  it('the settings subtitle-style surface has no background control to gate on', () => {
    // Stated as a test so that adding one there fails here, rather than
    // quietly reintroducing the broken combination on a third surface.
    const src = readFileSync(
      path.resolve(
        __dirname,
        '../../src/renderer/components/default-style-controls/default-style-controls.tsx',
      ),
      'utf8',
    )
    expect(src).not.toContain('subtitleBackground')
  })
})
