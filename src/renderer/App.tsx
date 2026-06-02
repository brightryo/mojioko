import { useEffect, useState } from 'react'
import { MemoryRouter, Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { Toaster } from 'sonner'
import { useHotkeys } from 'react-hotkeys-hook'
import { useTranslation } from 'react-i18next'
import { TooltipProvider } from '@/components/ui/tooltip'
// Splash screen disabled — kept commented out for possible reintroduction.
// import SplashRoute from '@/routes/splash'
import Step1Route from '@/routes/step1'
import Step2Route from '@/routes/step2'
import Step3Route from '@/routes/step3'
import { CommandPalette } from '@/components/command-palette/command-palette'
import { ShortcutsDialog } from '@/components/shortcuts-dialog/shortcuts-dialog'
import { AboutDialog } from '@/components/about-dialog/about-dialog'
import { SettingsDialog } from '@/components/settings-dialog/settings-dialog'
import { DonationDialog } from '@/components/donation-dialog/donation-dialog'
import { FontLicensesDialog } from '@/components/font-licenses/font-licenses-dialog'
import { useUiStore } from '@/stores/ui-store'
import { useSettingsStore } from '@/stores/settings-store'
import { useProjectStore } from '@/stores/project-store'
import { useHistoryStore } from '@/stores/history-store'
import { registerCommands } from '@/lib/commands'
import { loadSettings, saveSettings } from '@/services/settings'
import { setActiveSubtitleFont, loadSubtitleFontFor } from '@/lib/font-metrics'
import { ensureFontLoaded } from '@/lib/font-registry'
import { listFonts } from '@/services/font'
import { APP_VERSION } from '../shared/app-info'
import type { AppSettings } from '../shared/types'
import {
  FileVideo,
  Keyboard,
  Info,
  RotateCcw,
  Undo2,
  Redo2,
  Heart
} from 'lucide-react'

const PAGE_VARIANTS = {
  initial: { opacity: 0, x: 8 },
  animate: { opacity: 1, x: 0 },
  exit:    { opacity: 0, x: -8 }
}

const PAGE_TRANSITION = { duration: 0.25, ease: 'easeOut' }


function GlobalHotkeys() {
  const setCommandPaletteOpen = useUiStore((s) => s.setCommandPaletteOpen)
  const setShortcutsOpen = useUiStore((s) => s.setShortcutsDialogOpen)

  useHotkeys('ctrl+k', (e) => { e.preventDefault(); setCommandPaletteOpen(true) }, { enableOnFormTags: false })
  useHotkeys('ctrl+/', (e) => { e.preventDefault(); setShortcutsOpen(true) }, { enableOnFormTags: false })

  return null
}

function CommandRegistrar() {
  const { t } = useTranslation('commands')
  const navigate = useNavigate()
  const setShortcutsOpen = useUiStore((s) => s.setShortcutsDialogOpen)
  const setAboutOpen = useUiStore((s) => s.setAboutDialogOpen)
  const setDonationOpen = useUiStore((s) => s.setDonationDialogOpen)
  const setCommandPaletteOpen = useUiStore((s) => s.setCommandPaletteOpen)
  const setTableFilter = useUiStore((s) => s.setTableFilter)
  const setLanguage = useSettingsStore((s) => s.setLanguage)
  const undo = useHistoryStore((s) => s.undo)
  const redo = useHistoryStore((s) => s.redo)

  useEffect(() => {
    registerCommands([
      // Navigation
      { id: 'goToStep1', labelKey: 'navigation.goToStep1', group: 'navigation', run: () => navigate('/step1') },
      { id: 'goToStep2', labelKey: 'navigation.goToStep2', group: 'navigation', run: () => navigate('/step2') },
      {
        id: 'goToStep3',
        labelKey: 'navigation.goToStep3',
        group: 'navigation',
        // REQ-028: STEP 3 (burn-in) is unreachable for audio-only inputs.
        // Hide the command so the user does not get a navigation that
        // lands on a step with nothing to do.
        predicate: () => {
          const v = useProjectStore.getState().video
          return v === null || v.hasVideoStream
        },
        run: () => navigate('/step3')
      },
      { id: 'filterAll',      labelKey: 'navigation.filterAll',      group: 'navigation', run: () => setTableFilter('all') },
      { id: 'filterReady',    labelKey: 'navigation.filterReady',    group: 'navigation', run: () => setTableFilter('ready') },
      { id: 'filterEdited',   labelKey: 'navigation.filterEdited',   group: 'navigation', run: () => setTableFilter('edited') },
      { id: 'filterWarnings', labelKey: 'navigation.filterWarnings', group: 'navigation', run: () => setTableFilter('warnings') },
      { id: 'filterDeleted',  labelKey: 'navigation.filterDeleted',  group: 'navigation', run: () => setTableFilter('deleted') },

      // File
      { id: 'openVideo',    labelKey: 'file.openVideo',    group: 'file', icon: FileVideo, shortcut: 'Ctrl+O', run: () => {} },
      { id: 'exportText',   labelKey: 'file.exportText',   group: 'file', shortcut: 'Ctrl+S', run: () => {} },

      // Edit
      { id: 'undo',      labelKey: 'edit.undo',      group: 'edit', icon: Undo2,      shortcut: 'Ctrl+Z', run: () => undo() },
      { id: 'redo',      labelKey: 'edit.redo',      group: 'edit', icon: Redo2,      shortcut: 'Ctrl+Y', run: () => redo() },
      { id: 'addRow',    labelKey: 'edit.addRow',    group: 'edit', shortcut: 'Ctrl+N', run: () => {} },
      { id: 'deleteRow', labelKey: 'edit.deleteRow', group: 'edit', run: () => {} },
      { id: 'resetRow',  labelKey: 'edit.resetRow',  group: 'edit', icon: RotateCcw, shortcut: 'Ctrl+R', run: () => {} },

      // Settings
      { id: 'switchToJapanese',  labelKey: 'settings.switchToJapanese',  group: 'settings', run: () => setLanguage('ja') },
      { id: 'switchToEnglish',   labelKey: 'settings.switchToEnglish',   group: 'settings', run: () => setLanguage('en') },

      // Help
      { id: 'showShortcuts',    labelKey: 'help.showShortcuts',    group: 'help', icon: Keyboard, shortcut: 'Ctrl+/', run: () => setShortcutsOpen(true) },
      { id: 'about',            labelKey: 'help.about',            group: 'help', icon: Info,     run: () => { setCommandPaletteOpen(false); setAboutOpen(true) } },
      { id: 'support',          labelKey: 'help.support',          group: 'help', icon: Heart,    run: () => { setCommandPaletteOpen(false); setDonationOpen(true) } },
    ])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t])

  return null
}

function AppInner() {
  const [appVersion, setAppVersion] = useState(APP_VERSION)
  const location = useLocation()
  const { i18n } = useTranslation('common')

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
      <CommandRegistrar />
      <GlobalHotkeys />

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
            <Route path="/step3" element={<Step3Route appVersion={appVersion} />} />
            <Route path="*" element={<Navigate to="/step1" replace />} />
          </Routes>
        </motion.div>
      </AnimatePresence>

      <CommandPalette />
      <ShortcutsDialog />
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
              'bg-zinc-900 border border-zinc-800 rounded-lg text-zinc-50 shadow-2xl shadow-black/40',
            title: 'text-[13px] font-medium text-zinc-50',
            description: 'text-[12px] text-zinc-400',
            actionButton: 'bg-zinc-700 text-zinc-50 text-[12px] rounded-md px-2 py-1',
            cancelButton: 'bg-zinc-800 text-zinc-400 text-[12px] rounded-md px-2 py-1'
          }
        }}
      />
    </>
  )
}

export default function App() {
  return (
    <TooltipProvider delayDuration={300}>
      <MemoryRouter
        // Splash screen disabled — start directly on /step1.
        // Original: initialEntries={['/splash']}
        initialEntries={['/step1']}
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
