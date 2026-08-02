// REQ-0379 §1 — render the REAL VideoPreviewPanel in a real browser and let a
// real <video> drive playback, so the first painted frame of a cue's playback
// activation is observed as pixels, not modelled.  No logic is re-implemented
// here; the component's own mount ref / rAF / render-seed run for real.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { VideoPreviewPanel } from '../../src/renderer/components/video-preview/video-preview-panel'
import { useProjectStore } from '../../src/renderer/stores/project-store'
import { useAppEnvStore } from '../../src/renderer/stores/app-env-store'
import { useUiStore } from '../../src/renderer/stores/ui-store'
import { makeEntryLayoutDefaults } from '../../src/shared/burnin-defaults'

// Any electronAPI method → async no-op.  The animation path touches none of
// them; this just keeps incidental calls (font load, shell) from throwing.
;(window as unknown as { electronAPI: unknown }).electronAPI = new Proxy(
  {},
  { get: () => (..._a: unknown[]) => Promise.resolve(undefined) },
)

const animType = (window as unknown as { __animType?: string }).__animType || 'blur'

const entry = {
  id: 'cue1',
  startSec: 2.0,
  endSec: 4.0,
  text: 'ANIMATIONTEST',
  fontSizePx: 90,
  textColorHex: '#ffffff',
  textAlpha: 100,
  outlineColorHex: '#000000',
  outlineThicknessPx: 6,
  outlineAlpha: 100,
  fadeDurationSec: 0,
  fontId: undefined,
  ...makeEntryLayoutDefaults(),
  verticalPosition: 'center' as const, // centre so the ink is easy to find
  isDeleted: false,
  isEdited: false,
  animationType: animType,
  animationInEnabled: true,
  animationOutEnabled: true,
  animationDurationSec: 0.8,
  animationBlurPx: 80,
  animationStartScalePercent: 50,
  original: {},
}

const video = {
  path: 'test.mp4',
  hasVideoStream: true,
  widthPx: 640,
  heightPx: 360,
  durationSec: 6,
  fps: 30,
  container: 'mp4',
  videoCodec: 'h264',
  audioTracks: [],
  fileSizeBytes: 7520,
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
useProjectStore.setState({ video, entries: [entry], cuts: [] } as any)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
useAppEnvStore.setState({ isMsix: false } as any)

// Expose the seek-request store so the harness can drive the panel's OWN
// seek-to-cue-start path (= what clicking a subtitle row does).
;(window as unknown as { __ui: unknown }).__ui = useUiStore

const root = document.getElementById('root')
if (root) createRoot(root).render(React.createElement(VideoPreviewPanel))
;(window as unknown as { __ready: boolean }).__ready = true
