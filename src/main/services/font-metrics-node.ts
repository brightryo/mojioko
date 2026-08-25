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
import { getFontResolveDir } from '../lib/paths'

const cache = new Map<FontId, FontEntry | null>()

/**
 * ★ REQ-0537 — this import is STATIC, and must stay static.
 *
 * It used to be a lazy `require('../lib/paths')`, on the reasoning that
 * `headless-layout.ts` and its unit tests could then import this module without
 * pulling in the Electron `app` global. The cost of that caution was total:
 * electron-vite bundles main into a single file, a runtime `require` of a
 * relative path has nothing to resolve against, and it threw
 * `Cannot find module '../lib/paths'` on EVERY call in the real app. The
 * `catch` then turned that into `{ font: null }` — the documented "no metrics"
 * answer — so nothing looked wrong.
 *
 * That silence had two consequences. Headless line breaking has been running on
 * the character-class estimate rather than real font metrics, which is the very
 * thing REQ-0456 built this module to avoid; and REQ-0535's background drawing
 * fell back to its old per-line box for every cue, which is the stripe this REQ
 * is about.
 *
 * Making it static needed one change in `paths.ts` first: it read
 * `app.isPackaged` into a module-level `const` at import time, which really did
 * break under vitest (`Cannot read properties of undefined`). That read is now
 * deferred into a function, so importing the module does no Electron work and a
 * plain import is safe from anywhere. The lazy `require` was a workaround for
 * that one line, and it cost far more than the line was worth.
 */
function resolveTtfPath(fontId: FontId): string {
  const meta = getFontMeta(fontId)
  return join(getFontResolveDir(meta), meta.fileName)
}

/**
 * REQ-0537 — why the last load for a font id failed.
 *
 * The loader has always returned `null` for "no metrics" and said nothing else,
 * which is fine for line breaking (the character-class fallback wraps text
 * perfectly well) but became a silent defect the moment REQ-0535 started using
 * these metrics to SIZE something visible: the background quietly reverted to
 * its old per-line box and no message existed anywhere. Recording the reason
 * costs nothing and turns "the fix does not work" into a one-line answer.
 */
export interface FontMetricsFailure {
  fontId: FontId
  path: string
  reason: 'file-not-found' | 'parse-failed' | 'path-resolution-failed'
  detail?: string
}
const failures = new Map<FontId, FontMetricsFailure>()

/** The reason `getLineBreakMetrics` had no real font, or null if it did. */
export function getFontMetricsFailure(fontId: string | undefined): FontMetricsFailure | null {
  const id: FontId = fontId && isFontId(fontId) ? fontId : DEFAULT_FONT_ID
  return failures.get(id) ?? null
}

/** Load (and cache) the parsed font entry for `fontId`, or null when unavailable. */
function loadEntry(fontId: FontId): FontEntry | null {
  if (cache.has(fontId)) return cache.get(fontId) ?? null
  let entry: FontEntry | null = null
  let ttfPath = '(unresolved)'
  try {
    ttfPath = resolveTtfPath(fontId)
    if (!existsSync(ttfPath)) {
      failures.set(fontId, { fontId, path: ttfPath, reason: 'file-not-found' })
    } else {
      const buf = readFileSync(ttfPath)
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
      entry = buildFontEntry(ab)
      if (!entry?.font) {
        failures.set(fontId, { fontId, path: ttfPath, reason: 'parse-failed' })
      } else {
        failures.delete(fontId)
      }
    }
  } catch (err) {
    entry = null
    failures.set(fontId, {
      fontId,
      path: ttfPath,
      reason: ttfPath === '(unresolved)' ? 'path-resolution-failed' : 'parse-failed',
      detail: String(err),
    })
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
  failures.clear()
}
