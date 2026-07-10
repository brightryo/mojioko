import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useSettingsStore } from '@/stores/settings-store'

// REQ-0185 §3 — the pre-0185 top strip carried the
// APP_NAME + version + step breadcrumb ("文字起こし > 編集").
// Owner rationale for removal: the 3-step model was retired
// (Transcribe → Edit are the only two now), so the breadcrumb's
// step affordance was cosmetic; the version display added chrome
// noise.  This file now renders a single-line "screen title +
// description + language pill" strip, so the H1 + description that
// used to duplicate at the top of each route's content can be
// dropped from step1 / step2.
//
// The filename is kept as `breadcrumb.tsx` and the export is still
// `Breadcrumb` to avoid touching every import site — semantically
// this component is now a top-of-screen header, not a step
// breadcrumb.  A rename can happen in a later cleanup pass.
//
// Navigation implication (RES-0185 §3 checked): the pre-0185
// breadcrumb allowed clicking a *completed* step to navigate back
// (edit → transcribe).  That path is preserved by step2's footer
// "戻る" button, which now also has a REQ-0185 §4 confirm dialog
// in front of it — so no user-reachable navigation is lost.

interface BreadcrumbProps {
  /** Screen H1 — displayed left of the description on the top strip. */
  title: string
  /** Short screen description — right of the title, muted tone. */
  description?: string
}

export function Breadcrumb({ title, description }: BreadcrumbProps) {
  return (
    <nav
      className="flex h-11 flex-shrink-0 border-b border-line"
      aria-label="Screen header"
    >
      {/*
        REQ-0190 — dropped `max-w-[1100px] mx-auto` so the top strip
        spans the full viewport at every window size.  Pre-0190 the
        centred container left visible left/right gutters at
        maximised window while REQ-0189 had already pushed the
        editor 3-pane edge-to-edge, so title + LanguagePill floated
        toward the middle on wide viewports and read as disconnected
        from the content strip below.
        Horizontal padding also dropped from `px-6` to `px-4` so
        the header's inset is small enough to feel "chrome flush
        to the viewport" without letting the H1 collide with the
        pixel edge.  The existing flex layout (h1 auto width,
        description takes flex-1 fill, LanguagePill on the right)
        was already effectively a space-between; removing the
        centering wrapper is enough to make the pinning obvious.
      */}
      <div className="w-full flex items-baseline gap-3 px-4">
        <h1 className="text-body-sm font-semibold text-fg-primary select-none">{title}</h1>
        {description ? (
          <p
            // REQ-0186 §2 — bumped one step from `text-caption` (12 px)
            // to `text-body-sm` (13 px) so the top-strip description
            // sits closer to the H1 in weight while still reading as
            // supporting copy.  Applied to both routes' descriptions
            // uniformly (step1 uses `t('guidance')`, step2 uses
            // `t('subtitle')` — both flow through this component).
            className="text-body-sm text-fg-tertiary select-none truncate min-w-0 flex-1"
          >
            {description}
          </p>
        ) : (
          <div className="flex-1" />
        )}
        <LanguagePill />
      </div>
    </nav>
  )
}

// Kept for import-site compatibility even though the concept is
// gone; callers pass a fixed `title` string now.
export type StepNumber = 1 | 2

function LanguagePill() {
  const { i18n } = useTranslation('common')
  const language = useSettingsStore((s) => s.language)
  const setLanguage = useSettingsStore((s) => s.setLanguage)
  const [open, setOpen] = useState(false)

  const options = [
    { value: 'ja', label: '日本語' },
    { value: 'en', label: 'English' }
  ]

  const current = options.find((o) => o.value === language) ?? options[0]

  function select(lang: string) {
    setLanguage(lang)
    void i18n.changeLanguage(lang)
    setOpen(false)
  }

  return (
    <div className="relative flex-shrink-0">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-body-sm text-fg-tertiary hover:text-fg-secondary hover:bg-surface-2/60 transition-colors duration-150"
      >
        {current.label}
        <ChevronDown className="h-3 w-3 opacity-60" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1 w-28 rounded-lg border border-line bg-surface-1 shadow-xl z-50 py-1 overflow-hidden">
            {options.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => select(opt.value)}
                className={cn(
                  'w-full px-3 py-2 text-left text-body-sm transition-colors duration-150',
                  language === opt.value
                    ? 'text-primary-soft bg-primary/10'
                    : 'text-fg-secondary hover:bg-surface-2'
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
