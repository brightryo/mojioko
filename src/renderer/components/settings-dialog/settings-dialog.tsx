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
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { FontPicker } from '@/components/font-picker/font-picker'
import { DefaultStyleControls } from '@/components/default-style-controls/default-style-controls'
import { WhisperAdvancedControls } from '@/components/whisper-advanced-controls/whisper-advanced-controls'

/** Allowed fade duration range. */
const FADE_DURATION_MIN = 0.1
const FADE_DURATION_MAX = 0.5
const FADE_DURATION_STEP = 0.1

export function SettingsDialog() {
  const { t, i18n } = useTranslation('settings')
  const isOpen = useUiStore((s) => s.isSettingsDialogOpen)
  const setOpen = useUiStore((s) => s.setSettingsDialogOpen)

  // General
  const language = useSettingsStore((s) => s.language)
  const setLanguage = useSettingsStore((s) => s.setLanguage)
  const fadeDurationSec = useSettingsStore((s) => s.fadeDurationSec)
  const setFadeDurationSec = useSettingsStore((s) => s.setFadeDurationSec)

  // Default style — single source of truth lives on settingsStore.
  // SubtitleStyleDialog reads & writes the same slice via REQ-016 wiring.
  const transcriptionDefaults = useSettingsStore((s) => s.transcriptionDefaults)
  const updateTranscriptionDefaults = useSettingsStore((s) => s.updateTranscriptionDefaults)
  const autoLineBreak = useSettingsStore((s) => s.autoLineBreak)
  const setAutoLineBreak = useSettingsStore((s) => s.setAutoLineBreak)

  // Whisper engine — same slice that the STEP 1 「詳細設定」 dialog edits
  // (REQ-019 #1).  Both surfaces stay in sync because both subscribe to
  // settingsStore.transcriptionAdvanced.
  const transcriptionAdvanced = useSettingsStore((s) => s.transcriptionAdvanced)
  const setTranscriptionAdvanced = useSettingsStore((s) => s.setTranscriptionAdvanced)
  const resetTranscriptionAdvanced = useSettingsStore((s) => s.resetTranscriptionAdvanced)

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
      {/* onOpenAutoFocus prevented: Radix' default focus-on-open sends focus
          into the active tabpanel (tabindex=0), and because the dialog is
          typically opened via Ctrl+, / menu (keyboard activation),
          :focus-visible matches → the panel renders with the green focus
          ring as if the user had Tab-keyed in.  Preventing the auto-focus
          keeps the highlighted element on whatever opened the dialog;
          users can still Tab into the dialog normally for keyboard
          navigation.
          REQ-018 #1. */}
      <DialogContent
        className="max-w-[640px] max-h-[85vh] overflow-y-auto"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
        </DialogHeader>

        {/* min-h applied to every TabsContent below pegs the panel height
            to the tallest tab (フォント, measured ~483px) so switching tabs
            does not change the dialog height.  Empty space appears at the
            bottom of shorter tabs (一般 / 既定スタイル); this is the
            explicit trade-off vs. a smaller fixed height + internal scroll,
            chosen because the FontPicker's internal scroll (max-h-[300px])
            already handles the long font list.  REQ-018 #2. */}
        <Tabs defaultValue="general" className="w-full">
          <TabsList>
            <TabsTrigger value="general">{t('tabs.general')}</TabsTrigger>
            <TabsTrigger value="fonts">{t('tabs.fonts')}</TabsTrigger>
            <TabsTrigger value="defaultStyle">{t('tabs.defaultStyle')}</TabsTrigger>
            <TabsTrigger value="whisper">{t('tabs.whisper')}</TabsTrigger>
          </TabsList>

          {/* ─ General ────────────────────────────────────────────── */}
          <TabsContent value="general" className="min-h-[490px]">
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
          </TabsContent>

          {/* ─ Fonts ──────────────────────────────────────────────── */}
          {/* REQ-020: unified with the Subtitle Style dialog — row click
              selects the default font, the dot indicator shows the active
              choice, and DL / Trash icons handle inventory in the same
              list.  No separate dropdown / management-only split. */}
          <TabsContent value="fonts" className="space-y-1.5 min-h-[490px]">
            <p className="text-[11px] text-muted-foreground">{t('fonts.hint')}</p>
            <FontPicker />
          </TabsContent>

          {/* ─ Default style ──────────────────────────────────────── */}
          <TabsContent value="defaultStyle" className="space-y-2 min-h-[490px]">
            <p className="text-[11px] text-muted-foreground">{t('defaultStyle.hint')}</p>
            <DefaultStyleControls
              fontSizePx={transcriptionDefaults.fontSizePx}
              textColorHex={transcriptionDefaults.textColorHex}
              outlineColorHex={transcriptionDefaults.outlineColorHex}
              outlineThicknessPx={transcriptionDefaults.outlineThicknessPx}
              fadeEnabled={transcriptionDefaults.fadeEnabled}
              autoLineBreak={autoLineBreak}
              onUpdateDefaults={updateTranscriptionDefaults}
              onSetAutoLineBreak={setAutoLineBreak}
            />
          </TabsContent>

          {/* ─ Whisper engine ─────────────────────────────────────── */}
          <TabsContent value="whisper" className="space-y-3 min-h-[490px]">
            <p className="text-[11px] text-muted-foreground">{t('whisper.hint')}</p>
            <WhisperAdvancedControls
              transcriptionAdvanced={transcriptionAdvanced}
              onUpdate={setTranscriptionAdvanced}
              onReset={resetTranscriptionAdvanced}
            />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
