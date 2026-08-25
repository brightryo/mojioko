/**
 * REQ-0536 §1-3 — preview side, for the CSS-vs-libass edge comparison.
 *
 * Renders the REAL `SubtitleOverlay` (the component that owns the preview's
 * `transform: rotate(...)`) at 1:1 — `containerWidthPx === videoWidthPx` — so
 * its pixels are directly comparable with the burn's without a scale factor in
 * between. The whole `VideoPreviewPanel` is deliberately not used: it needs a
 * decodable <video> and contributes nothing to how an edge is rasterised.
 */
import React from 'react'
import { createRoot } from 'react-dom/client'
import { SubtitleOverlay } from '../../src/renderer/components/subtitle-overlay/subtitle-overlay'
import type { SubtitleEntry } from '../../src/shared/types'

;(window as unknown as { electronAPI: unknown }).electronAPI = new Proxy(
  {},
  { get: () => (..._a: unknown[]) => Promise.resolve(undefined) },
)

interface Spec { fontId: string; cssFamily: string; rotation: number; mode: 'glyph' | 'border' }
const spec = (window as unknown as { __spec: Spec }).__spec

const base = {
  id: 'c1', startSec: 0, endSec: 2, text: 'IIII',
  fontSizePx: 300,
  textColorHex: '#ffffff', textAlpha: 100,
  outlineColorHex: '#ffffff',
  outlineThicknessPx: spec.mode === 'border' ? 20 : 0,
  outlineAlpha: 100,
  fadeDurationSec: 0,
  fontId: spec.fontId,
  horizontalPosition: 'center' as const,
  verticalPosition: 'center' as const,
  verticalMarginPx: 40,
  subtitleBackground: { enabled: false, color: 'black' as const, opacityPercent: 60 },
  lineSpacingPercent: 0,
  rotation: spec.rotation,
  words: [], karaokeEnabled: false,
  karaokeHighlightColor: '#ffffff', karaokeStyle: 'switch' as const,
  isDeleted: false, isEdited: false,
}
const entry = { ...base, original: { ...base } } as unknown as SubtitleEntry

const root = document.getElementById('root')
if (root) {
  createRoot(root).render(
    React.createElement(SubtitleOverlay, {
      entry,
      videoWidthPx: 1920,
      containerWidthPx: 1920,
    }),
  )
}
;(window as unknown as { __ready: boolean }).__ready = true
