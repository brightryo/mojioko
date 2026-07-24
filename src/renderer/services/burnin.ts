import type { SubtitleEntry, VideoInfo, BurninPosition, SubtitleBackground, IpcResult, EncoderSetting, AudioMode, OutputContainer } from '../../shared/types'
import type { BurninEvent } from '../../shared/ipc-contracts'
import { isFontId, resolveRenderableFontId, type FontId } from '../../shared/fonts'
import type { Cut } from '../../shared/cuts'
import { substituteMissingGlyphs } from '../../shared/glyph-substitute'
import { getCmapCoverageFor, getTofuSubstituteFor, loadSubtitleFontFor } from '../lib/font-metrics'
import { listFonts } from '@/services/font'

export interface BurninOptions {
  inputPath: string
  outputPath: string
  entries: SubtitleEntry[]
  video: VideoInfo
  burnin: BurninPosition
  encoderSetting: EncoderSetting
  audioMode: AudioMode
  subtitleBackground: SubtitleBackground
  outputContainer: OutputContainer
  /** Currently selected subtitle font.  Forwarded to libass via the ASS Style. */
  fontId: FontId
  /**
   * Trim/cut list (Original axis).  Omit or pass empty array for the
   * legacy no-cut behaviour; when non-empty the main side rebuilds the
   * ffmpeg command around filter_complex trim+concat.
   */
  cuts?: Cut[]
}

export interface BurninHandle {
  cancel: () => void
}

export async function startBurnin(
  opts: BurninOptions,
  onEvent: (event: BurninEvent) => void
): Promise<BurninHandle> {
  // REQ-0160 — per-row tofu substitution BEFORE the entries cross the
  // IPC boundary.  For each entry the "effective font" is the row's
  // own `fontId` override (when present and known) or the project
  // default `opts.fontId`.  Missing-glyph code points are swapped to
  // that font's picked tofu character so libass renders the same
  // visible characters the preview and overflow-calculator saw.
  //
  // The source `entry.text` is never mutated — the map below creates
  // shallow copies with the substituted `text` field only.
  //
  // REQ-0162 — **await every referenced font's cmap coverage BEFORE
  // substituting**.  Without this, a burn-in fired while a font was
  // still loading (or that had never been touched by the App-level
  // pre-loader because it was installed post-startup) would see
  // `getCmapCoverageFor(rowFontId) === null`, silently skip the
  // substitution for that row, and hand libass the raw text — which
  // then falls back to a system JP font and produces the exact
  // "tofu didn't work" symptom this REQ fixes.  The load is
  // deduplicated inside `loadSubtitleFontFor` (returns the in-flight
  // promise when one is running) so this is O(distinct fonts) worth
  // of awaits per burn-in.  Failures degrade gracefully — the row
  // falls through to legacy behaviour and the burn-in still runs.
  // REQ-0269 D-1 — build the installed-font predicate BEFORE running
  // per-row substitution so a burn-in fired against a project whose
  // rows request fonts from the (not-yet-downloaded) font set falls
  // back gracefully instead of libass ignoring the missing family and
  // silently switching to its default DirectWrite / fontconfig face.
  // The predicate is a Set snapshot taken once here — a font that
  // finishes downloading mid-burn-in won't retroactively affect this
  // run, which is the correct semantics (the ASS file was already
  // written).  Failure to enumerate falls open to "everything is
  // installed", which preserves pre-REQ-0269 behaviour.
  const installedSet = new Set<FontId>()
  try {
    const r = await listFonts()
    if (r.ok) {
      for (const f of r.data.fonts) {
        if (f.status === 'bundled' || f.status === 'installed') installedSet.add(f.id)
      }
    }
  } catch { /* fall open */ }
  const isInstalled = (id: FontId): boolean => installedSet.size === 0 || installedSet.has(id)

  // Resolve the project-level default AND every per-row override to an
  // installed font before we start the pipeline.  `resolveRenderableFontId`
  // keeps same-family same-weight when it can, walks to nearest weight
  // otherwise, and falls back to the bundled Noto SemiBold as the last
  // resort.  The renderer's `SubtitleOverlay` uses the exact same helper
  // for the preview, so preview↔burn-in stay in lockstep even when the
  // requested font set is missing.
  const resolvedProjectFontId = resolveRenderableFontId(opts.fontId, isInstalled)

  const referencedFontIds = new Set<FontId>()
  referencedFontIds.add(resolvedProjectFontId)
  for (const e of opts.entries) {
    const rowRequested: FontId = isFontId(e.fontId) ? e.fontId : opts.fontId
    referencedFontIds.add(resolveRenderableFontId(rowRequested, isInstalled))
  }
  await Promise.all(
    Array.from(referencedFontIds).map((id) =>
      loadSubtitleFontFor(id).catch(() => { /* row will fall through */ }),
    ),
  )

  const substitutedEntries: SubtitleEntry[] = opts.entries.map((e) => {
    const rowRequested: FontId = isFontId(e.fontId) ? e.fontId : opts.fontId
    const rowFontId: FontId = resolveRenderableFontId(rowRequested, isInstalled)
    const cmap = getCmapCoverageFor(rowFontId)
    const tofu = getTofuSubstituteFor(rowFontId)
    const substitutedText = (cmap !== null && tofu !== null)
      ? substituteMissingGlyphs(e.text, cmap, tofu)
      : e.text
    // Build a patch that ONLY writes fields when they actually change.
    // - fontId: only when the row had an explicit override AND that
    //   override was substituted.  Inherit rows (e.fontId undefined) stay
    //   inherit; the ass-generator picks up the fallback via opts.fontId
    //   which we've already resolved above.
    // - text: only when a code point had to be mapped to the tofu char.
    const rowNeedsFontSubst = e.fontId !== undefined && rowFontId !== e.fontId
    const textChanged = substitutedText !== e.text
    if (!rowNeedsFontSubst && !textChanged) return e
    const patch: Partial<SubtitleEntry> = {}
    if (rowNeedsFontSubst) patch.fontId = rowFontId
    if (textChanged) patch.text = substitutedText
    return { ...e, ...patch }
  })

  const result = await window.electronAPI.burninStart({
    inputPath: opts.inputPath,
    outputPath: opts.outputPath,
    entries: substitutedEntries,
    video: opts.video,
    burnin: opts.burnin,
    encoderSetting: opts.encoderSetting,
    audioMode: opts.audioMode,
    subtitleBackground: opts.subtitleBackground,
    outputContainer: opts.outputContainer,
    fontId: resolvedProjectFontId,
    cuts: opts.cuts
  })

  if (!result.ok) {
    throw new Error(result.error.message)
  }

  const { channelId } = result.data
  const unsub = window.electronAPI.subscribeToChannel(channelId, (payload) => {
    onEvent(payload as BurninEvent)
  })

  return {
    cancel: () => {
      unsub()
      window.electronAPI.burninCancel(channelId)
    }
  }
}

// Legacy sync-style stub kept for compatibility; not used in Phase 5+
export async function startBurninLegacy(_options: { inputPath: string; outputPath: string; assPath: string }): Promise<IpcResult<void>> {
  return { ok: false, error: { code: 'USE_START_BURNIN', message: 'Use startBurnin instead' } }
}
