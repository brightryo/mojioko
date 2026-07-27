/**
 * REQ-0335 §3 — user-saved subtitle style presets.
 *
 * ## What a preset is
 *
 * A named snapshot of the LOOK of one cue, re-applicable to any other cue.
 * It deliberately carries no row-specific data: text, timecodes, per-word
 * timings (`words`) and the emphasised character spans (`emphasisSpans`)
 * belong to the row that authored them and would be actively harmful on a
 * different row — applying a preset that carried `words` would give the
 * target row karaoke timings for somebody else's sentence, and the
 * `areWordsValidForText` guard would then drop it to even-split karaoke.
 *
 * ## Why the classification map exists (the fifth instance)
 *
 * Same bug class as everywhere else in this codebase: *optional field +
 * explicit re-construction = silent drop.*
 *   1. `SETTINGS_MERGE_RULES`          (REQ-0312 §1) — settings merge
 *   2. `BURNIN_FIELD_DISPOSITION`      (REQ-0321 §1) — burn-in IPC payload
 *   3. `SUBTITLE_ENTRY_DUPLICATION`    (REQ-0322 §2) — row duplication
 *   4. `TRANSCRIPTION_DEFAULTS_TO_ENTRY` (REQ-0334 §2) — defaults → cue
 *   5. this module                     (REQ-0335 §3) — style presets
 *
 * All five fired for real before they were written.  The cure is the same
 * `{ readonly [K in keyof T]-?: Rule }` mapped type.  The `-?` is
 * load-bearing: without it the homomorphic mapped type keeps `?`, and a
 * forgotten OPTIONAL key still compiles — and EVERY style field added in
 * v1.3.6 is optional, so without `-?` this file would enforce nothing.
 *
 * Adding a field to `SubtitleEntry` without classifying it here is a `tsc`
 * error (TS1360, "Property '<name>' is missing").  Classifying it as
 * `store` without also giving it a system default in
 * `makeSystemStyleDefaults()` is a SECOND `tsc` error — the "classify but
 * forget to implement" path, closed the same way `RESOLVE_TARGETS` closes
 * it in `style-defaults-to-entry.ts`.
 *
 * ## Versioning and what "default" means (REQ-0335 §3-4)
 *
 * A preset carries a `version`.  A field the preset does not carry — because
 * it was saved before that field existed — falls back to the **SYSTEM
 * INITIAL VALUE**, never to the user's current `TranscriptionDefaults`.
 * Reading the user's defaults would make one and the same preset produce a
 * different look on a different machine, which is the opposite of what a
 * preset is for.  The system initial values are `BURNIN_DEFAULTS` /
 * `makeEntryLayoutDefaults()` for the fields a cue is REQUIRED to carry, and
 * `undefined` for every optional field — `undefined` being precisely the
 * value a freshly minted cue has, and the value every renderer documents as
 * its neutral "effect off" fallback.
 *
 * The geometry-dependent half (offset ⇄ absolute `\pos`) lives in
 * `renderer/lib/style-preset-apply.ts`, because the anchor maths is in
 * `renderer/lib/preview-coords.ts` and `shared/` must not import from
 * `renderer/`.  Types and classification stay here so `AppSettings` can
 * reference them.
 */

import { BURNIN_DEFAULTS, makeEntryLayoutDefaults } from './burnin-defaults'
import type { SubtitleEntry } from './types'

/** Schema version stamped onto every preset this build writes. */
export const STYLE_PRESET_VERSION = 1

/**
 * Upper bound on saved presets.  Presets ride inside `settings.json`, which
 * is read synchronously at startup, and the picker is a flat dropdown — both
 * degrade well before this number.  Hitting the cap is reported to the user
 * rather than silently dropping the oldest entry.
 */
export const STYLE_PRESET_MAX = 50

/** Maximum preset name length, in code units. */
export const STYLE_PRESET_NAME_MAX_LEN = 40

/**
 * How a `SubtitleEntry` field relates to a style preset.
 *
 * - `store`           — part of the look; saved in the preset under the SAME
 *                       key and written back verbatim on apply.
 * - `store-as-offset` — part of the look, but saved in a DIFFERENT shape:
 *                       the absolute `\pos` coordinates are stored as an
 *                       offset from the cue's alignment anchor so a preset
 *                       saved on a 1920×1080 project lands correctly on a
 *                       1080×1920 one.  `PRESET_OFFSET_TARGETS` names the
 *                       stored key for each.
 * - `per-cue`         — belongs to the row that authored it and must NOT
 *                       travel: text, timecodes, `words`, `emphasisSpans`
 *                       (and the two deprecated emphasis shapes), plus
 *                       `fadeDurationSec` — the legacy fade, which is
 *                       superseded on save by the RESOLVED animation fields
 *                       (`resolveAnimation` ignores it entirely once
 *                       `animationType` is set, which a preset always sets).
 * - `not-style`       — identity / bookkeeping (`id`, `isDeleted`,
 *                       `isEdited`, `original`).  `original` in particular
 *                       must survive a preset apply untouched, or "Reset
 *                       row" would start restoring the preset instead of the
 *                       transcribed look.
 */
export type PresetFieldRule = 'store' | 'store-as-offset' | 'per-cue' | 'not-style'

/**
 * Classification of every `SubtitleEntry` field.
 *
 * `per-cue` and `not-style` are spelled out rather than left absent — the
 * original bug in every prior instance of this pattern was invisible
 * precisely because "not carried" was an *absence* rather than a
 * *statement*.
 */
export const STYLE_PRESET_FIELDS = {
  // --- row-specific content: never travels ------------------------------
  startSec: 'per-cue',
  endSec: 'per-cue',
  text: 'per-cue',
  // Superseded by the resolved animation fields; see `PresetFieldRule`.
  fadeDurationSec: 'per-cue',
  // REQ-0335 §3-2 — the two fields the owner named explicitly.  Carrying
  // them would give the target row another sentence's word timings and
  // character offsets; karaoke would then fail `areWordsValidForText` and
  // fall back to even-split, and emphasis would land on the wrong glyphs.
  words: 'per-cue',
  emphasisSpans: 'per-cue',
  emphasisKeywords: 'per-cue',
  emphasizedWordIndices: 'per-cue',

  // --- typography -------------------------------------------------------
  fontId: 'store',
  fontSizePx: 'store',
  textColorHex: 'store',
  outlineColorHex: 'store',
  outlineThicknessPx: 'store',
  // --- style effects (REQ-0277 / REQ-0293 / REQ-0310 / REQ-0332) --------
  casing: 'store',
  rotation: 'store',
  shadowDepth: 'store',
  shadowColor: 'store',
  shadowAlpha: 'store',
  textAlpha: 'store',
  outlineAlpha: 'store',
  lineSpacingPercent: 'store',
  // --- layout + background box (REQ-20260613-016) -----------------------
  horizontalPosition: 'store',
  verticalPosition: 'store',
  verticalMarginPx: 'store',
  subtitleBackground: 'store',
  // --- 「オフセット」(REQ-20260615-033) ----------------------------------
  posX: 'store-as-offset',
  posY: 'store-as-offset',
  // --- karaoke (REQ-0286 / REQ-0322 §3) ---------------------------------
  // `karaokeStyle` IS included: REQ-0322 §3 made it per-cue, so a preset
  // that omitted it could not reproduce a sweep/switch choice.
  karaokeEnabled: 'store',
  karaokeHighlightColor: 'store',
  karaokeStyle: 'store',
  // --- keyword emphasis (REQ-0305 / REQ-0307) ---------------------------
  // The master toggle + colour + size are style; WHICH characters are
  // emphasised is `emphasisSpans`, classified `per-cue` above.
  keywordEmphasisEnabled: 'store',
  emphasisColorHex: 'store',
  emphasisScalePercent: 'store',
  // --- entrance / exit animation (REQ-0323 / REQ-0331) ------------------
  animationType: 'store',
  animationInEnabled: 'store',
  animationOutEnabled: 'store',
  animationDurationSec: 'store',
  // Dormant (slide is not offered — REQ-0334 §3) but stored anyway so the
  // classification has no arbitrary hole the day slide ships.
  animationDirection: 'store',
  animationDistancePx: 'store',
  animationStartScalePercent: 'store',
  animationBlurPx: 'store',

  // --- identity / bookkeeping -------------------------------------------
  id: 'not-style',
  isDeleted: 'not-style',
  isEdited: 'not-style',
  original: 'not-style',
} as const satisfies { readonly [K in keyof SubtitleEntry]-?: PresetFieldRule }

type Rules = typeof STYLE_PRESET_FIELDS

/** The entry fields carrying a given rule. */
export type PresetKeysWithRule<R extends PresetFieldRule> = {
  [K in keyof Rules]: Rules[K] extends R ? K : never
}[keyof Rules]

/** Fields stored under their own name. */
export type PresetStoredKey = PresetKeysWithRule<'store'>

/** The anchor-relative offsets a preset stores instead of absolute `\pos`. */
export interface StylePresetOffsets {
  /** Horizontal distance from the alignment anchor, in ASS px. */
  posOffsetX?: number
  /** Vertical distance from the alignment anchor, in ASS px. */
  posOffsetY?: number
}

/**
 * Which stored key each `store-as-offset` field feeds.
 *
 * Load-bearing, not documentation: classifying a NEW field as
 * `store-as-offset` without naming its stored key here is a `tsc` error.
 */
export const PRESET_OFFSET_TARGETS = {
  posX: 'posOffsetX',
  posY: 'posOffsetY',
} as const satisfies { readonly [K in PresetKeysWithRule<'store-as-offset'>]: keyof StylePresetOffsets }

/**
 * The payload of a preset.  Every field optional: a preset written by an
 * older build simply lacks the keys that build did not know about, and
 * `resolveStylePresetPatch` fills those from the system initial values.
 */
export type StylePresetStyle = Partial<Pick<SubtitleEntry, PresetStoredKey>> & StylePresetOffsets

/** A named, user-saved style preset as persisted in `settings.json`. */
export interface StylePreset {
  /** Stable id (uuid).  Rename keeps the id; the dropdown keys on it. */
  id: string
  /** User-visible name.  Trimmed, non-empty, ≤ `STYLE_PRESET_NAME_MAX_LEN`. */
  name: string
  /** Schema version of `style`; see `STYLE_PRESET_VERSION`. */
  version: number
  /** Epoch ms the preset was saved.  Used only for stable ordering. */
  createdAtMs: number
  style: StylePresetStyle
}

/**
 * The SYSTEM INITIAL VALUE of every stored field (REQ-0335 §3-4).
 *
 * A function rather than a const because `subtitleBackground` must be a
 * fresh object literal per call — otherwise two rows given the same preset
 * would share one background object and editing one would move the other
 * (the exact reason `makeEntryLayoutDefaults` is a factory).
 *
 * The mapped type is NOT homomorphic (`PresetStoredKey` is a computed union,
 * not `keyof SubtitleEntry`), so optionality is stripped and every stored
 * key MUST appear.  That is what closes the classify-but-forget-to-implement
 * path: `store` without a system default does not compile.
 *
 * `undefined` is the honest value for every optional field.  It is what a
 * freshly created cue carries and what every renderer resolves to its own
 * documented neutral ("no shadow", "opaque", "no rotation", …).  Writing a
 * concrete number here instead would silently invent a look the app has
 * never had.
 */
export function makeSystemStyleDefaults(): { [K in PresetStoredKey]: SubtitleEntry[K] } {
  const layout = makeEntryLayoutDefaults()
  return {
    // Required on a cue → concrete system values.
    fontSizePx: BURNIN_DEFAULTS.fontSizePx,
    textColorHex: BURNIN_DEFAULTS.textColorHex,
    outlineColorHex: BURNIN_DEFAULTS.outlineColorHex,
    outlineThicknessPx: BURNIN_DEFAULTS.outlineThicknessPx,
    horizontalPosition: layout.horizontalPosition,
    verticalPosition: layout.verticalPosition,
    verticalMarginPx: layout.verticalMarginPx,
    subtitleBackground: layout.subtitleBackground,
    // Optional on a cue → `undefined` = the renderer's neutral default.
    // `fontId: undefined` means "inherit the project font", which is what an
    // untouched row carries.
    fontId: undefined,
    casing: undefined,
    rotation: undefined,
    shadowDepth: undefined,
    shadowColor: undefined,
    shadowAlpha: undefined,
    textAlpha: undefined,
    outlineAlpha: undefined,
    lineSpacingPercent: undefined,
    karaokeEnabled: undefined,
    karaokeHighlightColor: undefined,
    karaokeStyle: undefined,
    keywordEmphasisEnabled: undefined,
    emphasisColorHex: undefined,
    emphasisScalePercent: undefined,
    animationType: undefined,
    animationInEnabled: undefined,
    animationOutEnabled: undefined,
    animationDurationSec: undefined,
    animationDirection: undefined,
    animationDistancePx: undefined,
    animationStartScalePercent: undefined,
    animationBlurPx: undefined,
  }
}

/** Every key classified `store`, as a runtime array. */
export const PRESET_STORED_KEYS: readonly PresetStoredKey[] = (
  Object.keys(STYLE_PRESET_FIELDS) as (keyof Rules)[]
).filter((k) => STYLE_PRESET_FIELDS[k] === 'store') as PresetStoredKey[]

// ---------------------------------------------------------------------------
// Name / cap validation (REQ-0335 §3-6)
// ---------------------------------------------------------------------------

export type PresetNameError = 'empty' | 'too-long' | 'duplicate' | 'cap-reached'

/**
 * Validate a name the user typed for a NEW preset.
 *
 * Rules, chosen so nothing is ever silently lost:
 *   - empty / whitespace-only is rejected (an unnamed preset is unusable in
 *     a dropdown, and auto-naming it "Preset 3" hides a typo);
 *   - duplicates are rejected rather than de-duplicated with a suffix — two
 *     rows in the picker reading the same thing is the failure mode a
 *     suffix scheme produces one keystroke later.  Comparison is
 *     case-insensitive and trim-insensitive;
 *   - over `STYLE_PRESET_MAX` is rejected with its own code so the UI can
 *     say "delete one first" rather than "bad name".
 */
export function validatePresetName(
  raw: string,
  existing: readonly StylePreset[],
  options?: { readonly ignoreId?: string },
): PresetNameError | null {
  const name = raw.trim()
  if (name.length === 0) return 'empty'
  if (name.length > STYLE_PRESET_NAME_MAX_LEN) return 'too-long'
  const folded = name.toLocaleLowerCase()
  for (const p of existing) {
    if (options?.ignoreId !== undefined && p.id === options.ignoreId) continue
    if (p.name.trim().toLocaleLowerCase() === folded) return 'duplicate'
  }
  if (options?.ignoreId === undefined && existing.length >= STYLE_PRESET_MAX) return 'cap-reached'
  return null
}
