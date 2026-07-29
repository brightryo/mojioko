import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { FontFamilyBadges } from '../../src/renderer/components/font-lang-badge/font-family-badges'
import { getFontFamilies } from '../../src/shared/fonts'

/**
 * REQ-0341 §1 — the font-coverage warnings reach the surfaces people use.
 *
 * ## The defect
 *
 * The "rare kanji unsupported" chip and the EN/JA coverage chips existed only
 * in Settings > Fonts.  The three places a user actually PICKS a font — the
 * timeline inspector, the bulk-edit bar, and the default-font selector — all
 * render `FamilyWeightSelector`, which showed a bare family name.  Choosing
 * Hachi Maru Pop or Potta One from the inspector therefore carried no warning
 * at all, and an EN-only family like Anton gave no hint that every Japanese
 * glyph was about to become tofu.
 *
 * ## What is pinned here
 *
 * 1. the variant rules, because they are the whole design: `list` is the
 *    browsing vocabulary, `trigger` is the actionable subset;
 * 2. that the markup exists in exactly ONE module.  The chip used to be
 *    inline JSX inside `FontFamilyRow`; a second copy in the selector is how
 *    this project has repeatedly grown two predicates that drift apart
 *    (`fade-opacity.ts` in RES-0323, the duplicated ring paint in REQ-0328 §1).
 *
 * Assertions read `data-font-badge`, not label text, so they neither depend on
 * an initialised i18n instance nor break when the wording changes.
 */
function render(props: Parameters<typeof FontFamilyBadges>[0]): string {
  return renderToStaticMarkup(React.createElement(FontFamilyBadges, props))
}
function kinds(html: string): string[] {
  return Array.from(html.matchAll(/data-font-badge="([^"]+)"/g)).map((m) => m[1])
}

const JA_AND_EN = ['en', 'ja'] as const
const EN_ONLY = ['en'] as const

describe('REQ-0341 §1 — FontFamilyBadges', () => {
  describe('list variant (Settings > Fonts, family popover)', () => {
    it('shows every coverage chip a family declares', () => {
      expect(kinds(render({ languages: JA_AND_EN, lacksRareKanji: false })))
        .toEqual(['lang-en', 'lang-ja'])
    })

    it('shows the rare-kanji chip WITH its label', () => {
      const html = render({ languages: JA_AND_EN, lacksRareKanji: true })
      expect(kinds(html)).toEqual(['lang-en', 'lang-ja', 'rare-kanji'])
      // The labelled form carries text alongside the icon; the icon-only form
      // does not.  `gap-1` is only applied when there is a label to separate.
      expect(html).toMatch(/data-font-badge="rare-kanji"[^>]*class="[^"]*gap-1/)
    })
  })

  describe('trigger variant (FamilyWeightSelector closed button)', () => {
    it('★ stays silent for a family that covers Japanese and has all the kanji', () => {
      // Measured reason: at the startup window size the control column is
      // 182.7px.  A chip that says "this Japanese font does Japanese" costs
      // the family name width and tells the user nothing.
      expect(render({ languages: JA_AND_EN, lacksRareKanji: false, variant: 'trigger' }))
        .toBe('')
    })

    it('★ shows the coverage chip when the family does NOT cover Japanese', () => {
      // A lone EN chip IS the tofu warning, in the vocabulary the Settings
      // legend already teaches.
      expect(kinds(render({ languages: EN_ONLY, lacksRareKanji: false, variant: 'trigger' })))
        .toEqual(['lang-en'])
    })

    it('★ shows the rare-kanji chip, icon-only', () => {
      const html = render({ languages: JA_AND_EN, lacksRareKanji: true, variant: 'trigger' })
      expect(kinds(html)).toEqual(['rare-kanji'])
      // No label text next to the icon, and therefore no `gap-1` on the chip.
      expect(html).not.toMatch(/data-font-badge="rare-kanji"[^>]*class="[^"]*gap-1/)
      // Icon-only still needs an accessible name.
      expect(html).toMatch(/data-font-badge="rare-kanji"[^>]*aria-label="/)
    })

    it('carries at most one chip for every family in the registry', () => {
      // The width budget above assumes this.  If a future font is BOTH
      // EN-only and rare-kanji-flagged, the trigger grows a second chip and
      // the name loses ~28px — re-measure before shipping it.
      for (const fam of getFontFamilies()) {
        const n = kinds(render({
          languages: fam.languages, lacksRareKanji: fam.lacksRareKanji, variant: 'trigger',
        })).length
        expect(n, `${fam.cssFontFamily} renders ${n} trigger chips`).toBeLessThanOrEqual(1)
      }
    })
  })

  it('★ the rare-kanji chip is defined in exactly one module', () => {
    // The duplication this REQ removed: `font-picker.tsx` owned the markup and
    // nobody else could show it.  Any file that re-implements the chip has
    // re-implemented the predicate with it.
    const root = path.resolve(__dirname, '../../src/renderer')
    const owners = ['components/font-lang-badge/font-family-badges.tsx']
    const suspects = [
      'components/font-picker/font-picker.tsx',
      'components/subtitle-table/family-weight-selector.tsx',
    ]
    for (const rel of owners) {
      expect(readFileSync(path.join(root, rel), 'utf8')).toContain('data-font-badge="rare-kanji"')
    }
    for (const rel of suspects) {
      const src = readFileSync(path.join(root, rel), 'utf8')
      expect(src, `${rel} re-implements the chip`).not.toContain('missingRareKanjiHelp')
      expect(src, `${rel} re-implements the chip`).toContain('FontFamilyBadges')
    }
  })

  it('the two flagged families are still the ones the width budget was measured on', () => {
    const flagged = getFontFamilies().filter((f) => f.lacksRareKanji).map((f) => f.cssFontFamily)
    expect(flagged.sort()).toEqual(['MOJIOKO Hachi Maru Pop', 'MOJIOKO Potta One'])
  })
})
