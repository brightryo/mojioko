import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, AlertCircle, RotateCcw, Lock } from 'lucide-react'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { useSettingsStore } from '@/stores/settings-store'
import { useAppEnvStore } from '@/stores/app-env-store'
import { useStoreUpsellStore } from '@/stores/store-upsell-store'
import { useInstalledFontIds } from '@/lib/use-installed-fonts'
import { canSelectFontInTier } from '@/lib/font-tier'
import { cn } from '@/lib/utils'
import { getSortedFontRegistry, getFontMeta, type FontId } from '../../../shared/fonts'
import { FontLangBadges } from '@/components/font-lang-badge/font-lang-badge'

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
  // REQ-088 #4 — null treated as the more restrictive free tier until
  // the IPC settles; the popover would otherwise briefly offer paid
  // entries on the first paint of a free build.
  const isMsix = useAppEnvStore((s) => s.isMsix) ?? false
  // REQ-091 — clicking a locked entry below opens the upsell.
  const openUpsell = useStoreUpsellStore((s) => s.openUpsell)

  const resolvedFontId = value ?? activeFontId
  const resolvedMeta = getFontMeta(resolvedFontId)
  const isOverriding = value !== undefined && value !== activeFontId

  // Selectable list = every registered font that's actually installed
  // AND permitted by the current tier (REQ-088 #4 — free tier limits
  // selection to the bundled default even if a paid-tier user
  // downgraded with installed fonts on disk).  REQ-0153 §2 — sort
  // alphabetically by display name (was registry order = Noto first).
  // Uninstalled fonts are hidden so we never set a per-row fontId that
  // burn-in would reject.
  const sortedRegistry = getSortedFontRegistry()
  const selectable = sortedRegistry.filter(
    (m) => installed.has(m.id) && canSelectFontInTier(isMsix, m.id),
  )
  // REQ-091 — in the free tier, also render the paid-only fonts so the
  // user can discover them and click through to the upsell.  Listed
  // AFTER `selectable` (which in NSIS is just the default) so the
  // popover's first scroll-visible rows remain the ones the user can
  // actually pick.  Empty in MSIX (every installed font is already in
  // `selectable`); empty for the bundled default (never tier-locked).
  const tierLocked = !isMsix
    ? sortedRegistry.filter((m) => !canSelectFontInTier(isMsix, m.id))
    : []

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
                <FontLangBadges languages={m.languages} />
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

          {/* REQ-091 — tier-locked discovery rows.  Empty in MSIX
              (every installed font is in `selectable` above).  In NSIS
              these are paid-only fonts the user can't pick but can
              click to surface the Store upsell.  Visually muted +
              Lock icon so they read as "available with the paid
              version" rather than "broken / unavailable". */}
          {tierLocked.length > 0 && (
            <>
              <div className="my-1 h-px bg-surface-2" />
              {tierLocked.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => { openUpsell(); setOpen(false) }}
                  className={cn(
                    'flex items-center gap-2 px-2 py-1.5 rounded text-body-sm transition-colors text-left',
                    'hover:bg-accent/40 text-fg-muted',
                  )}
                  title={t('step1:fontPicker.action.lockedPaidOnly')}
                >
                  <Lock className="h-3 w-3 shrink-0" aria-hidden="true" />
                  <span
                    className="flex-1 min-w-0 truncate"
                    style={{ fontFamily: `'${m.cssFontFamily}'`, fontWeight: m.weight }}
                  >
                    {m.displayName}
                  </span>
                  <FontLangBadges languages={m.languages} />
                </button>
              ))}
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
