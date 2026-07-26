import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown } from 'lucide-react'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { useAppEnvStore } from '@/stores/app-env-store'
import { useInstalledFontIds } from '@/lib/use-installed-fonts'
import { cn } from '@/lib/utils'
import { StyleRow } from '@/components/subtitle-table/style-row'
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
export function FamilyWeightSelector({ value, onChange, disabled, showLabels }: FamilyWeightSelectorProps) {
  const { t } = useTranslation(['step2', 'step1'])
  const [familyOpen, setFamilyOpen] = useState(false)
  const [weightOpen, setWeightOpen] = useState(false)
  const installed = useInstalledFontIds()
  const isMsix = useAppEnvStore((s) => s.isMsix) ?? false

  const currentMeta = getFontMeta(value)
  const families = getFontFamilies()
  const currentFamily = families.find((f) => f.cssFontFamily === currentMeta.cssFontFamily)

  const isInstalled = (id: FontId) => installed.has(id)
  const familiesUi = selectableFamilies(families, isInstalled, isMsix).map((fam) => ({
    ...fam,
    isSelectable: true as const,
    displayLabel: stripFamilyNamespacePrefix(fam.cssFontFamily),
  }))

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
    'h-6 px-2 rounded-md border text-caption text-left transition-colors duration-150',
    'border-line bg-surface-0 hover:border-line-strong',
    'focus:outline-none focus-visible:outline-none',
    'disabled:opacity-40 disabled:cursor-not-allowed',
    'text-fg-primary',
  )

  const familyDropdown = (
    <Popover open={familyOpen} onOpenChange={setFamilyOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={triggerBase}
          aria-label={t('rowFont.tooltipOverride', { name: currentFamilyLabel })}
        >
          <span
            className="truncate"
            style={{ fontFamily: `'${currentMeta.cssFontFamily}'`, fontWeight: currentMeta.weight }}
          >
            {currentFamilyLabel}
          </span>
          <ChevronDown className="h-3 w-3 shrink-0 text-fg-muted" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        collisionPadding={8}
        className="w-[240px] p-1 max-h-[var(--radix-popover-content-available-height)] overflow-y-auto"
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
              </button>
            )
          })}
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
    <Popover open={weightOpen} onOpenChange={setWeightOpen}>
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
        className="w-[240px] p-1 max-h-[var(--radix-popover-content-available-height)] overflow-y-auto"
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
  if (showLabels) {
    return (
      <>
        <StyleRow label={t('step2:styleCell.family')}>
          <div className="w-[50%]">{familyDropdown}</div>
        </StyleRow>
        <StyleRow label={t('step2:styleCell.weight')}>
          <div className="w-[50%]">{weightDropdown}</div>
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
