/**
 * REQ-0515 — preview side of the `verify:text-whitespace` gate.
 *
 * Renders the REAL `VideoPreviewPanel` in headless chromium with a real
 * <video>, so what is measured is pixels the real component painted.  The cue
 * comes from `case-spec.ts`, the same builder the burn side feeds to
 * `generateAss`.
 */
import React from 'react'
import { createRoot } from 'react-dom/client'
import { VideoPreviewPanel } from '../../src/renderer/components/video-preview/video-preview-panel'
import { useProjectStore } from '../../src/renderer/stores/project-store'
import { useAppEnvStore } from '../../src/renderer/stores/app-env-store'
import { useUiStore } from '../../src/renderer/stores/ui-store'
import { cue, VIDEO, type CaseSpec } from './case-spec'

;(window as unknown as { electronAPI: unknown }).electronAPI = new Proxy(
  {},
  { get: () => (..._a: unknown[]) => Promise.resolve(undefined) },
)

const spec = (window as unknown as { __spec: CaseSpec }).__spec

// eslint-disable-next-line @typescript-eslint/no-explicit-any
useProjectStore.setState({ video: VIDEO, entries: [cue(spec)], cuts: [] } as any)
// `isMsix: true` — karaoke is a paid-tier feature and the gate's whole subject
// is the karaoke render path.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
useAppEnvStore.setState({ isMsix: true } as any)

;(window as unknown as { __ui: unknown }).__ui = useUiStore
// Exposed so the gate can drive the store the way the inspector's per-keystroke
// preview writer does — see `index.mjs` (§1-1: does typing reach the store?).
;(window as unknown as { __project: unknown }).__project = useProjectStore

const root = document.getElementById('root')
if (root) createRoot(root).render(React.createElement(VideoPreviewPanel))
;(window as unknown as { __ready: boolean }).__ready = true
