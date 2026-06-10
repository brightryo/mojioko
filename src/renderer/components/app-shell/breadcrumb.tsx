import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Check, ChevronRight, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { APP_NAME } from '../../../shared/app-info'
import { useSettingsStore } from '@/stores/settings-store'

export type StepNumber = 1 | 2 | 3

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
  { step: 2, labelKey: 'nav.step2', route: '/step2' },
  { step: 3, labelKey: 'nav.step3', route: '/step3' }
]

export function Breadcrumb({ currentStep, appVersion }: BreadcrumbProps) {
  const { t } = useTranslation('common')
  const navigate = useNavigate()

  return (
    <nav
      className="flex h-11 flex-shrink-0 border-b border-zinc-800"
      aria-label="Steps"
    >
      <div className="max-w-[1100px] mx-auto w-full flex items-center px-6">
        {/* App branding — name + version only.  The CSS-rendered "M" badge
            that used to sit here was removed in v1.0.0; the Windows window
            icon (build/icon.ico) is the canonical brand mark. */}
        <div className="flex items-center gap-2 mr-5 flex-shrink-0">
          <span className="text-body-sm font-semibold text-zinc-300 select-none">{APP_NAME}</span>
          {/* REQ-067 phase B: was text-zinc-600 (disabled tier, ~2.5:1
              contrast — spec violation for permanently-visible chrome).
              Lifted to text-zinc-400 (secondary tier ~7.8:1, AAA pass) —
              the version is meta info, not a disabled element. */}
          <span className="text-caption text-zinc-400 select-none tabular-nums">{appVersion}</span>
        </div>

        <div className="h-4 w-px bg-zinc-800 mr-5 flex-shrink-0" aria-hidden="true" />

        {/* Step indicators */}
        <div className="flex items-center gap-1">
          {STEPS.map((config, idx) => {
            const isCompleted = config.step < currentStep
            const isCurrent = config.step === currentStep
            const isFuture = config.step > currentStep

            return (
              <div key={config.step} className="flex items-center gap-1">
                {idx > 0 && (
                  <ChevronRight className="h-3.5 w-3.5 text-zinc-700" aria-hidden="true" />
                )}
                <button
                  onClick={() => isCompleted && navigate(config.route)}
                  disabled={!isCompleted}
                  aria-current={isCurrent ? 'step' : undefined}
                  className={cn(
                    'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-body transition-colors duration-150',
                    isCurrent && 'bg-green-500/10 font-medium text-green-500',
                    isCompleted && 'cursor-pointer text-zinc-500 hover:text-zinc-300',
                    isFuture && 'cursor-not-allowed text-zinc-600'
                  )}
                >
                  {isCompleted && (
                    <Check className="h-3 w-3 text-green-500" aria-hidden="true" />
                  )}
                  {isCurrent && (
                    <span className="h-1.5 w-1.5 rounded-full bg-green-500" aria-hidden="true" />
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
        className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-body-sm text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/60 transition-colors duration-150"
      >
        {current.label}
        <ChevronDown className="h-3 w-3 opacity-60" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1 w-28 rounded-lg border border-zinc-800 bg-zinc-900 shadow-xl z-50 py-1 overflow-hidden">
            {options.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => select(opt.value)}
                className={cn(
                  'w-full px-3 py-2 text-left text-body-sm transition-colors duration-150',
                  language === opt.value
                    ? 'text-green-400 bg-green-500/10'
                    : 'text-zinc-300 hover:bg-zinc-800'
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
