/**
 * REQ-0468 — the SINGLE placement + layout resolution both `burn` and
 * `export_frame` run, so a still is a faithful preview of the burn and neither
 * command can grow a placement flag the other silently ignores.
 *
 * It takes the parsed CLI options + probed video + seeded entries and applies,
 * in the exact order `burn` always did:
 *   1. `--style` preset (REQ-0457 D12)
 *   2. per-cue style overrides `--font-size` / `--text-color` / `--outline-color`
 *      / `--outline` / `--weight` / `--margin-v` (REQ-0461)
 *   3. `--position` vertical override (REQ-0460)
 *   4. `--margin-x` / `--margin-y` / `--overflow` (REQ-0456/0461)
 *   5. `--resolution` / `--preset` canvas scaling (REQ-0447/0460)
 *   6. `layoutForBurn` (auto line-break at the OUTPUT width + vertical overflow
 *      guard)
 *
 * The overflow `error` mode is NOT thrown here — the caller decides (both throw
 * `SUBTITLE_OVERFLOW`), so this stays a pure resolver.  Extracted verbatim from
 * `burn.ts`, so the burn output is unchanged (guarded by cli-smoke + the new
 * preview==burn pixel gate); export_frame now shares it.
 */
import { ASS_MARGIN_LR_PX } from '../../shared/constants'
import { canUseKeywordEmphasisInTier } from '../../shared/emphasis'
import { isPackagedAsMsix, getCurrentProcessContext } from '../lib/msix'
import {
  layoutForBurn,
  type OverflowMode,
  type OverflowReport,
} from '../services/headless-layout'
import type { SubtitleEntry, VideoInfo } from '../../shared/types'
import type { FontId } from '../../shared/fonts'
import type { loadSettings } from '../services/settings-store'
import { optString, type ParsedArgs } from './args'
import { CliError, type CliWarning } from './output'
import { resolveDefaultSubtitleStyle, summarizeSubtitleStyle, type SubtitleStyleSummary } from './subtitle-style'
import { findStylePreset, applyStylePreset } from './style-preset-cli'
import { applyStyleOverrides, parseStyleOverrides } from './style-overrides'
import { resolveTarget, contentScaleFactor, scaleEntries } from './scale-video'

type AppSettings = Awaited<ReturnType<typeof loadSettings>>

const VERTICAL_POSITIONS = new Set<'top' | 'center' | 'bottom'>(['top', 'center', 'bottom'])
const OVERFLOW_MODES = new Set<OverflowMode>(['warn', 'shrink', 'error'])

/** Read an integer CLI option (first non-empty of `keys`), or undefined. */
export function optInt(opts: ParsedArgs['opts'], ...keys: string[]): number | undefined {
  const s = optString(opts, ...keys)
  if (s === undefined || s === '') return undefined
  const n = Number.parseInt(s, 10)
  return Number.isFinite(n) ? n : undefined
}

export interface ResolvedPlacement {
  /** Final entries: preset + overrides + position + scaling + auto-break + overflow guard. */
  entries: SubtitleEntry[]
  /** The RENDER video (post-`--resolution`/`--preset`).  Equals `video` when unscaled. */
  renderVideo: VideoInfo
  /** Target canvas for scaling, or undefined when the source resolution is kept. */
  scaleTo?: { w: number; h: number }
  resized: boolean
  /** Horizontal margin (`--margin-x`) — ASS MarginL/R + the wrap budget. */
  marginX: number
  /** Vertical overflow-safety budget (`--margin-y`, falls back to `--margin-v`). */
  marginY: number
  overflowMode: OverflowMode
  overflow: OverflowReport
  appliedStylePreset: string | null
  verticalPositionOverride?: 'top' | 'center' | 'bottom'
  /** The resolved style of a representative final cue (post-override/scale/layout). */
  subtitleStyle: SubtitleStyleSummary
  /**
   * REQ-0503 §3 — warnings that need BEFORE/AFTER state and so cannot be
   * derived from the final entries (which is all `no-op-warnings.ts` sees).
   * Currently: a style preset un-pinning cues that carried absolute positions.
   */
  warnings: CliWarning[]
}

/**
 * Resolve placement + layout.  Throws `CliError('USAGE', …)` on a malformed
 * `--position` / `--overflow` / `--resolution` / `--preset` / `--style`, exactly
 * as `burn` did.  Does not throw on overflow `error` — the caller inspects
 * `overflow.overflowCueCount` and raises `SUBTITLE_OVERFLOW` itself.
 */
export function resolvePlacementAndLayout(
  opts: ParsedArgs['opts'],
  video: VideoInfo,
  settings: AppSettings,
  fontId: FontId,
  inputEntries: SubtitleEntry[],
): ResolvedPlacement {
  let entries = inputEntries
  const warnings: CliWarning[] = []

  // 1) `--style` preset — SOURCE-pixel space (scaling happens after).
  const stylePresetName = optString(opts, 'style')
  let appliedStylePreset: string | null = null
  if (stylePresetName) {
    const preset = findStylePreset(settings.stylePresets ?? [], stylePresetName)
    if (!preset) {
      const names = (settings.stylePresets ?? []).map((p) => p.name).join(', ') || '(なし)'
      throw new CliError('USAGE', `スタイルプリセット "${stylePresetName}" が見つかりません。`, `利用可能: ${names}（GUI で保存）。`)
    }
    // REQ-0503 §3 — a preset carries position (as an anchor-relative offset,
    // `style-presets.md` §5), so applying one legitimately REPLACES `posX`/
    // `posY`. When the preset has no stored offset that replacement is
    // `undefined`, i.e. every pinned cue silently reverts to aligned layout.
    //
    // The overwrite is intended and documented, so it is NOT suppressed here —
    // but it is invisible in the result, and losing hand-placed positions is
    // not something a caller should discover from the pixels. Warn instead.
    const pinnedBefore = entries.filter((e) => !e.isDeleted && e.posX !== undefined && e.posY !== undefined)
    entries = applyStylePreset(entries, preset, { videoWidthPx: video.widthPx, videoHeightPx: video.heightPx })
    appliedStylePreset = preset.name
    const unpinned = pinnedBefore.filter((before) => {
      const after = entries.find((e) => e.id === before.id)
      return after !== undefined && (after.posX === undefined || after.posY === undefined)
    })
    if (unpinned.length > 0) {
      warnings.push({
        code: 'PRESET_CLEARED_POSITION',
        message: `スタイルプリセット "${preset.name}" は位置を含むため、${unpinned.length} 件の cue の固定座標が解除されました。`,
        detail: {
          cueCount: unpinned.length,
          preset: preset.name,
          reason: 'プリセットは位置をアンカーからのオフセットとして保持します。オフセットを持たないプリセットを適用すると整列配置に戻ります。',
          remedy: '固定座標を保ちたい場合は --style を使わず、個別のスタイルフラグで指定してください。',
        },
      })
    }
  }

  // 2) per-cue style overrides (REQ-0461) — explicit flags win over the preset.
  const styleOverrides = parseStyleOverrides(opts, fontId)
  const marginVFlag = styleOverrides.verticalMarginPx
  entries = applyStyleOverrides(entries, styleOverrides)

  // 3) `--position` vertical override (REQ-0460).
  const positionFlag = optString(opts, 'position')
  if (positionFlag && !VERTICAL_POSITIONS.has(positionFlag as 'top' | 'center' | 'bottom')) {
    throw new CliError('USAGE', `unknown --position: ${positionFlag}`, 'top|center|bottom')
  }
  const verticalPositionOverride = positionFlag ? (positionFlag as 'top' | 'center' | 'bottom') : undefined

  // 4) Resolve the output canvas FIRST, because the margins below live in
  // different coordinate spaces and one of them has to be converted.
  //
  // REQ-0503 §2 — the three margin flags are NOT interchangeable:
  //   `--margin-v` is a CUE FIELD in SOURCE pixels. It is written onto the
  //     entries and then scaled with everything else by `scaleEntries`.
  //   `--margin-y` is a BUDGET compared against the OUTPUT canvas height by
  //     `layoutForBurn`, so an explicit value is already in output pixels and
  //     must NOT be scaled.
  //   `--margin-x` is likewise output-space (wrap budget + ASS MarginL/R, and
  //     the ASS PlayRes is the output canvas).
  //
  // Each of those is right on its own. The bug was the FALLBACK: `--margin-y`
  // defaulted to the raw `--margin-v`, feeding a source-space number into an
  // output-space comparison. At 1920×1080 → shorts, `--margin-v 200` drew at
  // 113 output px while the overflow guard budgeted 200. Converting the
  // fallback keeps the intent ("default the budget to your margin") without
  // mixing spaces.
  const tgt = resolveTarget(optString(opts, 'resolution'), optString(opts, 'preset'))
  if (!tgt.ok) throw new CliError('USAGE', tgt.message, 'mojioko ... --preset shorts | --resolution 1080x1920')
  const scaleFactor = tgt.target
    ? contentScaleFactor(video.widthPx, video.heightPx, tgt.target.w, tgt.target.h)
    : 1

  const marginX = optInt(opts, 'margin-x') ?? ASS_MARGIN_LR_PX
  const marginY =
    optInt(opts, 'margin-y') ??
    (marginVFlag !== undefined ? Math.round(marginVFlag * scaleFactor) : ASS_MARGIN_LR_PX)
  const overflowMode = (optString(opts, 'overflow') || 'warn') as OverflowMode
  if (!OVERFLOW_MODES.has(overflowMode)) {
    throw new CliError('USAGE', `unknown --overflow: ${overflowMode}`, 'warn|shrink|error')
  }

  // 5) `--resolution` / `--preset` — pre-scale the canvas + cue pixel fields.
  let renderVideo: VideoInfo = video
  let scaleTo: { w: number; h: number } | undefined
  let resized = false
  if (tgt.target) {
    entries = scaleEntries(entries, scaleFactor)
    scaleTo = { w: tgt.target.w, h: tgt.target.h }
    renderVideo = { ...video, widthPx: tgt.target.w, heightPx: tgt.target.h }
    resized = true
  }

  // Apply the position override BEFORE layout so the overflow guard anchors from
  // the requested edge.  For `.mojioko` input an explicit flag wins.
  if (verticalPositionOverride) {
    entries = entries.map((e) => ({ ...e, verticalPosition: verticalPositionOverride, posY: undefined }))
  }

  // 6) auto line-break at the OUTPUT width + vertical overflow guard.
  const isMsix = isPackagedAsMsix(getCurrentProcessContext())
  const layout = layoutForBurn({
    entries,
    video: renderVideo,
    marginX,
    marginY,
    overflowMode,
    emphasisTierAllowed: canUseKeywordEmphasisInTier(isMsix),
  })
  entries = layout.entries

  // The resolved style of a representative final cue (post-override/scale/layout),
  // so the returned `subtitleStyle` is what is actually rendered (REQ-0461).
  const repEntry = entries.find((e) => !e.isDeleted)
  const subtitleStyle = repEntry
    ? summarizeSubtitleStyle(repEntry, settings.autoLineBreak ?? true)
    : resolveDefaultSubtitleStyle(settings)
  if (repEntry) subtitleStyle.fontId = repEntry.fontId ?? fontId

  return {
    entries,
    renderVideo,
    scaleTo,
    resized,
    marginX,
    marginY,
    overflowMode,
    overflow: layout.overflow,
    appliedStylePreset,
    verticalPositionOverride,
    subtitleStyle,
    warnings,
  }
}
