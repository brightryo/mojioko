import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * REQ-0539 — タブ2「文字スタイル」: keyword emphasis hidden, order matched to
 * the inspector.
 *
 * Two claims are worth pinning, and neither is about behaviour:
 *
 *   1. The emphasis row is HIDDEN, not deleted. Keywords are chosen per word in
 *      the inspector and nothing has been transcribed when this panel is shown,
 *      so the default has nothing to apply to — but the saved values
 *      (`keywordEmphasisEnabled` / `emphasisColorHex` / `emphasisScalePercent`)
 *      must survive untouched and keep reaching ASS generation.
 *   2. The animation rows sit BELOW the layout group, as they do in the
 *      inspector (字幕 → レイアウト → アニメーション).
 *
 * Like `transcription-drawer-tabs-layout.test.ts` (REQ-0437) this greps the
 * SOURCE rather than rendering: `vitest.config` includes only
 * `tests/unit/**\/*.test.ts` and the repo has no jsdom/RTL setup, so a render
 * test would mean new infrastructure this REQ did not ask for. The properties
 * being pinned are structural — which rows exist and in what order — which the
 * source states directly.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

const read = (p: string) => stripComments(readFileSync(resolve(__dirname, '../../', p), 'utf-8'))
const PANEL = read('src/renderer/components/default-style-controls/default-style-controls.tsx')
const DRAWER = read('src/renderer/components/step1/transcription-drawer.tsx')

describe('REQ-0539 §2-1 — keyword emphasis is hidden in タブ2', () => {
  it('the drawer asks for it to be hidden', () => {
    const call = /<DefaultStyleControls([\s\S]*?)\/>/.exec(DRAWER)
    expect(call, 'the drawer still renders DefaultStyleControls').not.toBeNull()
    expect(call?.[1]).toContain('showKeywordEmphasis={false}')
  })

  it('the prop defaults to TRUE, so no other caller changes', () => {
    // REQ-0485's `showFontList` pattern: opt OUT at the call site that wants
    // the narrower panel, leave the component's own behaviour alone.
    expect(PANEL).toMatch(/showKeywordEmphasis\s*=\s*true/)
  })

  it('the row is gated on the prop AND the tier gate, not one or the other', () => {
    expect(PANEL).toMatch(/showEmphasisUi\s*=\s*showKeywordEmphasis\s*&&\s*canUseKeywordEmphasisInTier/)
  })

  it('★ the stored emphasis defaults are still read and written (hidden, not deleted)', () => {
    for (const field of ['keywordEmphasisEnabled', 'emphasisColorHex', 'emphasisScalePercent']) {
      expect(PANEL, `${field} disappeared — that would change saved data`).toContain(field)
    }
  })
})

/**
 * Every row label in the panel, in source order. `AnimationControls` renders
 * four `StyleRow`s of its own, so it appears here as a single marker — which is
 * exactly the granularity this test cares about.
 */
function panelOrder(): string[] {
  const out: string[] = []
  // `(?<![-\w])` so `aria-label=` (which every control also carries) is not
  // mistaken for a row label — it would double most rows.
  const re = /(<AnimationControls\b)|(?<![-\w])label=\{t\('([^']+)'\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(PANEL)) !== null) out.push(m[1] ? '<AnimationControls>' : m[2])
  if (out.length === 0) throw new Error('no rows matched — the panel shape changed, not the order')
  return out
}

describe('REQ-0539 §2-2 — order matches the inspector', () => {
  it('★ animation comes AFTER the layout group', () => {
    const order = panelOrder()
    const anim = order.indexOf('<AnimationControls>')
    const layoutFirst = order.indexOf('step2:styleCell.layoutH')
    const layoutLast = order.indexOf('step2:styleCell.offset')
    expect(anim).toBeGreaterThan(-1)
    expect(layoutFirst).toBeGreaterThan(-1)
    expect(anim).toBeGreaterThan(layoutLast)
    expect(layoutFirst).toBeLessThan(layoutLast)
  })

  it('the full row order is the inspector order, minus the rows タブ2 has never had', () => {
    // ★ Pinning the WHOLE list, not just the animation move: the REQ forbids
    // adding or removing items, and a list that is merely "in the right order"
    // would not catch a row quietly appearing.
    expect(panelOrder()).toEqual([
      'subtitleDefaults.size',
      'subtitleDefaults.textColor',
      'subtitleDefaults.outlineColor',
      'subtitleDefaults.stroke',
      'step2:styleCell.shadow',
      'step2:styleCell.karaokeRowLabel',
      'step2:styleCell.emphasisRowLabel', // present in source, hidden by the prop
      'step2:styleCell.casing',
      'step2:styleCell.rotation',
      'step2:styleCell.layoutH',
      'step2:styleCell.layoutV',
      'step2:styleCell.marginV',
      'step2:styleCell.lineSpacing',
      'step2:styleCell.offset',
      '<AnimationControls>',
      'advanced.autoLineBreak',
    ])
  })

  it('the animation group is headed, so it does not read as part of レイアウト', () => {
    // The layout group above it is a bordered section; four unlabelled rows
    // after it would look like more layout rows. Reuses the inspector's key —
    // no new string.
    const head = PANEL.indexOf("t('step2:timeline.inspector.animationSection')")
    const anim = PANEL.indexOf('<AnimationControls')
    expect(head).toBeGreaterThan(-1)
    expect(head).toBeLessThan(anim)
  })
})
