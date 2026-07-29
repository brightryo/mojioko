import { AlertCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { FontLangBadges } from './font-lang-badge'
import type { FontLanguage } from '../../../shared/fonts'

/**
 * REQ-0341 §1 — the badges that describe a font family, in ONE place.
 *
 * ## Why this exists
 *
 * The "rare kanji unsupported" chip was inline JSX inside `FontFamilyRow`
 * (Settings > Fonts).  That is the only surface that had it — and it is the
 * surface a user visits once.  The three places a user actually PICKS a font
 * day to day (timeline inspector, bulk-edit bar, and the default-font selector
 * in Settings) all go through `FamilyWeightSelector`, which showed the family
 * name and nothing else.  So choosing Hachi Maru Pop or Potta One from the
 * inspector carried no warning at all, and the first sign of trouble was 塡 /
 * 剝 / 頰 rendering in a different face mid-word — or, for an EN-only family
 * like Anton, every Japanese glyph coming back as tofu.
 *
 * Tofu is the failure mode this project has spent the most effort on (the
 * pre-render substitution in `glyph-substitute.ts` exists because libass must
 * never be handed a glyph the face lacks), and even that substitution renders
 * □ for a character the font does not have.  A warning that only appears on
 * the surface you do not use is not a warning.
 *
 * Both signals are already computed once, per family, by `getFontFamilies()`
 * (`shared/fonts.ts`): `languages` is the union over the family's weights and
 * `lacksRareKanji` is true when any weight declares it.  This component takes
 * those two fields and nothing else, so there is no second predicate to drift
 * — which is the specific failure this project keeps repeating (see
 * `fade-opacity.ts` "mirrors" in RES-0323, and the two copies of the ring
 * paint in REQ-0328 §1).
 *
 * ## The two variants, and why the trigger is not just a smaller `list`
 *
 * `list` — the browsing surfaces (Settings > Fonts, and the family popover,
 * which is 240 px wide).  Every chip, with its label.  This is where a user
 * compares faces, so the full vocabulary belongs here and the Settings legend
 * explains it.
 *
 * `trigger` — `FamilyWeightSelector`'s closed button, which sits in
 * `StyleRow`'s control column.  MEASURED at the startup window size
 * (1280x820, right pane 367 px): that column is **182.7 px**, not the 224 px
 * basis, and it lives inside an `overflow-x-hidden` wrapper, so anything too
 * wide is silently CLIPPED rather than scrolled — the trap that
 * `inspector-opacity-fit` and `inspector-karaoke-row-fit` exist to catch.
 *
 * Rendering the full set there costs more than it gives: with EN + JA + the
 * rare-kanji chip, "Hachi Maru Pop" was measured collapsing to 54 px of the
 * 119 px it needs — the user could no longer read WHICH font they had
 * selected, in order to be told something about it.  So the trigger shows
 * only what is ACTIONABLE:
 *
 *   - the coverage chips only when the family does NOT cover Japanese.  Every
 *     JA face in the registry also carries Latin (RES-0338 §3-1, from the cmap
 *     probe), so "missing a script" and "missing JA" are the same condition,
 *     and a lone EN chip is exactly the "your Japanese will be tofu" signal in
 *     the vocabulary the legend already teaches.  A JA-capable family gets no
 *     chip, because "this Japanese font does Japanese" is not news.
 *   - the rare-kanji chip, icon-only, same colour and same `title`.
 *
 * In the current registry those two are mutually exclusive, so the trigger
 * carries at most one chip and the family name keeps ~140 px.
 *
 * `data-font-badge` is on every chip so tests and the Playwright probes can
 * find them STRUCTURALLY instead of by i18n string.
 */
export function FontFamilyBadges({
  languages,
  lacksRareKanji,
  variant = 'list',
  className,
}: {
  languages: readonly FontLanguage[]
  lacksRareKanji: boolean
  /** `'trigger'` shows only the actionable chips — see the note above. */
  variant?: 'list' | 'trigger'
  className?: string
}) {
  const { t } = useTranslation(['step1'])
  const isTrigger = variant === 'trigger'
  // The one place the "does this family cover Japanese?" question is asked.
  const coversJapanese = languages.includes('ja')
  const showLanguages = isTrigger ? !coversJapanese : languages.length > 0
  if (!showLanguages && !lacksRareKanji) return null
  return (
    <span className={cn('inline-flex items-center gap-1 shrink-0', className)}>
      {showLanguages && <FontLangBadges languages={languages} />}
      {lacksRareKanji && (
        <span
          data-font-badge="rare-kanji"
          className={cn(
            'inline-flex items-center shrink-0 rounded text-caption uppercase tracking-wide',
            'text-warning-faint/90 border border-warning-soft/30 bg-warning-soft/10',
            isTrigger ? 'px-1 py-0.5' : 'gap-1 px-1.5 py-0.5',
          )}
          title={t('step1:fontPicker.note.missingRareKanjiHelp')}
          // The icon-only form has no text, so it needs the accessible name
          // the label would otherwise have carried.
          aria-label={isTrigger ? t('step1:fontPicker.note.missingRareKanji') : undefined}
        >
          <AlertCircle className="h-3 w-3 shrink-0" aria-hidden="true" />
          {!isTrigger && t('step1:fontPicker.note.missingRareKanji')}
        </span>
      )}
    </span>
  )
}
