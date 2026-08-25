/**
 * REQ-0535 — preview side of `verify:bg-box-parity`.
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

/**
 * The panel builds its `<video src>` as `mojioko-media://<encoded path>`, a
 * scheme registered by the Electron MAIN process.  Plain chromium has no
 * handler, so the element fires `error` on its very first load, the panel sets
 * `hasError` and renders an error message INSTEAD of the video frame — and the
 * frame is the thing this gate screenshots.  The element never survives long
 * enough to be handed a source afterwards.
 *
 * Rewriting the attribute at `setAttribute` time happens BEFORE chromium tries
 * to fetch it, so no error is ever raised.  It is done here rather than by
 * changing the panel because the gate must render the REAL component.
 */
const realSetAttribute = Element.prototype.setAttribute
Element.prototype.setAttribute = function (name: string, value: string) {
  if (this instanceof HTMLVideoElement && name === 'src' && value.startsWith('mojioko-media://')) {
    return realSetAttribute.call(this, name, (window as unknown as { __videoUrl: string }).__videoUrl)
  }
  return realSetAttribute.call(this, name, value)
}

const spec = (window as unknown as { __spec: CaseSpec }).__spec

// eslint-disable-next-line @typescript-eslint/no-explicit-any
useProjectStore.setState({ video: VIDEO, entries: [cue(spec)], cuts: [] } as any)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
useAppEnvStore.setState({ isMsix: true } as any)

;(window as unknown as { __ui: unknown }).__ui = useUiStore
;(window as unknown as { __project: unknown }).__project = useProjectStore

const root = document.getElementById('root')
if (root) createRoot(root).render(React.createElement(VideoPreviewPanel))
;(window as unknown as { __ready: boolean }).__ready = true
