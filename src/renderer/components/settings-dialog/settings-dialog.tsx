import { Fragment } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { useUiStore, type SettingsDialogTab } from '@/stores/ui-store'
import {
  FOLDER_PURPOSE_ORDER,
  FOLDER_SETTINGS,
  type FolderSettingKey,
} from '../../../shared/folder-settings'
import { useSettingsStore } from '@/stores/settings-store'
import { useTranslationToolStore } from '@/stores/translation-tool-store'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { FontPicker } from '@/components/font-picker/font-picker'
import { TRANSLATION_TARGET_LANGS } from '../../../shared/translation'
// REQ-0426 — the 「字幕スタイル」 and 「Whisper設定」 tabs were removed from this
// dialog: both are now edited exclusively in STEP 1's setup drawer (タブ2 文字
// スタイル / タブ3 Whisper設定), so a second copy here was duplicate surface.
// DefaultStyleControls / WhisperAdvancedControls imports went with them.
import { FolderPathInput } from './folder-path-input'
import { ShortcutsSettingsTab } from './shortcuts-settings-tab'
import { AiIntegrationTab } from './ai-integration-tab'

// REQ-20260615-050 — fade range constants now live in shared/constants
// (`FADE_DURATION_SEC_{MIN,MAX,STEP}`), driven by the FadeDurationSlider.
// The slider itself replaces the legacy number-input in the General tab
// and is also reused by the inspector and the bulk-edit bar.

export function SettingsDialog() {
  const { t, i18n } = useTranslation('settings')
  const isOpen = useUiStore((s) => s.isSettingsDialogOpen)
  const setOpen = useUiStore((s) => s.setSettingsDialogOpen)
  // REQ-0510 §2-4 — the active tab lives in the store so other surfaces can
  // point at one (see `openSettingsDialogAt`).
  const settingsTab = useUiStore((s) => s.settingsDialogTab)
  const setSettingsTab = useUiStore((s) => s.setSettingsDialogTab)

  // General
  const language = useSettingsStore((s) => s.language)
  const setLanguage = useSettingsStore((s) => s.setLanguage)
  const theme = useSettingsStore((s) => s.theme)
  const setTheme = useSettingsStore((s) => s.setTheme)
  const baseColor = useSettingsStore((s) => s.baseColor)
  const setBaseColor = useSettingsStore((s) => s.setBaseColor)
  // REQ-0426 — 「翻訳」 tab: auto-translate toggle + target language.  Both
  // freely editable regardless of whether a translation tool is installed.
  const translationAutoEnabled = useSettingsStore((s) => s.translationAutoEnabled)
  const setTranslationAutoEnabled = useSettingsStore((s) => s.setTranslationAutoEnabled)
  const translationTargetLang = useSettingsStore((s) => s.translationTargetLang)
  const setTranslationTargetLang = useSettingsStore((s) => s.setTranslationTargetLang)
  // REQ-0426 §4 — the translation controls are active only when ≥1 tool is
  // DOWNLOADED; greyed (disabled) at 0 with a pointer to STEP 1's download flow.
  const hasDownloadedTool = useTranslationToolStore(
    (s) => s.state?.tools.some((tool) => tool.status === 'downloaded') ?? false,
  )
  // REQ-0121 — audio track selector + input/output folder inputs.
  const defaultAudioTrackIndex = useSettingsStore((s) => s.defaultAudioTrackIndex)
  const setDefaultAudioTrackIndex = useSettingsStore((s) => s.setDefaultAudioTrackIndex)
  // REQ-0518 — one value map + one setter, keyed by the persisted settings
  // key, so the six rows below need no per-row wiring.  Selecting the whole
  // slice individually (rather than an object literal) keeps zustand's
  // reference equality intact per field.
  const defaultInputDir = useSettingsStore((s) => s.defaultInputDir)
  const defaultOutputDir = useSettingsStore((s) => s.defaultOutputDir)
  const defaultProjectDir = useSettingsStore((s) => s.defaultProjectDir)
  const defaultImageDir = useSettingsStore((s) => s.defaultImageDir)
  const defaultTextDir = useSettingsStore((s) => s.defaultTextDir)
  const defaultSrtDir = useSettingsStore((s) => s.defaultSrtDir)
  const setDefaultInputDir = useSettingsStore((s) => s.setDefaultInputDir)
  const setDefaultOutputDir = useSettingsStore((s) => s.setDefaultOutputDir)
  const setDefaultProjectDir = useSettingsStore((s) => s.setDefaultProjectDir)
  const setDefaultImageDir = useSettingsStore((s) => s.setDefaultImageDir)
  const setDefaultTextDir = useSettingsStore((s) => s.setDefaultTextDir)
  const setDefaultSrtDir = useSettingsStore((s) => s.setDefaultSrtDir)
  const folderValues: Record<FolderSettingKey, string | null> = {
    defaultInputDir, defaultOutputDir, defaultProjectDir,
    defaultImageDir, defaultTextDir, defaultSrtDir,
  }
  const folderSetters: Record<FolderSettingKey, (p: string | null) => void> = {
    defaultInputDir: setDefaultInputDir,
    defaultOutputDir: setDefaultOutputDir,
    defaultProjectDir: setDefaultProjectDir,
    defaultImageDir: setDefaultImageDir,
    defaultTextDir: setDefaultTextDir,
    defaultSrtDir: setDefaultSrtDir,
  }
  const setFolderValue = (key: FolderSettingKey, next: string | null): void => folderSetters[key](next)

  // REQ-0426 — the 字幕スタイル / Whisper設定 store subscriptions were removed
  // with their tabs; those settings are edited in STEP 1's setup drawer now.

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
      {/* REQ-0283 / REQ-0284 — the DialogContent frame is FIXED at 720px
          (capped at 85vh on tiny viewports so it never overflows the
          screen).  Content that exceeds the panel area scrolls INSIDE
          the wrapper `<div className="flex-1 min-h-0 overflow-y-auto">`
          below, so the frame height never depends on the active tab.

          The height was raised from 640 → 720 by REQ-0284 so the Fonts
          tab fits with only its internal family-list scroll
          (`max-h-[300px]` on the family list box).  At 640px the outer
          wrapper ALSO scrolled on Fonts, producing an unpleasant
          double-scroll.  720 clears the tallest current content
          (Fonts with the upgrade-notice banner visible) with ~30 px of
          slack.  See RES-0284 §1 for the measurement breakdown.

          ------------------------------------------------------------
          DO NOT (would reintroduce the REQ-018 → REQ-0164 → REQ-0283
          content-drift bug that has been fixed 3 times already):
            – Add `overflow-y-auto` to DialogContent (that lets the
              OUTER frame scroll = content-driven height).
            – Add `min-h-[...]` or `max-h-[...]` to any individual
              `<TabsContent>` (per-tab height pinning is what caused
              the whack-a-mole — each new tab had to remember, and
              tall content bypassed the min-h anyway).
            – Replace `h-[720px]` with `min-h-[Xpx]` (min alone reverts
              to content-driven above the floor).
          ------------------------------------------------------------
          The `tests/unit/settings-dialog-height-invariant.test.ts`
          suite enforces these rules at CI time — greping the TSX
          source for the anti-patterns above.  If you have a legit
          reason to change the fixed height, bump the pixel value here
          AND update the test's expected value in the SAME commit; if
          you're tempted to add per-tab min-h/max-h, the frame is
          broken elsewhere — fix that instead.

          Height composition (approx, worst-case Fonts tab with the
          RES-0276 upgrade notice visible):
            DialogHeader                    ~30px
            + TabsList                      ~40px
            + TabsContent primitive mt-3    ~12px
            + Panel content (Fonts tab)     ~574px
              = Section 1 (~112) + gap-6 (24) + Section 2 (~438,
                including the family-list max-h-[300])
            + p-4 padding (top + bottom)    ~32px
            = ~688px → 720 with ~32px slack. */}
      <DialogContent
        className="max-w-[640px] h-[720px] max-h-[85vh] flex flex-col overflow-hidden"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <DialogHeader className="shrink-0">
          <DialogTitle>{t('title')}</DialogTitle>
        </DialogHeader>

        {/* REQ-0510 §2-4 — controlled, so a toast can open this dialog ON a
            specific tab. `setSettingsDialogOpen(true)` resets the tab to
            'general', which is what the previous uncontrolled
            `defaultValue="general"` did every time the content remounted. */}
        <Tabs value={settingsTab} onValueChange={(v) => setSettingsTab(v as SettingsDialogTab)} className="flex-1 min-h-0 flex flex-col w-full">
          <TabsList className="shrink-0">
            <TabsTrigger value="general">{t('tabs.general')}</TabsTrigger>
            <TabsTrigger value="fonts">{t('tabs.fonts')}</TabsTrigger>
            {/* REQ-0426 — 「翻訳」 replaces the removed 字幕スタイル / Whisper設定 tabs. */}
            <TabsTrigger value="translation">{t('tabs.translation')}</TabsTrigger>
            <TabsTrigger value="shortcuts">{t('tabs.shortcuts')}</TabsTrigger>
            {/* REQ-0447 / REQ-0450 — AI連携（MCP）tab, right of ショートカット. */}
            <TabsTrigger value="ai">{t('tabs.ai')}</TabsTrigger>
          </TabsList>

          {/* REQ-0283 — SINGLE scroll region wrapping every TabsContent.
              Any tab content that exceeds the panel area scrolls here.
              Do not move `overflow-y-auto` INTO individual TabsContent —
              it must live on this wrapper so the frame stays fixed no
              matter which tab is active OR which tabs are added later. */}
          <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">

          {/* ─ General ────────────────────────────────────────────── */}
          <TabsContent value="general">
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

              {/* REQ-0298 §3 — the fade-duration slider was removed from
                  this tab.  REQ-0295 added the same slider to the
                  「字幕スタイル」 tab (both surfaces write the SAME
                  `settings.fadeDurationSec` store slot, so the value
                  and behaviour are unchanged); exposing it in two
                  tabs was confusing.  The store slot, its setter,
                  and every downstream consumer (per-entry seed at
                  transcription, style-defaults preview, etc.) stay
                  as-is — this is a pure UI-visibility change. */}

              {/* REQ-0121 — default transcription audio track (1..6).  Fixed
                  1..6 dropdown regardless of the current video's track count
                  (OBS supports up to 6).  Runtime fallback lives in
                  shared/track-pick.ts (preferred → Track 1 → none). */}
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

              {/* ★ REQ-0518 — the six folder rows are RENDERED FROM
                  `FOLDER_SETTINGS`, not written out one by one.
                  Each row's three facts — the persisted key, the OS folder it
                  falls back to, and its label — have to agree, and the
                  fallback is also needed in `main/ipc/dialog.ts`.  Spelling
                  them out here would put the mapping in two files.

                  REQ-0121 / REQ-0194 behaviour is unchanged per row: the
                  session MRU still wins for the input folder, the value is
                  validated lazily at dialog-open, and a folder that has
                  vanished falls back silently (no toast).

                  The persisted KEYS are untouched; only the labels changed
                  (REQ-0518 §1-1) — renaming a key would discard the folder an
                  existing user had already chosen. */}
              {FOLDER_PURPOSE_ORDER.map((purpose) => {
                const row = FOLDER_SETTINGS[purpose]
                const label = t(`general.folders.${row.i18n}`)
                return (
                  <Fragment key={purpose}>
                    <span className="whitespace-nowrap text-body text-fg-secondary self-center leading-none mt-1">
                      {label}
                    </span>
                    <FolderPathInput
                      value={folderValues[row.key]}
                      onChange={(next) => setFolderValue(row.key, next)}
                      // The placeholder names the row's OWN fallback, so it
                      // stops promising Videos for a folder that now opens in
                      // Documents or Pictures.
                      placeholder={t(`general.folderPlaceholder.${row.osFolder}`)}
                      ariaLabel={label}
                      fallbackOsFolder={row.osFolder}
                    />
                  </Fragment>
                )
              })}
            </div>
          </TabsContent>

          {/* ─ Fonts ──────────────────────────────────────────────── */}
          {/* REQ-020: unified with the Subtitle Style dialog — row click
              selects the default font, the dot indicator shows the active
              choice, and DL / Trash icons handle inventory in the same
              list.  No separate dropdown / management-only split.
              REQ-0164 §2 — the description paragraph that used to sit
              here (`{t('fonts.hint')}`) moved INTO `<FontPicker>` so
              the "heading → description → legend → list → warning"
              flow is owned by the component itself.  This drops
              `settings:fonts.hint` from the render path here; the
              locale key stayed as-is (unused, kept for safety in case
              a hot-fix consumer surfaces later). */}
          <TabsContent value="fonts" className="space-y-1.5">
            <FontPicker />
          </TabsContent>

          {/* ─ Translation (REQ-0426) ─────────────────────────────── */}
          {/* Auto-translate toggle + target language.  Editable even with no
              translation tool installed — the download / enable flow lives in
              STEP 1's 翻訳ツール accordion, and the inspector greys its preview
              until a tool is enabled. */}
          <TabsContent value="translation" className="space-y-3">
            <p className="text-body-sm text-fg-secondary">{t('translation.hint')}</p>
            {/* REQ-0426 §4 — 0 downloaded tools ⇒ a note + greyed controls. */}
            {!hasDownloadedTool && (
              <p className="text-body-sm text-warning">{t('translation.needTool')}</p>
            )}
            <div className={cn('grid grid-cols-2 items-start gap-y-4 gap-x-6 pt-1', !hasDownloadedTool && 'opacity-50')}>
              <span className="whitespace-nowrap text-body text-fg-secondary self-center leading-none mt-1">
                {t('translation.autoTranslate')}
              </span>
              <div className="flex items-center h-9">
                <Switch
                  checked={translationAutoEnabled}
                  onCheckedChange={setTranslationAutoEnabled}
                  disabled={!hasDownloadedTool}
                  aria-label={t('translation.autoTranslate')}
                />
              </div>

              <span className="whitespace-nowrap text-body text-fg-secondary self-center leading-none mt-1">
                {t('translation.targetLang')}
              </span>
              <div className="flex items-center">
                <Select
                  value={translationTargetLang}
                  onValueChange={setTranslationTargetLang}
                  disabled={!hasDownloadedTool}
                >
                  <SelectTrigger className="h-9 w-full [&>span]:flex-1 [&>span]:text-center">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TRANSLATION_TARGET_LANGS.map((code) => (
                      <SelectItem key={code} value={code}>
                        {t(`translation.lang_${code}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </TabsContent>

          {/* ─ Shortcuts ──────────────────────────────────────────── */}
          {/* REQ-0131 §5 — read-only list rendered from the shared
              `SHORTCUTS` registry.  No mutation UI; the tab exists so
              the user can discover which keys do what without leaving
              the app.
              REQ-0283 — the pre-fix `min-h-[490px] max-h-[490px]
              overflow-y-auto` special-case that used to live here (a
              REQ-0164 §1 whack-a-mole patch) has been removed.  Height
              is now managed by the shared wrapper `<div>` above; this
              tab, like every other, just describes its content. */}
          <TabsContent value="shortcuts" className="space-y-3">
            <ShortcutsSettingsTab />
          </TabsContent>

          {/* ─ AI連携 / MCP (REQ-0450 §5) ─────────────────────────── */}
          <TabsContent value="ai" className="space-y-3">
            <AiIntegrationTab />
          </TabsContent>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
