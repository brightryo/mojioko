import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useUiStore } from '@/stores/ui-store'
import { useSettingsStore } from '@/stores/settings-store'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

/** Allowed fade duration range. */
const FADE_DURATION_MIN = 0.1
const FADE_DURATION_MAX = 0.5
const FADE_DURATION_STEP = 0.1

export function SettingsDialog() {
  const { t, i18n } = useTranslation('settings')
  const isOpen = useUiStore((s) => s.isSettingsDialogOpen)
  const setOpen = useUiStore((s) => s.setSettingsDialogOpen)
  const language = useSettingsStore((s) => s.language)
  const setLanguage = useSettingsStore((s) => s.setLanguage)
  const fadeDurationSec = useSettingsStore((s) => s.fadeDurationSec)
  const setFadeDurationSec = useSettingsStore((s) => s.setFadeDurationSec)

  /**
   * Keep a draft string so the input can hold transient values while the user
   * is typing (e.g. "0." before "0.3" is complete).  Only clamp and commit on
   * blur or when the arrow-stepper fires a valid value.
   */
  const [fadeDraft, setFadeDraft] = useState(() => String(fadeDurationSec))

  // Sync draft when the store value changes from outside (e.g. settings hydration).
  useEffect(() => {
    setFadeDraft(String(fadeDurationSec))
  }, [fadeDurationSec])

  function clampAndCommit(raw: string) {
    const v = parseFloat(raw)
    if (!isNaN(v)) {
      const clamped = +Math.min(FADE_DURATION_MAX, Math.max(FADE_DURATION_MIN, v)).toFixed(1)
      setFadeDurationSec(clamped)
      setFadeDraft(String(clamped))
    } else {
      // Restore to the last committed value
      setFadeDraft(String(fadeDurationSec))
    }
  }

  function handleFadeDraftChange(e: React.ChangeEvent<HTMLInputElement>) {
    setFadeDraft(e.target.value)
  }

  function handleFadeBlur() {
    clampAndCommit(fadeDraft)
  }

  function handleFadeKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      clampAndCommit(fadeDraft)
      ;(e.target as HTMLInputElement).blur()
    }
  }

  function handleLanguageChange(lang: string) {
    setLanguage(lang)
    void i18n.changeLanguage(lang)
  }

  return (
    <Dialog open={isOpen} onOpenChange={setOpen}>
      <DialogContent className="w-[480px] max-w-[480px]">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-2 items-start gap-y-4 gap-x-6 pt-1">
          {/* Language */}
          <span className="whitespace-nowrap text-[13px] text-zinc-300 self-center leading-none mt-1">
            {t('general.language')}
          </span>
          <div className="flex items-center">
            <Select value={language} onValueChange={handleLanguageChange}>
              <SelectTrigger className="h-9 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ja">{t('general.languageJa')}</SelectItem>
                <SelectItem value="en">{t('general.languageEn')}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Fade duration */}
          <span className="whitespace-nowrap text-[13px] text-zinc-300 self-start leading-none mt-2.5">
            {t('general.fadeDuration')}
          </span>
          <div className="space-y-1">
            <input
              type="number"
              min={FADE_DURATION_MIN}
              max={FADE_DURATION_MAX}
              step={FADE_DURATION_STEP}
              value={fadeDraft}
              onChange={handleFadeDraftChange}
              onBlur={handleFadeBlur}
              onKeyDown={handleFadeKeyDown}
              className="h-9 w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 text-center text-[13px] text-zinc-100 focus:outline-none focus:ring-2 focus:ring-green-500/30 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
            />
            <p className="text-[11px] text-zinc-500">{t('general.fadeDurationHint')}</p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
