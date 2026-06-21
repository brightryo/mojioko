import './i18n'
import './styles/globals.css'
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'

/**
 * Screenshot-smoke seed hook.  When the renderer is loaded with the search
 * parameter `?seed=demo`, populate the project store with sample fixtures
 * before React mounts so a Playwright smoke can capture STEP 2 / STEP 3
 * screens without having to drive a real Step 1 → Whisper transcription
 * flow.  The shipped main process never appends this parameter, so the
 * branch is dead code in production builds — only Playwright explicitly
 * setting the URL will trigger it.  See dev-docs/specs/timeline.md and
 * the smoke scripts under dev-docs/font-validation/ for usage.
 */
async function maybeSeedFromUrl(): Promise<void> {
  const params = new URLSearchParams(window.location.search)
  if (params.get('seed') !== 'demo') return
  const [
    { useProjectStore },
    { useUiStore },
    { useHistoryStore },
    { sampleVideoInfo, sampleEntries }
  ] = await Promise.all([
    import('./stores/project-store'),
    import('./stores/ui-store'),
    import('./stores/history-store'),
    import('./lib/fixtures')
  ])
  useProjectStore.setState({
    video: sampleVideoInfo,
    videoLoadingState: 'loaded',
    entries: sampleEntries
  })
  // Expose stores for follow-up smoke manipulation (playhead, view mode,
  // direct undo/redo, etc.).  Only attached when seed=demo is explicitly
  // requested — never present when the shipped main process loads the
  // renderer.
  Object.assign(window, {
    __mojioko_test: {
      project: useProjectStore,
      ui: useUiStore,
      history: useHistoryStore
    }
  })
}

/**
 * REQ-20260615-040 B — gate the first React paint on the UI font being
 * ready, so the app never paints in the system fallback first and then
 * reflows when Noto Sans JP arrives (= FOUT).  The font is bundled and
 * served locally so the wait is effectively imperceptible.  The 1500 ms
 * timeout is a safety net: if the load promise hangs (e.g. corrupted
 * blob, fontFace API unavailable in a future Electron build), we mount
 * the app anyway rather than show an indefinitely-blank window.
 */
async function awaitUiFontReady(): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts || !document.fonts.load) return
  const family = "'Noto Sans JP'"
  const probes = [
    document.fonts.load(`400 16px ${family}`),
    document.fonts.load(`500 16px ${family}`),
    document.fonts.load(`600 16px ${family}`),
  ]
  const timeout = new Promise<void>((resolve) => {
    setTimeout(resolve, 1500)
  })
  try {
    await Promise.race([Promise.all(probes), timeout])
  } catch {
    /* swallow — proceed to mount even if the load API rejected */
  }
}

Promise.all([maybeSeedFromUrl(), awaitUiFontReady()]).finally(() => {
  const rootEl = document.getElementById('root')
  if (!rootEl) throw new Error('Root element not found')

  ReactDOM.createRoot(rootEl).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
})
