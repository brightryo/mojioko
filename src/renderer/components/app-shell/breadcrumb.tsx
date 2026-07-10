import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Check, ChevronRight, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { APP_NAME } from '../../../shared/app-info'
import { useSettingsStore } from '@/stores/settings-store'

// REQ-20260615-023: STEP3 retired in favour of the burn-in drawer on STEP2,
// so the breadcrumb now shows two steps only (Transcribe → Edit).
export type StepNumber = 1 | 2

interface BreadcrumbProps {
  currentStep: StepNumber
  appVersion: string
}

interface StepConfig {
  step: StepNumber
  labelKey: string
  route: string
}

const STEPS: StepConfig[] = [
  { step: 1, labelKey: 'nav.step1', route: '/step1' },
  { step: 2, labelKey: 'nav.step2', route: '/step2' }
]

export function Breadcrumb({ currentStep, appVersion }: BreadcrumbProps) {
  const { t } = useTranslation('common')
  const navigate = useNavigate()

  return (
    <nav
      className="flex h-11 flex-shrink-0 border-b border-line"
      aria-label="Steps"
    >
      <div className="max-w-[1100px] mx-auto w-full flex items-center px-6">
        {/* App branding — name + version only.  The CSS-rendered "M" badge
            that used to sit here was removed in v1.0.0; the Windows window
            icon (build/icon.ico) is the canonical brand mark. */}
        <div className="flex items-center gap-2 mr-5 flex-shrink-0">
          <span className="text-body-sm font-semibold text-fg-secondary select-none">{APP_NAME}</span>
          {/* REQ-067 phase B: was text-fg-disabled (disabled tier, ~2.5:1
              contrast — spec violation for permanently-visible chrome).
              Lifted to text-fg-tertiary (secondary tier ~7.8:1, AAA pass) —
              the version is meta info, not a disabled element. */}
          <span className="text-caption text-fg-tertiary select-none tabular-nums">{appVersion}</span>
        </div>

        <div className="h-4 w-px bg-surface-2 mr-5 flex-shrink-0" aria-hidden="true" />

        {/* Step indicators */}
        <div className="flex items-center gap-1">
          {STEPS.map((config, idx) => {
            const isCompleted = config.step < currentStep
            const isCurrent = config.step === currentStep
            const isFuture = config.step > currentStep

            return (
              <div key={config.step} className="flex items-center gap-1">
                {idx > 0 && (
                  <ChevronRight className="h-3.5 w-3.5 text-fg-faint" aria-hidden="true" />
                )}
                <button
                  onClick={() => isCompleted && navigate(config.route)}
                  disabled={!isCompleted}
                  aria-current={isCurrent ? 'step' : undefined}
                  // REQ-0182 chrome — dropped the `bg-primary/10`
                  // pill on the current step so it reads as "quiet
                  // accent text + small dot" per REQ §5 owner ask.
                  // Green area shrinks to just the dot + text tint,
                  // matching Resolve's static-and-small step
                  // indicators.  The 1.5-px dot + accent text is
                  // still an unambiguous "you're here" signal.
                  className={cn(
                    'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-body-sm transition-colors duration-150',
                    isCurrent && 'font-medium text-primary',
                    isCompleted && 'cursor-pointer text-fg-muted hover:text-fg-secondary',
                    isFuture && 'cursor-not-allowed text-fg-disabled'
                  )}
                >
                  {isCompleted && (
                    <Check className="h-3 w-3 text-primary" aria-hidden="true" />
                  )}
                  {isCurrent && (
                    <span className="h-1.5 w-1.5 rounded-full bg-primary" aria-hidden="true" />
                  )}
                  {t(config.labelKey)}
                </button>
              </div>
            )
          })}
        </div>

        <div className="flex-1" />
        <LanguagePill />
      </div>
    </nav>
  )
}

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
