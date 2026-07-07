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
import { FadeDurationSlider } from '@/components/subtitle-table/fade-duration-slider'
import { FolderPathInput } from './folder-path-input'
import { ShortcutsSettingsTab } from './shortcuts-settings-tab'

// REQ-20260615-050 — fade range constants now live in shared/constants
// (`FADE_DURATION_SEC_{MIN,MAX,STEP}`), driven by the FadeDurationSlider.
// The slider itself replaces the legacy number-input in the General tab
// and is also reused by the inspector and the bulk-edit bar.

export function SettingsDialog() {
  const { t, i18n } = useTranslation('settings')
  const isOpen = useUiStore((s) => s.isSettingsDialogOpen)
  const setOpen = useUiStore((s) => s.setSettingsDialogOpen)

  // General
  const language = useSettingsStore((s) => s.language)
  const setLanguage = useSettingsStore((s) => s.setLanguage)
  const theme = useSettingsStore((s) => s.theme)
  const setTheme = useSettingsStore((s) => s.setTheme)
  const baseColor = useSettingsStore((s) => s.baseColor)
  const setBaseColor = useSettingsStore((s) => s.setBaseColor)
  const fadeDurationSec = useSettingsStore((s) => s.fadeDurationSec)
  const setFadeDurationSec = useSettingsStore((s) => s.setFadeDurationSec)
  // REQ-0121 — audio track selector + input/output folder inputs.
  const defaultAudioTrackIndex = useSettingsStore((s) => s.defaultAudioTrackIndex)
  const setDefaultAudioTrackIndex = useSettingsStore((s) => s.setDefaultAudioTrackIndex)
  const defaultInputDir = useSettingsStore((s) => s.defaultInputDir)
  const setDefaultInputDir = useSettingsStore((s) => s.setDefaultInputDir)
  const defaultOutputDir = useSettingsStore((s) => s.defaultOutputDir)
  const setDefaultOutputDir = useSettingsStore((s) => s.setDefaultOutputDir)

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

  // REQ-20260615-050 — the General-tab fade input was replaced with the
  // shared FadeDurationSlider.  No local draft / clamp logic is needed
  // any more; the slider owns its draft and only invokes onCommit at
  // the gesture boundary.
  function handleLanguageChange(lang: string) {
    setLanguage(lang)
    void i18n.changeLanguage(lang)
  }

  return (
    <Dialog open={isOpen} onOpenChange={setOpen}>
      {/* onOpenAutoFocus prevented: Radix' default focus-on-open sends focus
          into the active tabpanel (tabindex=0), which can cause the
          :focus-visible style to land on the panel as if the user had
          Tab-keyed in.  Preventing the auto-focus keeps the highlighted
          element on whatever opened the dialog; users can still Tab into
          the dialog normally for keyboard navigation.
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
            <TabsTrigger value="shortcuts">{t('tabs.shortcuts')}</TabsTrigger>
          </TabsList>

          {/* ─ General ────────────────────────────────────────────── */}
          <TabsContent value="general" className="min-h-[490px]">
            <div className="grid grid-cols-2 items-start gap-y-4 gap-x-6 pt-1">
              {/* Language */}
              <span className="whitespace-nowrap text-body text-fg-secondary self-center leading-none mt-1">
                {t('general.language')}
              </span>
              <div className="flex items-center">
                <Select value={language} onValueChange={handleLanguageChange}>
                  {/* REQ-20260615-028 A: centre the selected value.  The value
                      lands in the trigger's `[&>span]` slot (line-clamp-1),
                      so giving that span `flex-1 text-center` keeps the
                      ChevronDown right-anchored while the value sits
                      visually centred inside the trigger. */}
                  <SelectTrigger className="h-9 w-full [&>span]:flex-1 [&>span]:text-center">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ja">{t('general.languageJa')}</SelectItem>
                    <SelectItem value="en">{t('general.languageEn')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* REQ-20260615-026: theme switcher. */}
              <span className="whitespace-nowrap text-body text-fg-secondary self-center leading-none mt-1">
                {t('general.theme')}
              </span>
              <div className="flex items-center">
                <Select value={theme} onValueChange={(v) => setTheme(v as 'dark' | 'light')}>
                  {/* REQ-20260615-028 A: centre the selected value.  The value
                      lands in the trigger's `[&>span]` slot (line-clamp-1),
                      so giving that span `flex-1 text-center` keeps the
                      ChevronDown right-anchored while the value sits
                      visually centred inside the trigger. */}
                  <SelectTrigger className="h-9 w-full [&>span]:flex-1 [&>span]:text-center">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="dark">{t('general.themeDark')}</SelectItem>
                    <SelectItem value="light">{t('general.themeLight')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* REQ-20260615-029: base color (neutral palette) switcher. */}
              <span className="whitespace-nowrap text-body text-fg-secondary self-center leading-none mt-1">
                {t('general.baseColor')}
              </span>
              <div className="flex items-center">
                <Select
                  value={baseColor}
                  onValueChange={(v) => setBaseColor(v as 'neutral' | 'stone' | 'mauve' | 'olive' | 'mist' | 'taupe')}
                >
                  <SelectTrigger className="h-9 w-full [&>span]:flex-1 [&>span]:text-center">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="neutral">{t('general.baseColorNeutral')}</SelectItem>
                    <SelectItem value="stone">{t('general.baseColorStone')}</SelectItem>
                    <SelectItem value="mauve">{t('general.baseColorMauve')}</SelectItem>
                    <SelectItem value="olive">{t('general.baseColorOlive')}</SelectItem>
                    <SelectItem value="mist">{t('general.baseColorMist')}</SelectItem>
                    <SelectItem value="taupe">{t('general.baseColorTaupe')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* REQ-20260615-050 — fade duration slider.  Replaces the
                  legacy number input.  0 = OFF, 0.1–0.5 s otherwise.
                  This setting is the default for new entries; existing
                  entries keep whatever per-row value they already hold. */}
              <span className="whitespace-nowrap text-body text-fg-secondary self-start leading-none mt-2.5">
                {t('general.fadeDuration')}
              </span>
              <div className="space-y-1 flex flex-col">
                <FadeDurationSlider
                  value={fadeDurationSec}
                  onCommit={setFadeDurationSec}
                  ariaLabel={t('general.fadeDuration')}
                  fullWidth
                />
                <p className="text-body-sm text-fg-muted">{t('general.fadeDurationHint')}</p>
              </div>

              {/* REQ-0121 — default transcription audio track (1..6).  Fixed
                  1..6 dropdown regardless of the current video's track count
                  (OBS supports up to 6).  Runtime fallback lives in
                  step1-track-pick.ts (preferred → Track 1 → none). */}
              <span className="whitespace-nowrap text-body text-fg-secondary self-center leading-none mt-1">
                {t('general.defaultAudioTrack')}
              </span>
              <div className="flex items-center">
                <Select
                  value={String(defaultAudioTrackIndex)}
                  onValueChange={(v) => setDefaultAudioTrackIndex(Number(v))}
                >
                  <SelectTrigger className="h-9 w-full [&>span]:flex-1 [&>span]:text-center">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[1, 2, 3, 4, 5, 6].map((n) => (
                      <SelectItem key={n} value={String(n)}>
                        {t('general.defaultAudioTrackOption', { index: n })}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* REQ-0121 — user-preferred fixed default input folder for
                  the "Choose input video" dialog.  The active session's
                  MRU (last-opened video's directory) still wins; this
                  setting is the fallback when no MRU exists yet. */}
              <span className="whitespace-nowrap text-body text-fg-secondary self-center leading-none mt-1">
                {t('general.defaultInputDir')}
              </span>
              <FolderPathInput
                value={defaultInputDir}
                onChange={setDefaultInputDir}
                placeholder={t('general.folderPathUsingSystemVideos')}
                ariaLabel={t('general.defaultInputDir')}
              />

              {/* REQ-0121 — user-preferred fixed default output folder for
                  ALL save dialogs (burn-in video, transcription text, SRT
                  subtitles, exported frame). */}
              <span className="whitespace-nowrap text-body text-fg-secondary self-center leading-none mt-1">
                {t('general.defaultOutputDir')}
              </span>
              <FolderPathInput
                value={defaultOutputDir}
                onChange={setDefaultOutputDir}
                placeholder={t('general.folderPathUsingSystemVideos')}
                ariaLabel={t('general.defaultOutputDir')}
              />
            </div>
          </TabsContent>

          {/* ─ Fonts ──────────────────────────────────────────────── */}
          {/* REQ-020: unified with the Subtitle Style dialog — row click
              selects the default font, the dot indicator shows the active
              choice, and DL / Trash icons handle inventory in the same
              list.  No separate dropdown / management-only split. */}
          <TabsContent value="fonts" className="space-y-1.5 min-h-[490px]">
            <p className="text-body-sm text-muted-foreground">{t('fonts.hint')}</p>
            <FontPicker />
          </TabsContent>

          {/* ─ Default style ──────────────────────────────────────── */}
          <TabsContent value="defaultStyle" className="space-y-2 min-h-[490px]">
            <p className="text-body-sm text-muted-foreground">{t('defaultStyle.hint')}</p>
            <DefaultStyleControls
              fontSizePx={transcriptionDefaults.fontSizePx}
              textColorHex={transcriptionDefaults.textColorHex}
              outlineColorHex={transcriptionDefaults.outlineColorHex}
              outlineThicknessPx={transcriptionDefaults.outlineThicknessPx}
              autoLineBreak={autoLineBreak}
              onUpdateDefaults={updateTranscriptionDefaults}
              onSetAutoLineBreak={setAutoLineBreak}
            />
          </TabsContent>

          {/* ─ Whisper engine ─────────────────────────────────────── */}
          <TabsContent value="whisper" className="space-y-3 min-h-[490px]">
            <p className="text-body-sm text-muted-foreground">{t('whisper.hint')}</p>
            <WhisperAdvancedControls
              transcriptionAdvanced={transcriptionAdvanced}
              onUpdate={setTranscriptionAdvanced}
              onReset={resetTranscriptionAdvanced}
            />
          </TabsContent>

          {/* ─ Shortcuts ──────────────────────────────────────────── */}
          {/* REQ-0131 §5 — read-only list rendered from the shared
              `SHORTCUTS` registry.  No mutation UI; the tab exists so
              the user can discover which keys do what without leaving
              the app. */}
          <TabsContent value="shortcuts" className="space-y-3 min-h-[490px]">
            <ShortcutsSettingsTab />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
