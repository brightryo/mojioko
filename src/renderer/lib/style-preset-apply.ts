/**
 * REQ-0335 §3 — the geometry-dependent half of style presets.
 *
 * `shared/style-preset.ts` owns the types, the exhaustive field
 * classification and the system initial values.  This file owns the two
 * conversions that need the video frame size, because the anchor maths lives
 * in `renderer/lib/preview-coords.ts` and `shared/` must not import from
 * `renderer/`:
 *
 *   - SAVE:  absolute `\pos` (`posX` / `posY`) → offset from the cue's
 *            alignment anchor (`posOffsetX` / `posOffsetY`)
 *   - APPLY: offset → absolute `\pos` under the TARGET row's geometry
 *
 * Storing the offset rather than the absolute point is what lets a preset
 * saved on a 1920×1080 project land correctly on a 1080×1920 one — the same
 * reasoning `TranscriptionDefaults.posOffsetX/Y` already follows.
 */

import {
  PRESET_STORED_KEYS,
  clampPresetStyleValues,
  PRESET_OFFSET_TARGETS,
  STYLE_PRESET_VERSION,
  makeSystemStyleDefaults,
  type StylePreset,
  type StylePresetStyle,
} from '../../shared/style-preset'
import { resolveAnimation } from '../../shared/cue-animation'
import type { SubtitleEntry } from '../../shared/types'
import { getAnchorAssPosition } from './preview-coords'

/**
 * Frame size used for the offset ⇄ absolute conversion.  Both `undefined`
 * (no video loaded) means offsets cannot be resolved in either direction:
 * on save the offset is omitted, on apply the row stays on pure
 * alignment-based positioning.  Never produces `NaN`.
 */
export interface PresetGeometry {
  videoWidthPx: number | undefined
  videoHeightPx: number | undefined
}

function cloneValue<T>(value: T): T {
  return typeof structuredClone === 'function'
    ? structuredClone(value)
    : (JSON.parse(JSON.stringify(value)) as T)
}

/**
 * Snapshot the look of `entry` as a preset payload.
 *
 * Animation is stored RESOLVED (`resolveAnimation`) rather than raw.  A cue
 * that predates REQ-0323 carries no `animation*` field at all and animates
 * through the legacy `fadeDurationSec` migration branch; storing its raw
 * (absent) fields would produce a preset that shows "fade" in the inspector
 * yet applies as "no animation" on a target row whose own fade is 0.  The
 * resolved spec is exactly what the user sees, so that is what is saved.
 */
export function buildStylePresetStyle(
  entry: SubtitleEntry,
  geometry: PresetGeometry,
): StylePresetStyle {
  const out: Record<string, unknown> = {}
  for (const key of PRESET_STORED_KEYS) {
    const value = (entry as unknown as Record<string, unknown>)[key]
    // Deep-copy so the preset never shares object identity with the row it
    // was saved from (`subtitleBackground` is the only object today).
    out[key] = value !== null && typeof value === 'object' ? cloneValue(value) : value
  }

  // Animation, resolved.  Overwrites the raw values copied above.
  const anim = resolveAnimation(entry)
  out.animationType = anim.type
  out.animationInEnabled = anim.inEnabled
  out.animationOutEnabled = anim.outEnabled
  out.animationDurationSec = anim.durationSec
  out.animationDirection = anim.direction
  out.animationDistancePx = anim.distancePx
  out.animationStartScalePercent = Math.round(anim.startScale * 100)
  out.animationBlurPx = anim.blurMaxPx

  // `\pos` → anchor-relative offset.  An unpinned row (either coordinate
  // undefined) stores no offset at all, which applies as "unpinned".
  const { videoWidthPx, videoHeightPx } = geometry
  if (entry.posX !== undefined && entry.posY !== undefined && videoWidthPx && videoHeightPx) {
    const anchor = getAnchorAssPosition(
      entry.horizontalPosition,
      entry.verticalPosition,
      entry.verticalMarginPx,
      videoWidthPx,
      videoHeightPx,
    )
    out[PRESET_OFFSET_TARGETS.posX] = entry.posX - anchor.x
    out[PRESET_OFFSET_TARGETS.posY] = entry.posY - anchor.y
  }

  return out as StylePresetStyle
}

/** Mint a complete, named preset from a row. */
export function buildStylePreset(
  entry: SubtitleEntry,
  name: string,
  geometry: PresetGeometry,
  id?: string,
): StylePreset {
  return {
    id: id ?? newPresetId(),
    name: name.trim(),
    version: STYLE_PRESET_VERSION,
    createdAtMs: Date.now(),
    style: buildStylePresetStyle(entry, geometry),
  }
}

/** Collision-resistant preset id.  Same shape as the add-row id minting. */
export function newPresetId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? `preset-${crypto.randomUUID()}`
    : `preset-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Turn a preset into the patch to write onto a row.
 *
 * Every stored key is present in the result, so applying a preset always
 * lands the row on a fully determined look: a key the preset does not carry
 * (an older schema version) takes the SYSTEM INITIAL VALUE from
 * `makeSystemStyleDefaults()` — never the user's current
 * `TranscriptionDefaults`, which would make one preset render differently on
 * different machines (REQ-0335 §3-4).
 *
 * `words` and `emphasisSpans` are absent from the patch by construction
 * (they are classified `per-cue`), so the target row keeps its own — a
 * karaoke row given a preset keeps valid word timings and does not fall back
 * to even-split karaoke.
 */
export function resolveStylePresetPatch(
  preset: StylePreset,
  geometry: PresetGeometry,
): Partial<SubtitleEntry> {
  const system = makeSystemStyleDefaults() as unknown as Record<string, unknown>
  const style = preset.style as unknown as Record<string, unknown>
  const patch: Record<string, unknown> = {}

  for (const key of PRESET_STORED_KEYS) {
    const value = key in style ? style[key] : system[key]
    // Deep-copy so two rows given the same preset never share an object.
    patch[key] = value !== null && typeof value === 'object' ? cloneValue(value) : value
  }

  // REQ-0341 §3-1 — enforce value ranges HERE rather than at load.  Hydrate
  // validates only the envelope on purpose (a preset from a newer build may
  // carry keys this build does not know, and dropping them would corrupt the
  // file on the next save), which leaves a hand-edited `settings.json` free to
  // put `fontSizePx: 5000` in a preset.  Clamping on the way out keeps both
  // properties.  Only the fields with no clamp anywhere downstream are
  // touched; `PRESET_CLAMP_RULES` records the disposition of every stored key
  // and makes a new one a compile error.
  clampPresetStyleValues(patch)

  // Offset → absolute `\pos` under the TARGET geometry and the layout the
  // preset itself just wrote (not the row's previous anchor).
  const offX = style[PRESET_OFFSET_TARGETS.posX]
  const offY = style[PRESET_OFFSET_TARGETS.posY]
  const { videoWidthPx, videoHeightPx } = geometry
  let posX: number | undefined
  let posY: number | undefined
  if (
    typeof offX === 'number' &&
    typeof offY === 'number' &&
    Number.isFinite(offX) &&
    Number.isFinite(offY) &&
    videoWidthPx &&
    videoHeightPx
  ) {
    const anchor = getAnchorAssPosition(
      patch.horizontalPosition as SubtitleEntry['horizontalPosition'],
      patch.verticalPosition as SubtitleEntry['verticalPosition'],
      patch.verticalMarginPx as number,
      videoWidthPx,
      videoHeightPx,
    )
    posX = anchor.x + offX
    posY = anchor.y + offY
  }
  patch.posX = posX
  patch.posY = posY

  return patch as Partial<SubtitleEntry>
}
