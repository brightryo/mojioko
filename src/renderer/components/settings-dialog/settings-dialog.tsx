import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
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
import { Label } from '@/components/ui/label'
import { FontPicker } from '@/components/font-picker/font-picker'
import { DefaultStyleControls } from '@/components/default-style-controls/default-style-controls'
import { setActiveFont, listFonts } from '@/services/font'
import { ensureFontLoaded } from '@/lib/font-registry'
import { FONT_REGISTRY, type FontId, type FontsState, getFontMeta } from '../../../shared/fonts'

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

  // Fonts
  const activeFontId = useSettingsStore((s) => s.activeFontId)
  const setActiveFontInStore = useSettingsStore((s) => s.setActiveFontId)

  // Default style — single source of truth lives on settingsStore.
  // SubtitleStyleDialog reads & writes the same slice via REQ-016 wiring.
  const transcriptionDefaults = useSettingsStore((s) => s.transcriptionDefaults)
  const updateTranscriptionDefaults = useSettingsStore((s) => s.updateTranscriptionDefaults)
  const autoLineBreak = useSettingsStore((s) => s.autoLineBreak)
  const setAutoLineBreak = useSettingsStore((s) => s.setAutoLineBreak)

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

  // Default-font selector — installed-only list (bundled + actually
  // downloaded).  Refreshed on dialog open and after FontPicker downloads
  // complete so the dropdown stays in sync with the manage list.
  const [fontsState, setFontsState] = useState<FontsState | null>(null)
  const refreshFonts = useCallback(async () => {
    const r = await listFonts()
    if (r.ok) setFontsState(r.data)
  }, [])
  useEffect(() => {
    if (isOpen) refreshFonts()
  }, [isOpen, refreshFonts])

  const installedFontIds = (fontsState?.fonts ?? FONT_REGISTRY.map((f) => ({
    id: f.id,
    status: f.bundled ? 'bundled' as const : 'not-installed' as const
  })))
    .filter((f) => f.status === 'bundled' || f.status === 'installed')
    .map((f) => f.id as FontId)

  async function handleDefaultFontChange(fontId: string) {
    if (!installedFontIds.includes(fontId as FontId)) return
    await ensureFontLoaded(fontId as FontId).catch(() => {})
    const r = await setActiveFont(fontId as FontId)
    if (r.ok) {
      setActiveFontInStore(fontId as FontId)
      const meta = getFontMeta(fontId as FontId)
      toast.success(meta.displayName)
    }
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
          <TabsContent value="fonts" className="space-y-4 min-h-[490px]">
            {/* Default font dropdown — installed-only.  Increasing the
                inventory is done in the management list below. */}
            <div className="space-y-1.5">
              <Label>{t('fonts.defaultFont')}</Label>
              <Select value={activeFontId} onValueChange={handleDefaultFontChange}>
                <SelectTrigger className="h-9 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FONT_REGISTRY
                    .filter((meta) => installedFontIds.includes(meta.id))
                    .map((meta) => (
                      <SelectItem key={meta.id} value={meta.id}>
                        {meta.displayName}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">{t('fonts.defaultFontHint')}</p>
            </div>

            {/* Font management — manage-only mode hides the Select action
                and active-row highlight; this is purely inventory (DL /
                Cancel / Uninstall / View license). */}
            <div className="space-y-1.5">
              <Label>{t('fonts.manageHeading')}</Label>
              <p className="text-[11px] text-muted-foreground">{t('fonts.manageHint')}</p>
              <FontPicker mode="manage-only" onChange={refreshFonts} />
            </div>
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
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
