import { useEffect, useState } from 'react'
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
import { useUiStore } from '@/stores/ui-store'
import { useSettingsStore } from '@/stores/settings-store'
import { loadSettings, saveSettings } from '@/services/settings'
import { setActiveSubtitleFont, loadSubtitleFontFor } from '@/lib/font-metrics'
import { ensureFontLoaded } from '@/lib/font-registry'
import { listFonts } from '@/services/font'
import { APP_VERSION } from '../shared/app-info'
import type { AppSettings } from '../shared/types'

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

function AppInner() {
  useSuppressTabFocus()
  const [appVersion, setAppVersion] = useState(APP_VERSION)
  const location = useLocation()
  const { i18n } = useTranslation('common')

  // REQ-20260615-026: keep <html> in sync with the user-selected theme so
  // the `:root.light { ... }` overrides in globals.css activate.  Default
  // (no class) leaves the dark mauve values from :root active.
  const theme = useSettingsStore((s) => s.theme)
  useEffect(() => {
    const root = document.documentElement
    root.classList.toggle('light', theme === 'light')
    root.classList.toggle('dark', theme === 'dark')
  }, [theme])

  useEffect(() => {
    window.electronAPI
      .getVersion()
      .then((v) => setAppVersion(v))
      .catch(() => {})
  }, [])

  // Load settings from main process on mount; hydrate stores
  useEffect(() => {
    loadSettings().then((result) => {
      if (!result.ok) return
      const s = result.data
      useSettingsStore.getState().hydrate(s)
      if (s.language !== i18n.language) {
        void i18n.changeLanguage(s.language)
      }
    }).catch(() => { /* IPC unavailable in dev outside Electron */ })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

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
  useEffect(() => {
    listFonts().then((r) => {
      if (!r.ok) return
      for (const f of r.data.fonts) {
        if (f.status === 'bundled' || f.status === 'installed') {
          loadSubtitleFontFor(f.id).catch(() => {})
          ensureFontLoaded(f.id).catch(() => {})
        }
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
          transcriptionDefaults: s.transcriptionDefaults,
          transcriptionAdvanced: s.transcriptionAdvanced,
          autoLineBreak: s.autoLineBreak,
          encoder: s.encoder,
          defaultAudioTrackIndex: s.defaultAudioTrackIndex,
          fadeDurationSec: s.fadeDurationSec,
          activeModelId: null,
          activeFontId: s.activeFontId,
          lastInputDir: null,
          lastOutputDir: null
        }
        saveSettings(settings).catch(() => { /* ignore IPC failures */ })
      }, 500)
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
            <Route path="/step1" element={<Step1Route appVersion={appVersion} />} />
            <Route path="/step2" element={<Step2Route appVersion={appVersion} />} />
            {/* REQ-20260615-023: /step3 retired; burn-in lives in a
                right-sliding drawer on STEP2 instead. */}
            <Route path="*" element={<Navigate to="/step1" replace />} />
          </Routes>
        </motion.div>
      </AnimatePresence>

      <AboutDialog />
      <SettingsDialog />
      <DonationDialog />
      <FontLicensesDialog />

      <Toaster
        position="bottom-center"
        theme="dark"
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
