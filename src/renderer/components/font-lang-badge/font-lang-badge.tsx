import { cn } from '@/lib/utils'
import type { FontLanguage } from '../../../shared/fonts'

/**
 * REQ-0153 / REQ-0154 — shared "JA" / "EN" chip painted next to every
 * font display name across the app.  A single component so the visual
 * is uniform across:
 *
 *   - Settings > Fonts picker (FontPicker.FontRow)
 *   - Timeline inspector per-row selector (RowFontSelector)
 *   - Bulk-edit bar font selector (BulkEditBar)
 *   - License attribution list (FontLicensesDialog)
 *
 * The chip does not affect selectability or missing-glyph behaviour —
 * REQ policy is "tofu OK", the badge is the discovery signal that
 * lets a user tell at a glance which scripts a face covers.
 *
 * REQ-0154 §3 — palette bumped from the pre-REQ-0154 zinc-only pill
 * (owner reported it as hard to read at 10px) to two vendor-agnostic
 * accent tints.  Both use the same "muted saturated on dark" pattern
 * the rest of the app uses for status chips (see e.g. the transcription
 * drawer's device chip) — border-500/40 + bg-500/15 + text-200, high
 * enough contrast to read at caption size without competing with the
 * display name it sits next to.
 *
 * REQ-0163 §2 — `ja` moved from amber to pink.  Rationale:
 *   1. The tofu note directly below the picker adopts an amber warning
 *      tone in the same REQ (§1).  Keeping `ja` amber would put two
 *      unrelated warm-yellow signals inside the same visual area —
 *      the badge (script coverage, neutral) and the note (missing-glyph
 *      warning, attention-grabbing) — and blur the message that "amber
 *      = something you should notice".
 *   2. Pink stays clearly distinct from sky (`en`), reads well against
 *      the zinc-950/900 dark surfaces, and doesn't clash with the app's
 *      green primary the way a saturated red or fuchsia would.
 *   3. The `pink-500` mid-tone with `text-pink-200` matches the same
 *      "muted saturated on dark" recipe as `sky` (Linear-friendly
 *      restraint, no neon).  Rejected alternatives: `rose` reads too
 *      red at caption size (competes with destructive-action colors);
 *      `fuchsia` reads too purple (steps into the app's future dark
 *      accents territory).
 */
const PALETTE: Record<FontLanguage, string> = {
  ja: 'border-pink-500/40 bg-pink-500/15 text-pink-200',
  en: 'border-sky-500/40 bg-sky-500/15 text-sky-200',
}

export function FontLangBadge({
  language,
  className,
}: {
  language: FontLanguage
  className?: string
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-1.5 py-[1px]',
        'text-caption font-mono font-semibold uppercase tracking-wider',
        'border shrink-0',
        PALETTE[language],
        className,
      )}
      aria-label={language === 'ja' ? 'Japanese font' : 'Latin font'}
    >
      {language}
    </span>
  )
}

/**
 * REQ-0154 §1 / §3 — render every badge a font declares in
 * `FontMeta.languages`, separated by a small gap.  Used at all four
 * font-list render sites so a face like Noto Sans JP surfaces
 * "JA · EN" instead of the pre-REQ-0154 single "JA".
 */
export function FontLangBadges({
  languages,
  className,
}: {
  languages: readonly FontLanguage[]
  className?: string
}) {
  return (
    <span className={cn('inline-flex items-center gap-1 shrink-0', className)}>
      {languages.map((lang) => (
        <FontLangBadge key={lang} language={lang} />
      ))}
    </span>
  )
}
