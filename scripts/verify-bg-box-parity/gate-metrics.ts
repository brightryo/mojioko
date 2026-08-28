/**
 * REQ-0535 — real font metrics for the gate.
 *
 * ★ Why the gate cannot just let `generateAss` use its default resolver.
 *
 * Production resolves metrics through `getLineBreakMetrics`, which finds the
 * TTF via `main/lib/paths` and therefore needs the Electron `app` global.  In a
 * plain-node bundle that require throws, the loader swallows it and answers
 * `{ font: null }` — and `generateAss` then deliberately keeps libass's OLD
 * per-line box, because sizing a visible rectangle from the character-class
 * estimate would be worse than the stripe.
 *
 * That fallback is correct for production and fatal for a gate: the first run of
 * this gate measured the fix and saw the pre-fix numbers, because it was
 * silently exercising the fallback.  Loading the real TTF here is what makes the
 * gate measure the thing it claims to.  `assertRealFont` exists so a future
 * breakage surfaces as a failure rather than as "the fix stopped working".
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildFontEntry } from '../../src/shared/font-entry'
import type { LineBreakMetrics } from '../../src/shared/line-break-core'
import { getFontMeta, DEFAULT_FONT_ID } from '../../src/shared/fonts'

const TTF = join(
  __dirname, '..', '..', 'resources', 'fonts', 'Noto_Sans_JP', 'static',
  getFontMeta(DEFAULT_FONT_ID).fileName,
)

const buf = readFileSync(TTF)
const entry = buildFontEntry(
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
)

export const TTF_PATH: string = TTF

export const metrics: LineBreakMetrics = entry?.font
  ? { font: entry.font, libassScale: entry.libassScale, cmap: entry.cmapCoverage, tofu: entry.tofuSubstitute }
  : { font: null, libassScale: 1, cmap: null, tofu: null }

/** The resolver handed to `generateAss`. */
export function metricsFor(): LineBreakMetrics {
  return metrics
}

/**
 * Fail loudly when the real font did not load.  Without this the gate would
 * quietly measure `generateAss`'s libass-box fallback and report the pre-fix
 * numbers as if they were the fix's.
 */
export function assertRealFont(): void {
  if (!metrics.font) {
    throw new Error(
      `verify:bg-box-parity needs real font metrics; failed to parse ${TTF}. ` +
      'Without them generateAss keeps the old libass box and the gate measures nothing.',
    )
  }
}
