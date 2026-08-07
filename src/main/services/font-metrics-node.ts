/**
 * REQ-0456 — main/headless font metrics loader.
 *
 * The renderer builds its font metrics from bytes fetched over IPC / HTTP and
 * caches them in a module singleton (`renderer/lib/font-metrics.ts`).  Headless
 * burn/transcribe has no renderer, so this loads the SAME TTF straight off disk
 * (`getFontResolveDir(meta) + meta.fileName`, exactly where `ipc/font.ts` reads
 * it) and runs the shared `buildFontEntry`, yielding the identical
 * `libassScale` / cmap / tofu the GUI uses — the precondition for the headless
 * `\N` placement matching the preview.
 *
 * Synchronous + cached: called once per referenced fontId per burn.  A missing
 * or unparseable file resolves to `{ font: null, ... }`, whose character-class
 * fallback still wraps (never throws, never overflows) — the same contract the
 * renderer honours before a font finishes loading.
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { getFontMeta, isFontId, DEFAULT_FONT_ID, type FontId } from '../../shared/fonts'
import { buildFontEntry, FALLBACK_LIBASS_SCALE, type FontEntry } from '../../shared/font-entry'
import type { LineBreakMetrics } from '../../shared/line-break-core'

const cache = new Map<FontId, FontEntry | null>()

/**
 * Lazy-require the electron-coupled path/logger helpers INSIDE the load call
 * (not at module top) so `headless-layout.ts` — and its unit tests — can import
 * this module without pulling the Electron `app` global.  The tests never load a
 * real font (they inject a metrics resolver), so this branch is only reached in
 * the app / an integration run where electron is present.
 */
function resolveTtfPath(fontId: FontId): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { getFontResolveDir } = require('../lib/paths') as typeof import('../lib/paths')
  const meta = getFontMeta(fontId)
  return join(getFontResolveDir(meta), meta.fileName)
}

/** Load (and cache) the parsed font entry for `fontId`, or null when unavailable. */
function loadEntry(fontId: FontId): FontEntry | null {
  if (cache.has(fontId)) return cache.get(fontId) ?? null
  let entry: FontEntry | null = null
  try {
    const ttfPath = resolveTtfPath(fontId)
    if (existsSync(ttfPath)) {
      const buf = readFileSync(ttfPath)
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
      entry = buildFontEntry(ab)
    }
  } catch {
    entry = null
  }
  cache.set(fontId, entry)
  return entry
}

/**
 * Resolve the `LineBreakMetrics` for a font id (falls back to the bundled
 * default for an unknown id, then to the null-font character-class path).
 */
export function getLineBreakMetrics(fontId: string | undefined): LineBreakMetrics {
  const id: FontId = fontId && isFontId(fontId) ? fontId : DEFAULT_FONT_ID
  const entry = loadEntry(id)
  if (!entry) {
    return { font: null, libassScale: FALLBACK_LIBASS_SCALE, cmap: null, tofu: null }
  }
  return { font: entry.font, libassScale: entry.libassScale, cmap: entry.cmapCoverage, tofu: entry.tofuSubstitute }
}

/** Test / long-run hook: drop the cache so a re-downloaded font is re-read. */
export function clearFontMetricsNodeCache(): void {
  cache.clear()
}
