/**
 * REQ-0532 §1 — preview side of the `verify:cut-anim-parity` gate.
 *
 * Renders the REAL `VideoPreviewPanel` in headless chromium with a real
 * <video> and a real cut list, so the animation phase is observed as PIXELS the
 * shipping component painted — not as a number this harness re-derived.
 *
 * `__spec.cuts` is what makes this gate's negative control possible without
 * touching source: the control renders the SAME cue at the SAME source instant
 * with an EMPTY cut list, which is bit-for-bit the computation the preview did
 * before this REQ (raw cue times against a raw clock).
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
const cutsOverride = (window as unknown as { __cutsOverride?: unknown }).__cutsOverride

useProjectStore.setState({
  video: VIDEO,
  entries: [cue(spec)],
  // The control passes `[]` here while keeping the same cue and the same
  // seek target — see the file header.
  cuts: cutsOverride ?? spec.cuts,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
useAppEnvStore.setState({ isMsix: false } as any)

// The panel's own seek path (= what clicking a subtitle row does).  Takes a
// SOURCE-axis time, like every other caller of `setVideoSeekRequest`.
;(window as unknown as { __ui: unknown }).__ui = useUiStore

const root = document.getElementById('root')
if (root) createRoot(root).render(React.createElement(VideoPreviewPanel))
;(window as unknown as { __ready: boolean }).__ready = true
