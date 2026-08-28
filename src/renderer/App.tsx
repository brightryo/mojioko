import { useEffect, useState } from 'react'
import { SETTINGS_DEBOUNCE_MS } from '../shared/constants'
import { MemoryRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { Toaster } from 'sonner'
import { useTranslation } from 'react-i18next'
import { TooltipProvider } from '@/components/ui/tooltip'
// Splash screen disabled — kept commented out for possible reintroduction.
// import SplashRoute from '@/routes/splash'
import Step1Route from '@/routes/step1'
import Step2Route from '@/routes/step2'
import { AboutDialog } from '@/components/about-dialog/about-dialog'
import { SettingsDialog } from '@/components/settings-dialog/settings-dialog'
import { DonationDialog } from '@/components/donation-dialog/donation-dialog'
import { FontLicensesDialog } from '@/components/font-licenses/font-licenses-dialog'
import { EulaDialog } from '@/components/eula-dialog/eula-dialog'
import { StoreUpsellDialog } from '@/components/store-upsell-dialog/store-upsell-dialog'
import { ProjectOpenController } from '@/components/project-open/project-open-controller'
import { SettingsQuarantineDialog } from '@/components/settings-quarantine-dialog/settings-quarantine-dialog'
import { QuitConfirm } from '@/components/quit-confirm/quit-confirm'
// REQ-0414 — developer live-token editor.  Guarded by import.meta.env.DEV at
// the mount site below so it is tree-shaken out of `electron-vite build`
// (end-user) bundles and never exposed to users.
import { DevTokenEditor } from '@/components/dev-token-editor/dev-token-editor'
import { useUiStore } from '@/stores/ui-store'
import { useSettingsStore } from '@/stores/settings-store'
import { useProjectStore } from '@/stores/project-store'
import { unsavedTracker } from '@/lib/unsaved-changes'
import { useAppEnvStore } from '@/stores/app-env-store'
import { loadSettings, saveSettings } from '@/services/settings'
import { setActiveSubtitleFont, loadSubtitleFontFor } from '@/lib/font-metrics'
import { ensureFontLoaded } from '@/lib/font-registry'
import { refreshInstalledFonts, getInstalledFontIds } from '@/stores/installed-fonts-store'
import { initDownloadActiveStore } from '@/services/download-active'
import { useTranslationToolStore } from '@/stores/translation-tool-store'
import { useTranslationLoadStore } from '@/stores/translation-load-store'
import { useGlobalShortcuts } from '@/hooks/use-global-shortcuts'
import { toast } from 'sonner'
import { saveCurrentProject } from '@/services/project-file'
import i18n from './i18n'
import { createSettingsSaveReporter } from '@/lib/settings-save-failure'
import type { AppSettings } from '../shared/types'
import type { SettingsQuarantineNotice } from '../main/ipc/settings-shape'

const PAGE_VARIANTS = {
  initial: { opacity: 0, x: 8 },
  animate: { opacity: 1, x: 0 },
  exit:    { opacity: 0, x: -8 }
}

const PAGE_TRANSITION = { duration: 0.25, ease: 'easeOut' }


// REQ-082: Ctrl+K command palette + Ctrl+/ shortcuts dialog removed.
// All global keyboard shortcuts have been deleted along with their UI
// affordances (command palette, shortcuts list, registerCommands).
// Space (video/audio play-pause) is the only keyboard binding the app
// still owns; see {video,audio}-preview-panel.tsx.

// REQ-20260614-001 補遺⑤ (A) — global Tab-focus suppression.  Captured
// at the document root in the CAPTURE phase so dialogs / popovers /
// Radix Portals are also covered.  Click-to-focus on input fields keeps
// working (Tab is the only entry point we kill); future callers needing
// Tab behaviour can stop the bubbling at their root before this handler
// fires.
function useSuppressTabFocus(): void {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // `e.key === 'Tab'` covers Shift+Tab as well — the key name is
      // the same regardless of modifier.
      if (e.key === 'Tab') {
        e.preventDefault()
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [])
}

/**
 * REQ-0545 §2 — one reporter for the whole app.
 *
 * The suppression rule lives in `lib/settings-save-failure.ts` where a test can
 * reach it; this only supplies how to notify.  `i18n.t` rather than a captured
 * `t`, because the debounced save is registered once with `[]` deps and a
 * captured `t` would be the one from first render.
 */
const settingsSaveReporter = createSettingsSaveReporter((reason) => {
  toast.error(i18n.t('common:error.settingsSaveFailed', { reason }))
})

function AppInner() {
  useSuppressTabFocus()
  // REQ-0131 §4.1 — single owner of global editor shortcuts (Undo /
  // Redo / Delete / Ctrl+A / Ctrl+Shift+A).  Mounted at the app root
  // so the bindings survive route transitions between Step 1 and
  // Step 2.  Space (play/pause) still lives on the preview panels
  // because they own the `<video>` / `<audio>` ref; both surfaces
  // share `shouldGlobalShortcutFire` so context judgement is uniform.
  useGlobalShortcuts()
  // REQ-0185 §3 — `appVersion` state was consumed only by the
  // pre-0185 top breadcrumb (removed).  About dialog reads
  // APP_VERSION directly from shared/app-info.ts, so the runtime
  // fetch below and the state slot are gone.
  const location = useLocation()
  const { t, i18n } = useTranslation('common')

  // REQ-20260615-026: keep <html> in sync with the user-selected theme so
  // the `:root.light { ... }` overrides in globals.css activate.  Default
  // (no class) leaves the dark values from :root active.
  const theme = useSettingsStore((s) => s.theme)
  useEffect(() => {
    const root = document.documentElement
    root.classList.toggle('light', theme === 'light')
    root.classList.toggle('dark', theme === 'dark')
  }, [theme])

  // REQ-20260615-029: mirror baseColor onto <html data-base="...">.  The
  // `:root[data-base="X"]` blocks in globals.css redirect `--neutral-N`
  // at the chosen palette.  Default ('neutral') leaves the attribute
  // absent so the base :root values apply.
  const baseColor = useSettingsStore((s) => s.baseColor)
  useEffect(() => {
    const root = document.documentElement
    if (baseColor === 'neutral') {
      root.removeAttribute('data-base')
    } else {
      root.setAttribute('data-base', baseColor)
    }
  }, [baseColor])

  // REQ-0185 §3 — removed runtime `getVersion()` fetch; the value
  // was only shown in the pre-0185 breadcrumb (retired).  Static
  // APP_VERSION import at the top covers the About dialog.

  // REQ-0542 — set once, by the settings load below, when main had to move an
  // unusable settings.json aside.  Local state rather than a store: it is one
  // dialog with a lifetime of one launch, and nothing else reads it.
  const [quarantineNotice, setQuarantineNotice] = useState<SettingsQuarantineNotice | null>(null)

  // Load settings from main process on mount; hydrate stores
  useEffect(() => {
    loadSettings().then((result) => {
      if (!result.ok) return
      const s = result.data.settings
      useSettingsStore.getState().hydrate(s)
      if (s.language !== i18n.language) {
        void i18n.changeLanguage(s.language)
      }
      // REQ-0542 — main moved an unusable settings.json aside.  Shown after the
      // language is applied so the dialog is in the user's language, not the
      // default one.
      if (result.data.quarantine) setQuarantineNotice(result.data.quarantine)
    }).catch(() => { /* IPC unavailable in dev outside Electron */ })

    /*
     * REQ-0546 — mark the document dirty on any project-store mutation.
     *
     * A SUBSCRIPTION rather than a flag set inside each action: Zustand
     * notifies on every `set`, so no mutation can slip past, and the tracker
     * never has to stay in sync with the store's ~20 actions. That is what
     * makes "zero false negatives" a property of the wiring instead of a
     * promise someone has to keep.
     */
    const unsubscribeDirty = useProjectStore.subscribe(() => {
      unsavedTracker.noteChange()
    })

    // REQ-0245 — hydrate the download-active mirror + subscribe to
    // change broadcasts.  Fire-and-forget; the store falls back to
    // an empty array if boot IPC fails, and per-DL broadcasts still
    // repopulate it on the next acquire/release.
    void initDownloadActiveStore()

    // REQ-0426 — prime the shared translation-tools cache so the STEP 2
    // inspector can gate auto-translate on the enabled-tool status from launch
    // (the STEP 1 manager also keeps it fresh once mounted).
    void useTranslationToolStore.getState().refresh()
    return unsubscribeDirty
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // REQ-088 #4 — resolve the MSIX/NSIS tier once at app boot.  Downstream
  // components (font picker, per-row font selector, bulk-edit selector)
  // subscribe via `useAppEnvStore` and treat `null` (= not-yet-known) as
  // "don't render tier-gated affordances yet".  The IPC resolves in a
  // few ms so no user-visible UI ever sees the null state in practice.
  useEffect(() => {
    window.electronAPI?.isMsix()
      .then((value) => useAppEnvStore.getState().setIsMsix(value))
      .catch(() => useAppEnvStore.getState().setIsMsix(false))
  }, [])

  // REQ-0426 — preload the MADLAD model when 自動翻訳 is enabled and an active
  // (enabled) translation tool exists, so the first inspector translation is
  // warm.  Turning 自動翻訳 OFF resets the load state (the sidecar stays
  // resident; the next enable re-warms if needed).
  const translationAutoEnabled = useSettingsStore((s) => s.translationAutoEnabled)
  const translationActiveReady = useTranslationToolStore((s) => s.state?.activeId != null)
  useEffect(() => {
    if (translationAutoEnabled && translationActiveReady) {
      void useTranslationLoadStore.getState().preload()
    } else {
      useTranslationLoadStore.getState().reset()
    }
  }, [translationAutoEnabled, translationActiveReady])

  // Mirror activeFontId into font-metrics so the no-arg legacy callers
  // (loadSubtitleFont, getLibassScale, etc.) target the currently selected
  // font without having to thread the FontId through every measurement path.
  useEffect(() => {
    // Apply once with the current store value (covers initial mount + persist
    // hydration before the IPC settingsLoad returns).
    setActiveSubtitleFont(useSettingsStore.getState().activeFontId).catch(() => {})
    return useSettingsStore.subscribe((state, prevState) => {
      if (state.activeFontId !== prevState.activeFontId) {
        setActiveSubtitleFont(state.activeFontId).catch(() => {})
      }
    })
  }, [])

  // Pre-load every installed font on startup (REQ-021).  Once per-row font
  // overrides ship, overflow-calculator / auto-line-break may be asked for
  // measurements against a font that the user did not pick as the active
  // default — without a cache hit those calls silently fall back to the
  // character-class width estimate (over-counts wide glyphs by ~45 %).
  // Best-effort: failures (e.g. a font was uninstalled mid-session) just
  // mean that font's row degrades to the fallback when measured.
  //
  // REQ-0339 §2 — routed through `refreshInstalledFonts` so this startup pass
  // ALSO seeds the shared installed-font set.  Every `useInstalledFontIds`
  // consumer that mounts later then reads a resolved value synchronously
  // instead of starting from an empty set (which made each subtitle overlay
  // paint its first frame in `DEFAULT_FONT_ID`).  One IPC, two jobs.
  useEffect(() => {
    refreshInstalledFonts(useUiStore.getState().fontInventoryVersion).then(() => {
      for (const id of getInstalledFontIds()) {
        loadSubtitleFontFor(id).catch(() => {})
        ensureFontLoaded(id).catch(() => {})
      }
    }).catch(() => {})
  }, [])

  // Keep native Electron menu labels in sync with the current language
  useEffect(() => {
    window.electronAPI?.menuSetLanguage(i18n.language)
    const handleLanguageChanged = (lang: string) => {
      window.electronAPI?.menuSetLanguage(lang)
    }
    i18n.on('languageChanged', handleLanguageChanged)
    return () => { i18n.off('languageChanged', handleLanguageChanged) }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Debounced IPC save whenever settings change.
  //
  // Step 3 UI state (burnin, subtitleBackground, audioMode) is deliberately
  // omitted from the payload — those fields are session-only by design (see
  // `resetStep3Settings` in settings-store).  The main-process side handles
  // their absence by leaving them out of settings.json; the next load applies
  // BURNIN_DEFAULTS via hydrate.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const save = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        const s = useSettingsStore.getState()
        const settings: AppSettings = {
          version: 1,
          language: s.language,
          theme: s.theme,
          baseColor: s.baseColor,
          transcriptionDefaults: s.transcriptionDefaults,
          transcriptionAdvanced: s.transcriptionAdvanced,
          autoLineBreak: s.autoLineBreak,
          // REQ-0426 — renderer-owned (`incoming-wins`), so MUST be sent every
          // save for the value to round-trip to settings.json.
          translationAutoEnabled: s.translationAutoEnabled,
          translationTargetLang: s.translationTargetLang,
          // REQ-0443 §1 — renderer-owned (`incoming-wins`); sent every save.
          playbackTimeDetailed: s.playbackTimeDetailed,
          encoder: s.encoder,
          defaultAudioTrackIndex: s.defaultAudioTrackIndex,
          fadeDurationSec: s.fadeDurationSec,
          activeModelId: null,
          // REQ-0315 §4 — `activeFontId` is deliberately NOT sent.
          // Main owns it exclusively (font.ts `fontSetActive` /
          // `fontUninstall` / `fontUninstallAll` are the only writers), and the
          // merge rule is `presence-wins`, which only preserves the on-disk
          // value while the key is ABSENT.  Sending it would defeat the rule —
          // same two-part shape as `fontSetInstalledVersion` (REQ-0279).
          lastInputDir: null,
          lastOutputDir: null,
          // REQ-0158 — the Settings-dialog user-preferred fixed folders
          // (REQ-0121) MUST be included in the payload so a "set to
          // C:/videos" survives a restart AND a "cleared to null via
          // the × button" propagates to disk.  The main-side merge
          // uses `'key' in incoming` semantics (not `?? existing`) to
          // distinguish those two cases from "renderer omitted the
          // key entirely" — see `settings-merge.ts`.
          defaultInputDir: s.defaultInputDir,
          defaultOutputDir: s.defaultOutputDir,
          // REQ-0194 — same include-always contract as the input/output
          // folders above (a null must propagate to disk so a manual
          // "clear" round-trips).
          defaultProjectDir: s.defaultProjectDir,
          // REQ-0518 — the three new folder rows follow the SAME include-always
          // contract: `presence-wins` keeps main's value when the key is
          // absent, so omitting them here would make the settings dialog unable
          // to change (or clear) them at all.
          defaultImageDir: s.defaultImageDir,
          defaultTextDir: s.defaultTextDir,
          defaultSrtDir: s.defaultSrtDir,
          // REQ-0335 §3-6 — renderer-owned (`incoming-wins`), so it MUST be
          // sent on every save: omitting it would make main keep the
          // previous list and a deletion would never reach disk.
          stylePresets: s.stylePresets,
          // REQ-0540 — renderer-owned (`incoming-wins`), so the same
          // send-every-save obligation as stylePresets: omitting it would drop
          // the whole remembered table rather than keep main's copy.
          animationMemory: s.animationMemory,
          // REQ-0551 — renderer-owned (`incoming-wins`): omitting it would drop
          // the consent record and re-prompt someone who already agreed.
          aiIntegration: s.aiIntegration
        }
        /*
         * ★ REQ-0545 §2 (RES-0543 A1) — a failed settings save is no longer
         * silent.
         *
         * This used to be `.catch(() => {})`.  When the write failed — a full
         * disk, a permission problem, a file another program is holding — the
         * user's change simply did not persist, and nothing anywhere said so;
         * they found out on the next launch, if at all.
         *
         * Both failure shapes are handled: a rejected promise (IPC unreachable)
         * and an `ok: false` reply (main caught it and reported).  The reason
         * string is shown, because "settings could not be saved" without a
         * cause leaves the user with nothing to act on.
         */
        void saveSettings(settings)
          .then((res) => {
            if (res.ok) { settingsSaveReporter.succeeded(); return }
            settingsSaveReporter.failed(res.error?.message ?? res.error?.code ?? '')
          })
          .catch((err: unknown) => {
            settingsSaveReporter.failed(err instanceof Error ? err.message : String(err))
          })
      }, SETTINGS_DEBOUNCE_MS)
    }
    const unsub = useSettingsStore.subscribe(save)
    return () => {
      clearTimeout(timer)
      unsub()
    }
  }, [])

  // Native menu event subscriptions
  useEffect(() => {
    const subs = [
      window.electronAPI?.subscribeToChannel('menu:openAbout', () => {
        useUiStore.getState().setAboutDialogOpen(true)
      }),
      window.electronAPI?.subscribeToChannel('menu:openSettings', () => {
        useUiStore.getState().setSettingsDialogOpen(true)
      }),
      window.electronAPI?.subscribeToChannel('menu:openDonations', () => {
        useUiStore.getState().setDonationDialogOpen(true)
      }),
      // REQ-0194 — File > Save Project (Ctrl+S).  The save routine
      // handles its own IO + serialisation; App.tsx owns the toast
      // bridge because the sonner instance mounts here.  Failures
      // land on toast.error; a "no project to save" state (Step 1
      // with no video) surfaces a warning toast instead of a
      // silent no-op so the user knows the click was received.
      window.electronAPI?.subscribeToChannel('menu:saveProject', () => {
        void (async () => {
          const r = await saveCurrentProject()
          if (r.ok) {
            toast.success(t('project.save.toastSuccess'), {
              description: t('project.save.toastSuccessDesc'),
            })
          } else if (r.reason === 'no-project') {
            toast.warning(t('project.save.toastNothingToSave'))
          } else if (r.reason === 'io-error') {
            toast.error(t('project.save.toastError', { error: r.message ?? '' }))
          }
          // 'cancelled' — user closed the OS save dialog; no toast.
        })()
      })
    ]
    return () => subs.forEach(u => u?.())
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <AnimatePresence mode="wait">
        <motion.div
          key={location.pathname}
          variants={PAGE_VARIANTS}
          initial="initial"
          animate="animate"
          exit="exit"
          transition={PAGE_TRANSITION}
          className="h-full"
        >
          <Routes location={location}>
            {/* Splash route disabled — kept commented out for possible reintroduction.
            <Route path="/splash" element={<SplashRoute />} /> */}
            <Route path="/step1" element={<Step1Route />} />
            <Route path="/step2" element={<Step2Route />} />
            {/* REQ-20260615-023: /step3 retired; burn-in lives in a
                right-sliding drawer on STEP2 instead. */}
            <Route path="*" element={<Navigate to="/step1" replace />} />
          </Routes>
        </motion.div>
      </AnimatePresence>

      <QuitConfirm />
      <SettingsQuarantineDialog
        notice={quarantineNotice}
        onDismiss={() => setQuarantineNotice(null)}
      />
      <AboutDialog />
      <SettingsDialog />
      <DonationDialog />
      <FontLicensesDialog />
      <EulaDialog />
      <StoreUpsellDialog />
      {/* REQ-0194 phase 3b — drives the `.mojioko` open flow (parse →
          source check → identity check → font warning → hydrate stores
          → navigate).  Mounted at the App level so the menu event
          subscription outlives every route change. */}
      <ProjectOpenController />

      {/* REQ-0414 — DEV-only live token editor (Ctrl+Shift+D).  The
          `import.meta.env.DEV` constant folds to `false` in production, so
          Rollup drops both this branch and the import above. */}
      {import.meta.env.DEV && <DevTokenEditor />}

      <Toaster
        position="bottom-center"
        theme="dark"
        // Distance from the viewport bottom edge to the toast
        // stack.  Value must equal the footer's rendered height so
        // the toast card's bottom edge lands exactly on the
        // footer's border-t line — owner spec "フッター区切り線の
        // すぐ上に接地" across REQ-0185/0186/0187.
        //
        // REQ-0186's math (41 px) undercounted because it summed
        // padding + text-caption line-height + border-t but forgot
        // that the footer's actual content is the taller of its
        // slots — left/right are `<Button size="md" h-7>` = 28 px,
        // not text-caption 16 px.  Real breakdown:
        //   py-3          → 12 + 12          = 24 px
        //   Button h-7    → 28 px (tallest slot content)
        //   border-t      →  1 px
        //   total                              53 px
        // REQ-0187 sets 54 (footer height + 1 px hairline safety
        // so the toast bottom doesn't overlap the border-t line
        // itself).  Sonner's `offset` for bottom-center positions
        // is viewport-edge-to-toast-edge.
        //
        // REQ-0185 was 68 (too much); REQ-0186 was 42 (still too
        // low, owner's spec was undermet).  REQ-0187 = 54 with
        // corrected math.
        offset={54}
        toastOptions={{
          classNames: {
            toast:
              'bg-surface-1 border border-line rounded-lg text-fg-primary shadow-2xl shadow-black/40',
            title: 'text-body font-medium text-fg-primary',
            description: 'text-body-sm text-fg-tertiary',
            actionButton: 'bg-surface-3 text-fg-primary text-body-sm rounded-md px-2 py-1',
            cancelButton: 'bg-surface-2 text-fg-tertiary text-body-sm rounded-md px-2 py-1'
          }
        }}
      />
    </>
  )
}

export default function App() {
  // Smoke-only override: when launched with `?seed=demo&start=stepN` the
  // router boots on that step instead of Step 1.  Lets a Playwright
  // screenshot smoke jump straight into STEP 2's timeline view (where the
  // fixtures seeded by main.tsx are visible) without driving the breadcrumb.
  // No effect on the shipped app — main never appends these params.
  const initialPath = (() => {
    const p = new URLSearchParams(window.location.search)
    if (p.get('seed') !== 'demo') return '/step1'
    const start = p.get('start')
    return start === 'step2' ? `/${start}` : '/step1'
  })()
  return (
    <TooltipProvider delayDuration={300}>
      <MemoryRouter
        // Splash screen disabled — start directly on /step1.
        // Original: initialEntries={['/splash']}
        initialEntries={[initialPath]}
        initialIndex={0}
        future={{
          v7_startTransition: true,
          v7_relativeSplatPath: true,
        }}
      >
        <AppInner />
      </MemoryRouter>
    </TooltipProvider>
  )
}
