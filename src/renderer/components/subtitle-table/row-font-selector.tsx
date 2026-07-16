import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, AlertCircle, Lock } from 'lucide-react'
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
  // REQ-0169 §1 — scroll-into-view target for the currently active row.
  // The Popover mounts empty and gets painted with the full list; ref
  // points at the row matching `value ?? activeFontId`, and the effect
  // below scrolls it into the visible band the first time the popover
  // opens.  Without this, users whose current font sits mid-list have
  // to hunt for it every time.
  const currentItemRef = useRef<HTMLButtonElement | null>(null)
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

  // REQ-0169 §1 — scroll the currently active row into the visible band
  // once the popover finishes mounting.  `requestAnimationFrame` waits
  // for Radix to portal the content into the DOM; using `block: 'nearest'`
  // avoids yanking the popover away from the trigger if the current item
  // is already visible.
  useEffect(() => {
    if (!open) return
    const raf = requestAnimationFrame(() => {
      currentItemRef.current?.scrollIntoView({ block: 'nearest', behavior: 'auto' })
    })
    return () => cancelAnimationFrame(raf)
  }, [open])

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
            {/* REQ-0169 §2 — the `<span>{t('rowFont.defaultPrefix')}</span>`
                ("デフォルト:" prefix) previously shown here was removed.
                It duplicated the meaning of the pre-existing tooltip
                (`rowFont.tooltipDefault`) that already differentiates
                "inherit" vs "override" behaviour, cluttered the tight
                inspector cell, and — per owner — implied a distinction
                users don't need since the font shown IS the one that
                will render.  The tooltip differentiation stays for
                accessibility; only the visible chip is trimmed. */}
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
        // REQ-0169 §1 — cap the popover's height to whatever Radix
        // measured as available above/below the trigger and let the
        // list scroll internally.  Without this cap the popover
        // expanded to its full content height (~13 fonts × 34 px +
        // dividers ≈ 470 px) and, when the trigger sat near the
        // top of the viewport, spilled off the top edge past the
        // title bar with no way to reach the hidden rows.  Radix
        // exposes `--radix-popover-content-available-height` on
        // Content once positioned; scoping `overflow-y-auto` here
        // gives the entire body one scroll container.
        // `collisionPadding` reserves an 8-px breathing gap from the
        // viewport edges so the shadow doesn't cliff into the frame.
        collisionPadding={8}
        className="w-[260px] p-1 max-h-[var(--radix-popover-content-available-height)] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-col">
          {/* REQ-0170 — the "Use default (Noto Sans JP SemiBold)" reset
              button that used to live here was removed.  Rationale: the
              list row's `onClick` (below) already funnels the ACTIVE
              default row through `pick(undefined)` — i.e. clicking the
              current default font in the list produces the exact same
              `entry.fontId = undefined` inherit state the reset button
              produced.  The RES-0170 §A/B trace confirmed the two
              coalesce, so the button was purely redundant UI real
              estate that also broke REQ-0169's "no visible 'デフォルト'
              label" intent.  Compare with `bulk-edit-bar.tsx`'s
              BulkFontPicker: THAT picker's list `onClick` uses
              `pick(m.id)` (no `undefined` coalesce), so its "Use
              project default" button is semantically distinct
              (inherit vs pin-to-Noto) and stays.  Reset path for
              row-font-selector users is now "click Noto in the list"
              — the scroll-into-view + `isCurrent` green dot from
              REQ-0169 makes that easy to locate. */}
          {selectable.map((m) => {
            const isCurrent = m.id === (value ?? activeFontId)
            return (
              <button
                key={m.id}
                type="button"
                // REQ-0169 §1 — the currently-active row receives a ref
                // so `useEffect` above can scroll it into view when the
                // popover opens.  Every other row leaves the ref
                // untouched; only one button holds it at a time.
                ref={isCurrent ? currentItemRef : undefined}
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
