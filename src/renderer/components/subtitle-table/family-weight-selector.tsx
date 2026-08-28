import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, Lock } from 'lucide-react'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { useAppEnvStore } from '@/stores/app-env-store'
import { useStoreUpsellStore } from '@/stores/store-upsell-store'
import { useInstalledFontIds } from '@/lib/use-installed-fonts'
import { isFamilyTierLocked } from '../../../shared/font-tier'
import { cn } from '@/lib/utils'
import { StyleRow } from '@/components/subtitle-table/style-row'
import { FontFamilyBadges } from '@/components/font-lang-badge/font-family-badges'
import {
  getFontMeta,
  getFontFamilies,
  getFamilyDefaultFontId,
  getFontIdForFamilyAndWeight,
  stripFamilyNamespacePrefix,
  selectableFamilies,
  selectableWeightsForFamily,
  type FontId,
} from '../../../shared/fonts'

interface FamilyWeightSelectorProps {
  /** Currently-selected FontId (encodes both family and weight). */
  value: FontId
  /**
   * Fires with the new FontId whenever the user picks a family OR a
   * weight.  Picking a NEW family resets to that family's default weight
   * so `onChange` fires once — the caller pushes one history entry, and
   * a single Undo restores both fields together (REQ-0275 §5 + REQ-0269
   * B-5 / D-1 undo atomicity).
   */
  onChange: (next: FontId) => void
  disabled?: boolean
  /**
   * REQ-0296 §3 / REQ-0299 §2/§4/§6 — when `true`, render each dropdown
   * inside a shared `StyleRow` (label left + dashed filler + control
   * right).  Callers that pass this true (inspector, bulk-edit) get
   * hover backdrop + dotted filler for free and match the surrounding
   * rows exactly.  When `false` (FontPicker's legacy layout), the two
   * dropdowns stack bare — FontPicker has its own outer heading so it
   * doesn't want a per-dropdown label.
   */
  showLabels?: boolean
  /**
   * REQ-0348 §1 — whether the EN / JA / rare-kanji chips appear on the trigger
   * and in the family list.
   *
   * **Required, with no default.**  There are three call sites and they do not
   * agree, so a default would silently decide for whoever adds a fourth.  The
   * house convention for exactly this situation is to make the argument
   * required (`assFontName` in REQ-0340 §3, `karaokeStyle` in REQ-0344 §2-2):
   * a default cannot tell "the caller means this" from "the caller forgot".
   *
   * `false` — the editing surfaces (inspector, bulk-edit bar).  REQ-0341 §1
   * put the chips here on the reasoning that this is where a font is actually
   * chosen day to day, so a coverage warning belongs where the choice is made.
   * The owner decided otherwise (REQ-0348 §1-1): a font menu should read like
   * every other editor's, a plain list of names.  That is a deliberate,
   * informed trade — the tofu warning still exists, one screen away.
   *
   * `true` — Settings ▸ Fonts, which the owner kept as-is.  That screen is
   * where fonts are browsed and compared rather than picked mid-edit, and its
   * legend explains the vocabulary.
   */
  showCoverageBadges: boolean
}

/**
 * REQ-0275 §5 — two-tier family + weight picker.
 *
 * ## REQ-0299 §2/§4/§6 — always render BOTH rows
 *
 * Pre-REQ-0299 the weight row was hidden for single-weight families
 * (Anton, Bebas Neue, Poppins-Regular, etc.).  This caused the
 * inspector / bulk-edit column to shrink whenever the user picked
 * one of those families and grow again when they picked a
 * multi-weight one — a jumpy UI.  REQ-0299 §2 keeps the weight row
 * ALWAYS visible; for single-weight families the trigger is greyed
 * out and shows "—" (the default weight name still reads as
 * "Regular" but the row is non-interactive).
 *
 * ## REQ-0299 §4/§6 — StyleRow integration
 *
 * When `showLabels === true` each dropdown lives inside a shared
 * `StyleRow`, so the hover backdrop + dashed filler + label styling
 * inherit from the same shell every other inspector / bulk-edit row
 * uses.  Pre-REQ-0299 the selector rendered its own inline `[label |
 * dropdown]` layout and skipped the shared filler/hover.
 *
 * ## Data flow (unchanged)
 *
 * Both dropdowns are `<Popover>`-based; opening one closes the other.
 * The family list hides fonts not installed / not selectable in the
 * current tier.  Weight list shows only the weights registered for
 * the chosen family (tier-gated via `selectableWeightsForFamily`).
 * User-facing labels strip the internal `MOJIOKO ` prefix.
 */
export function FamilyWeightSelector({ value, onChange, disabled, showLabels, showCoverageBadges }: FamilyWeightSelectorProps) {
  const { t } = useTranslation(['step2', 'step1'])
  const [familyOpen, setFamilyOpen] = useState(false)
  const [weightOpen, setWeightOpen] = useState(false)
  const installed = useInstalledFontIds()
  const isMsix = useAppEnvStore((s) => s.isMsix) ?? false
  // REQ-0356 — same upsell entry point Settings ▸ Fonts uses.
  const openUpsell = useStoreUpsellStore((s) => s.openUpsell)

  const currentMeta = getFontMeta(value)
  const families = getFontFamilies()
  const currentFamily = families.find((f) => f.cssFontFamily === currentMeta.cssFontFamily)

  const isInstalled = (id: FontId) => installed.has(id)
  const familiesUi = selectableFamilies(families, isInstalled, isMsix).map((fam) => ({
    ...fam,
    isSelectable: true as const,
    displayLabel: stripFamilyNamespacePrefix(fam.cssFontFamily),
  }))

  /**
   * REQ-0356 — the paid-only families, shown but not pickable.
   *
   * `selectableFamilies` above drops a family for either of two reasons: it is
   * tier-locked, or it is not installed on disk.  Only the FIRST is something
   * the user can act on, so only that one is listed here — a paid build with a
   * family not yet downloaded keeps today's behaviour of hiding it, and gains
   * no padlocks (empty list whenever `isMsix`).
   */
  const lockedFamilies = families
    .filter((fam) => isFamilyTierLocked(isMsix, fam))
    .map((fam) => ({ ...fam, displayLabel: stripFamilyNamespacePrefix(fam.cssFontFamily) }))

  function pickFamily(family: typeof familiesUi[number]) {
    setFamilyOpen(false)
    const nextId = getFamilyDefaultFontId(family.cssFontFamily)
    if (nextId !== value) onChange(nextId)
  }

  function pickWeight(weight: number) {
    setWeightOpen(false)
    if (!currentFamily) return
    const nextId = getFontIdForFamilyAndWeight(currentFamily.cssFontFamily, weight)
    if (nextId !== value) onChange(nextId)
  }

  const currentFamilyLabel = stripFamilyNamespacePrefix(currentMeta.cssFontFamily)
  const weightName = currentMeta.displayName.startsWith(currentFamilyLabel)
    ? (currentMeta.displayName.slice(currentFamilyLabel.length).trim() || 'Regular')
    : currentMeta.displayName

  const triggerBase = cn(
    'inline-flex items-center justify-between gap-1.5 w-full',
    // REQ-0421 (step2) — overlay reassignment: font/weight trigger (Noto Sans JP・Black) caption → body-sm.
    'h-6 px-2 rounded-md border text-body-sm text-left transition-colors duration-150',
    'border-line bg-surface-0 hover:border-line-strong',
    'focus:outline-none focus-visible:outline-none',
    'disabled:opacity-40 disabled:cursor-not-allowed',
    'text-fg-primary',
  )

  const familyDropdown = (
    // REQ-0487 §2 — `modal` so the popover's own react-remove-scroll lock sits
    // on top of the settings-dialog / setup-drawer lock.  Without it the list
    // portals OUTSIDE the dialog's RemoveScroll subtree, so wheel events over
    // the open list are preventDefault-ed and the list will not scroll (arrow
    // keys and scrollbar-drag still worked, which is exactly the reported
    // asymmetry).  Radix `Select` scrolls inside these same dialogs for the
    // same reason: it is modal.
    <Popover open={familyOpen} onOpenChange={setFamilyOpen} modal>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={triggerBase}
          aria-label={t('rowFont.tooltipOverride', { name: currentFamilyLabel })}
        >
          {/* REQ-0341 §1 put the selected family's badges here, so a coverage
              warning would be visible while typing rather than only while the
              dropdown was open.  REQ-0348 §1 makes that conditional: on the
              editing surfaces the owner wants a plain font name, the way every
              other editor shows one.  Where the chips DO render, `min-w-0` +
              `truncate` on the name still gives them priority — they are
              `shrink-0` — because the family name is recoverable from the
              trigger's `aria-label` and from the list, and the tofu warning
              is not. */}
          <span className="flex items-center gap-1.5 min-w-0 flex-1">
            <span
              className="truncate"
              style={{ fontFamily: `'${currentMeta.cssFontFamily}'`, fontWeight: currentMeta.weight }}
            >
              {currentFamilyLabel}
            </span>
            {showCoverageBadges && currentFamily && (
              <FontFamilyBadges
                languages={currentFamily.languages}
                lacksRareKanji={currentFamily.lacksRareKanji}
                variant="trigger"
              />
            )}
          </span>
          <ChevronDown className="h-3 w-3 shrink-0 text-fg-muted" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        collisionPadding={8}
        // REQ-0487 §1 — width follows CONTENT (`w-max`) with a floor and a
        // ceiling, rather than the old fixed `w-[240px]`.
        //   • `min-w-[240px]`  keeps a short list (e.g. Noto-only on a fresh
        //      machine) from looking cramped.
        //   • `w-max`          grows to the widest single-line row so the name
        //      and the EN / JA / rare-kanji chips sit on ONE line.  The chips
        //      are wider in English ("Rare kanji unsupported" vs 稀な漢字非対応),
        //      so `w-max` sizes to whichever locale is active — no locale-tuned
        //      constant to drift.
        //   • `max-w-[...]`     caps at the viewport (min window is 1280 wide,
        //      so the cap never bites in practice); the name then truncates
        //      gracefully instead of overflowing if a face is ever wider.
        // The popover portals to <body> and Radix keeps it on-screen via
        // `collisionPadding`, so the narrower setup drawer needs no separate
        // width — the panel floats above the drawer, it is not clipped by it.
        // `scrollbar-gutter:stable` reserves the vertical scrollbar's width up
        // front so `w-max` includes it: without it the scrollbar would shave
        // the content box and re-introduce a 1-px horizontal scrollbar (the
        // very bar REQ-0487 removes).  `overflow-x-hidden` is belt-and-braces
        // against the CSS rule that `overflow-y:auto` makes `overflow-x`
        // compute to `auto`.
        className="w-max min-w-[240px] max-w-[calc(100vw-16px)] p-1 max-h-[var(--radix-popover-content-available-height)] overflow-y-auto overflow-x-hidden [scrollbar-gutter:stable]"
      >
        <div className="flex flex-col">
          {familiesUi.map((fam) => {
            const isCurrent = fam.cssFontFamily === currentMeta.cssFontFamily
            return (
              <button
                key={fam.cssFontFamily}
                type="button"
                onClick={() => pickFamily(fam)}
                className={cn(
                  // REQ-0487 §1 — one row = one line: [dot] [name] [chips].
                  // Pre-0487 this was `flex-col` with the chips on a second
                  // line (REQ-0344), a workaround for the fixed 240 px width
                  // that squeezed the name to 0.  Now the panel widens to fit
                  // both, so the chips return beside the name — which is what
                  // the owner asked for and reads like every other font menu.
                  'flex items-center gap-2 px-2 py-1.5 rounded text-body-sm transition-colors text-left',
                  'hover:bg-accent/40',
                  isCurrent ? 'text-fg-primary' : 'text-fg-secondary',
                )}
              >
                <span
                  className={cn('h-2 w-2 rounded-full shrink-0', isCurrent ? 'bg-primary' : 'bg-surface-4')}
                  aria-hidden="true"
                />
                <span
                  className="flex-1 min-w-0 truncate"
                  style={{ fontFamily: `'${fam.cssFontFamily}'`, fontWeight: fam.defaultFontId ? getFontMeta(fam.defaultFontId).weight : 400 }}
                >
                  {fam.displayLabel}
                </span>
                {showCoverageBadges && (
                  <FontFamilyBadges
                    languages={fam.languages}
                    lacksRareKanji={fam.lacksRareKanji}
                    className="shrink-0"
                  />
                )}
              </button>
            )
          })}

          {/* REQ-0356 — paid-only families, restored to the editing surfaces.
              This is the shape `RowFontSelector` shipped with in v1.3.5
              (REQ-091): listed AFTER the pickable rows behind a separator, so
              what the user can actually choose still comes first, and muted +
              padlocked so they read as "available with the paid version"
              rather than "broken".  Clicking opens the same Store upsell
              Settings ▸ Fonts opens, with the same string.

              Empty in the paid tier, so its list is byte-identical to before.

              No coverage chips here: REQ-0348 §1 removed the badge vocabulary
              from the editing surfaces, and that decision stands — the lock is
              the only thing being added back. */}
          {lockedFamilies.length > 0 && (
            <>
              <div className="my-1 h-px bg-surface-2" aria-hidden="true" />
              {lockedFamilies.map((fam) => (
                <button
                  key={fam.cssFontFamily}
                  type="button"
                  data-font-locked="true"
                  onClick={() => { setFamilyOpen(false); openUpsell() }}
                  className={cn(
                    'flex items-center gap-2 px-2 py-1.5 rounded text-body-sm transition-colors text-left',
                    'hover:bg-accent/40 text-fg-muted',
                  )}
                  title={t('step1:fontPicker.action.lockedPaidOnly')}
                  aria-label={t('step1:fontPicker.action.lockedPaidOnly')}
                >
                  <Lock className="h-3 w-3 shrink-0" aria-hidden="true" />
                  <span
                    className="flex-1 min-w-0 truncate"
                    style={{
                      fontFamily: `'${fam.cssFontFamily}'`,
                      fontWeight: fam.defaultFontId ? getFontMeta(fam.defaultFontId).weight : 400,
                    }}
                  >
                    {fam.displayLabel}
                  </span>
                </button>
              ))}
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )

  // REQ-0299 §2 — weight row is ALWAYS rendered.  When the current
  // family has only one weight (Anton / Bebas / Poppins-single /
  // etc.), we render the trigger as a disabled greyed-out button
  // showing the sole weight name (typically "Regular") so the row
  // still occupies the same vertical space — no jumpy column when
  // switching families.
  const hasMultipleWeights = !!currentFamily && currentFamily.hasMultipleWeights
  const weightDropdown = hasMultipleWeights ? (
    // REQ-0487 §2 — same `modal` fix as the family popover so a long weight
    // list (Noto ships many) scrolls on the wheel inside the dialog / drawer.
    <Popover open={weightOpen} onOpenChange={setWeightOpen} modal>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={triggerBase}
          aria-label={weightName}
        >
          <span className="truncate">{weightName}</span>
          <ChevronDown className="h-3 w-3 shrink-0 text-fg-muted" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        collisionPadding={8}
        // REQ-0487 §1 — mirror the family popover's sizing so both dropdowns
        // behave identically (content-driven within a floor/ceiling, no
        // spurious horizontal scrollbar).
        className="w-max min-w-[240px] max-w-[calc(100vw-16px)] p-1 max-h-[var(--radix-popover-content-available-height)] overflow-y-auto overflow-x-hidden [scrollbar-gutter:stable]"
      >
        <div className="flex flex-col">
          {selectableWeightsForFamily(currentFamily!, isInstalled, isMsix)
            .map((w) => {
              const isCurrent = w.fontId === value
              const label = w.displayName.startsWith(currentFamilyLabel)
                ? (w.displayName.slice(currentFamilyLabel.length).trim() || 'Regular')
                : w.displayName
              return (
                <button
                  key={w.fontId}
                  type="button"
                  onClick={() => pickWeight(w.weight)}
                  className={cn(
                    'flex items-center gap-2 px-2 py-1.5 rounded text-body-sm transition-colors text-left',
                    'hover:bg-accent/40',
                    isCurrent ? 'text-fg-primary' : 'text-fg-secondary',
                  )}
                >
                  <span
                    className={cn('h-2 w-2 rounded-full shrink-0', isCurrent ? 'bg-primary' : 'bg-surface-4')}
                    aria-hidden="true"
                  />
                  <span
                    className="flex-1 min-w-0 truncate"
                    style={{ fontFamily: `'${currentMeta.cssFontFamily}'`, fontWeight: w.weight }}
                  >
                    {label}
                  </span>
                  <span className="text-caption text-fg-muted tabular-nums">{w.weight}</span>
                </button>
              )
            })}
        </div>
      </PopoverContent>
    </Popover>
  ) : (
    // REQ-0299 §2 — single-weight family: disabled placeholder trigger.
    // Shows the sole weight name (typically "Regular") with no
    // chevron so the affordance reads as "cannot expand".  The row
    // still occupies the same vertical space as when a multi-weight
    // family is selected → no column-height jump on family switch.
    <button
      type="button"
      disabled
      className={cn(triggerBase, 'cursor-not-allowed')}
      aria-label={weightName}
      title={weightName}
    >
      <span className="truncate text-fg-muted">{weightName}</span>
    </button>
  )

  // REQ-0299 §4/§6 — when `showLabels` is true, wrap each dropdown
  // in a shared `StyleRow` so the hover backdrop + dashed filler +
  // label styling are inherited from the same shell every other
  // inspector / bulk-edit row uses.  When `showLabels` is false
  // (FontPicker layout), stack the dropdowns bare inside the
  // caller-supplied outer container.
  // REQ-0300 §2 — dropdowns are `w-full` inside StyleRow's fixed
  // control column, so they fill the column width uniformly with
  // sliders + pickers in the surrounding rows (and never truncate
  // to "N…" like they did when the wrapper was a fractional width
  // in a narrow pane).
  if (showLabels) {
    return (
      <>
        <StyleRow label={t('step2:styleCell.family')}>
          {familyDropdown}
        </StyleRow>
        <StyleRow label={t('step2:styleCell.weight')}>
          {weightDropdown}
        </StyleRow>
      </>
    )
  }

  return (
    <div className="flex flex-col gap-1">
      {familyDropdown}
      {weightDropdown}
    </div>
  )
}
