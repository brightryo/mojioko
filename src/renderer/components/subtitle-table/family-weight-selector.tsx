import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown } from 'lucide-react'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { useAppEnvStore } from '@/stores/app-env-store'
import { useInstalledFontIds } from '@/lib/use-installed-fonts'
import { canSelectFontInTier } from '@/lib/font-tier'
import { cn } from '@/lib/utils'
import {
  getFontMeta,
  getFontFamilies,
  getFamilyDefaultFontId,
  getFontIdForFamilyAndWeight,
  stripFamilyNamespacePrefix,
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
}

/**
 * REQ-0275 §5 — two-tier family + weight picker.  Stacks vertically so
 * it fits the inspector column and the bulk-edit column without
 * horizontal overflow.
 *
 *   ┌─────────────────────┐
 *   │ Family: Noto Sans JP ▾│   ← family dropdown
 *   ├─────────────────────┤
 *   │ Weight: SemiBold    ▾│   ← weight dropdown (hidden for single-weight families)
 *   └─────────────────────┘
 *
 * Both dropdowns are `<Popover>`-based; opening one closes the other.
 * The family list hides fonts not installed / not selectable in the
 * current tier.  Weight list shows only the weights registered for the
 * chosen family (typically 9 for Noto / Poppins; hidden for the 11
 * single-weight families).
 *
 * User-facing labels strip the internal `MOJIOKO ` prefix
 * (REQ-0275 §2-2) via `stripFamilyNamespacePrefix`; the raw
 * `cssFontFamily` is only used for the `font-family: '…'` inline style
 * that renders each family name in its own face.
 */
export function FamilyWeightSelector({ value, onChange, disabled }: FamilyWeightSelectorProps) {
  const { t } = useTranslation(['step2', 'step1'])
  const [familyOpen, setFamilyOpen] = useState(false)
  const [weightOpen, setWeightOpen] = useState(false)
  const installed = useInstalledFontIds()
  const isMsix = useAppEnvStore((s) => s.isMsix) ?? false

  const currentMeta = getFontMeta(value)
  const families = getFontFamilies()
  const currentFamily = families.find((f) => f.cssFontFamily === currentMeta.cssFontFamily)

  // Selectable families: any family that has at least one selectable+installed weight.
  const familiesUi = families.map((fam) => {
    const anySelectable = fam.weights.some((w) => installed.has(w.fontId) && canSelectFontInTier(isMsix, w.fontId))
    return { ...fam, isSelectable: anySelectable, displayLabel: stripFamilyNamespacePrefix(fam.cssFontFamily) }
  }).filter((f) => f.isSelectable)

  function pickFamily(family: typeof familiesUi[number]) {
    setFamilyOpen(false)
    // REQ-0269 B-5 / REQ-0275 §5 — family switch always resets to the
    // family default weight.  Passing the default FontId as one write
    // keeps undo atomic.
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
  // Extract the weight name from displayName by trimming the family
  // display name off the front (e.g. "Noto Sans JP SemiBold" → "SemiBold").
  // Falls back to "Regular" for single-weight fonts whose displayName
  // is just the family name.
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

  return (
    <div className="flex flex-col gap-1">
      {/* Family dropdown */}
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

      {/* Weight dropdown — hidden for single-weight families */}
      {currentFamily && currentFamily.hasMultipleWeights && (
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
              {currentFamily.weights
                .filter((w) => installed.has(w.fontId) && canSelectFontInTier(isMsix, w.fontId))
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
      )}
    </div>
  )
}
