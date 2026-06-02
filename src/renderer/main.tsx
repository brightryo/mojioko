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
    { sampleVideoInfo, sampleEntries }
  ] = await Promise.all([
    import('./stores/project-store'),
    import('./stores/ui-store'),
    import('./lib/fixtures')
  ])
  useProjectStore.setState({
    video: sampleVideoInfo,
    videoLoadingState: 'loaded',
    entries: sampleEntries
  })
  // Expose stores for follow-up smoke manipulation (playhead, view mode, etc.).
  // Only attached when seed=demo is explicitly requested — never present
  // when the shipped main process loads the renderer.
  Object.assign(window, {
    __mojioko_test: {
      project: useProjectStore,
      ui: useUiStore
    }
  })
}

maybeSeedFromUrl().finally(() => {
  const rootEl = document.getElementById('root')
  if (!rootEl) throw new Error('Root element not found')

  ReactDOM.createRoot(rootEl).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
})
