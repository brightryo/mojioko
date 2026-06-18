import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, AlertCircle, RotateCcw } from 'lucide-react'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { useSettingsStore } from '@/stores/settings-store'
import { useInstalledFontIds } from '@/lib/use-installed-fonts'
import { cn } from '@/lib/utils'
import { FONT_REGISTRY, getFontMeta, type FontId } from '../../../shared/fonts'

interface RowFontSelectorProps {
  /** Current per-row override.  `undefined` = inherit project default. */
  value: FontId | undefined
  /** Called with the new override; pass `undefined` to clear back to default. */
  onChange: (next: FontId | undefined) => void
  disabled?: boolean
}

/**
 * Per-row font picker for the STEP 2 subtitle table.
 *
 * Trigger button shows the currently-resolved font name — explicit override
 * when set, or the project default's name with a "デフォルト" prefix when
 * inheriting.  Click opens a popover listing every installed / bundled
 * font; the "default" option appears at the top, visually distinct, so
 * the user can always get back to project-wide consistency without
 * remembering the exact default font name.
 *
 * Non-installed fonts are filtered out — the per-row picker is the only
 * surface that does so in real time, because picking an uninstalled font
 * here would queue a row that the burn-in validation (REQ-022 step 6)
 * would later have to refuse.  Installation happens in the Subtitle Style
 * dialog or Settings ▸ Fonts.
 *
 * REQ-022 step 1.
 */
export function RowFontSelector({ value, onChange, disabled }: RowFontSelectorProps) {
  const { t } = useTranslation(['step2', 'step1'])
  const [open, setOpen] = useState(false)
  const activeFontId = useSettingsStore((s) => s.activeFontId)
  const installed = useInstalledFontIds()

  const resolvedFontId = value ?? activeFontId
  const resolvedMeta = getFontMeta(resolvedFontId)
  const isOverriding = value !== undefined && value !== activeFontId

  // Selectable list = every registered font that's actually installed.
  // Uninstalled fonts are hidden so we never set a per-row fontId that
  // burn-in would reject.  Order follows the registry (Noto first).
  const selectable = FONT_REGISTRY.filter((m) => installed.has(m.id))

  function pick(next: FontId | undefined) {
    onChange(next)
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          onClick={(e) => e.stopPropagation()}
          className={cn(
            'inline-flex items-center justify-between gap-1.5 w-full',
            'h-6 px-2 rounded-md border text-caption text-left transition-colors duration-150',
            'border-line bg-surface-0 hover:border-line-strong',
            'focus:outline-none focus-visible:outline-none',
            'disabled:opacity-40 disabled:cursor-not-allowed',
            isOverriding ? 'text-fg-primary' : 'text-fg-tertiary'
          )}
          title={isOverriding
            ? t('rowFont.tooltipOverride', { name: resolvedMeta.displayName })
            : t('rowFont.tooltipDefault', { name: resolvedMeta.displayName })}
        >
          <span className="flex items-center gap-1.5 min-w-0">
            {!isOverriding && (
              <span className="text-micro uppercase tracking-wide text-fg-muted shrink-0">
                {t('rowFont.defaultPrefix')}
              </span>
            )}
            <span className="truncate" style={{ fontFamily: `'${resolvedMeta.cssFontFamily}'`, fontWeight: resolvedMeta.weight }}>
              {resolvedMeta.displayName}
            </span>
            {resolvedMeta.lacksRareKanji && (
              <AlertCircle className="h-3 w-3 shrink-0 text-warning-soft/80" aria-hidden="true" />
            )}
          </span>
          <ChevronDown className="h-3 w-3 shrink-0 text-fg-muted" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[260px] p-1"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-col">
          {/* "Use default" — only meaningful when the row currently has
              an explicit override.  We still render it as disabled in
              the non-overriding case so the option's position is stable
              across rows. */}
          <button
            type="button"
            onClick={() => pick(undefined)}
            disabled={!isOverriding}
            className={cn(
              'flex items-center gap-2 px-2 py-1.5 rounded text-body-sm transition-colors text-left',
              isOverriding
                ? 'hover:bg-accent/40 text-fg-primary cursor-pointer'
                : 'text-fg-muted cursor-default'
            )}
          >
            <RotateCcw className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="flex-1 min-w-0">
              <span className="block leading-tight">{t('rowFont.useDefault')}</span>
              <span className="block text-caption text-fg-muted truncate">
                {getFontMeta(activeFontId).displayName}
              </span>
            </span>
          </button>

          <div className="my-1 h-px bg-surface-2" />

          {selectable.map((m) => {
            const isCurrent = m.id === (value ?? activeFontId)
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => pick(m.id === activeFontId ? undefined : m.id)}
                className={cn(
                  'flex items-center gap-2 px-2 py-1.5 rounded text-body-sm transition-colors text-left',
                  'hover:bg-accent/40',
                  isCurrent ? 'text-fg-primary' : 'text-fg-secondary'
                )}
              >
                <span
                  className={cn(
                    'h-2 w-2 rounded-full shrink-0',
                    isCurrent ? 'bg-primary' : 'bg-surface-4'
                  )}
                  aria-hidden="true"
                />
                <span
                  className="flex-1 min-w-0 truncate"
                  style={{ fontFamily: `'${m.cssFontFamily}'`, fontWeight: m.weight }}
                >
                  {m.displayName}
                </span>
                {m.lacksRareKanji && (
                  <span
                    className="inline-flex items-center gap-0.5 shrink-0 text-micro uppercase tracking-wide text-warning-faint/80"
                    title={t('step1:fontPicker.note.missingRareKanjiHelp')}
                  >
                    <AlertCircle className="h-2.5 w-2.5" aria-hidden="true" />
                  </span>
                )}
              </button>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}
