import type { SubtitleEntry, VideoInfo, BurninPosition, SubtitleBackground, IpcResult, EncoderSetting, AudioMode, OutputContainer } from '../../shared/types'
import type { BurninEvent } from '../../shared/ipc-contracts'
import { isFontId, type FontId } from '../../shared/fonts'
import type { Cut } from '../../shared/cuts'
import { substituteMissingGlyphs } from '../../shared/glyph-substitute'
import { getCmapCoverageFor, getTofuSubstituteFor, loadSubtitleFontFor } from '../lib/font-metrics'

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
  const referencedFontIds = new Set<FontId>()
  referencedFontIds.add(opts.fontId)
  for (const e of opts.entries) {
    if (isFontId(e.fontId)) referencedFontIds.add(e.fontId)
  }
  await Promise.all(
    Array.from(referencedFontIds).map((id) =>
      loadSubtitleFontFor(id).catch(() => { /* row will fall through */ }),
    ),
  )

  const substitutedEntries: SubtitleEntry[] = opts.entries.map((e) => {
    const rowFontId: FontId = isFontId(e.fontId) ? e.fontId : opts.fontId
    const cmap = getCmapCoverageFor(rowFontId)
    const tofu = getTofuSubstituteFor(rowFontId)
    if (cmap === null || tofu === null) return e
    const substituted = substituteMissingGlyphs(e.text, cmap, tofu)
    // substituteMissingGlyphs returns the original reference when no
    // work was needed — skip the allocation of a copy when unchanged.
    if (substituted === e.text) return e
    return { ...e, text: substituted }
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
    fontId: opts.fontId,
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
