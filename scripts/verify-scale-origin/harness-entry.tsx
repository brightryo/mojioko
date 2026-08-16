/**
 * REQ-0514 — preview side of the `verify:scale-origin` gate.
 *
 * Renders the REAL `VideoPreviewPanel` in headless chromium with a real
 * <video>, so the scale animation's origin is observed as PIXELS the real
 * component painted — not as a transform string this harness re-derived.
 * The cue comes from `case-spec.ts`, the same builder the burn side feeds to
 * `generateAss`.
 */
import React from 'react'
import { createRoot } from 'react-dom/client'
import { VideoPreviewPanel } from '../../src/renderer/components/video-preview/video-preview-panel'
import { useProjectStore } from '../../src/renderer/stores/project-store'
import { useAppEnvStore } from '../../src/renderer/stores/app-env-store'
import { useUiStore } from '../../src/renderer/stores/ui-store'
import { cue, VIDEO, type CaseSpec } from './case-spec'

// Any electronAPI method → async no-op.  The animation path touches none of
// them; this only keeps incidental calls (font load, shell) from throwing.
;(window as unknown as { electronAPI: unknown }).electronAPI = new Proxy(
  {},
  { get: () => (..._a: unknown[]) => Promise.resolve(undefined) },
)

const spec = (window as unknown as { __spec: CaseSpec }).__spec

// eslint-disable-next-line @typescript-eslint/no-explicit-any
useProjectStore.setState({ video: VIDEO, entries: [cue(spec)], cuts: [] } as any)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
useAppEnvStore.setState({ isMsix: false } as any)

// The panel's own seek path (= what clicking a subtitle row does).
;(window as unknown as { __ui: unknown }).__ui = useUiStore

const root = document.getElementById('root')
if (root) createRoot(root).render(React.createElement(VideoPreviewPanel))
;(window as unknown as { __ready: boolean }).__ready = true
