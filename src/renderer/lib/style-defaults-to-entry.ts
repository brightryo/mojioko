/**
 * REQ-0334 §2-3 — the single projection of `TranscriptionDefaults` onto the
 * style fields of a `SubtitleEntry`.
 *
 * ## Why this exists
 *
 * Step 1's style dialog pairs the controls with a live preview
 * (`style-sample-preview.tsx`).  That preview built its sample entry by
 * listing fields by hand, and the list had drifted 14 fields behind
 * `TranscriptionDefaults`: `shadowDepth`, `shadowColor`, `shadowAlpha`,
 * `casing`, `rotation`, `lineSpacingPercent`, the layout triple
 * (`horizontalPosition` / `verticalPosition` / `verticalMarginPx`), the
 * offsets (`posOffsetX` / `posOffsetY`) and the emphasis trio.  Dragging
 * those sliders moved a control that the preview beside it ignored.
 *
 * Worse, the `useMemo` dependency array listed the same fields a SECOND
 * time, so even a corrected object literal would not have re-rendered.
 *
 * This is the **fourth** instance of one bug class in this codebase:
 * *optional field + explicit re-construction = silent drop.*
 *   1. `SETTINGS_MERGE_RULES`      (REQ-0312 §1) — settings merge
 *   2. `BURNIN_FIELD_DISPOSITION`  (REQ-0321 §1) — burn-in IPC payload
 *   3. `SUBTITLE_ENTRY_DUPLICATION` (REQ-0322 §2) — row duplication
 *   4. this module                 (REQ-0334 §2) — defaults → cue seeding
 *
 * The cure is the same `{ readonly [K in keyof T]-?: Rule }` mapped type.
 * The `-?` is load-bearing: without it the homomorphic mapped type keeps
 * `?`, and a forgotten OPTIONAL key still compiles.  Every style field
 * added since REQ-0295 is optional, so without `-?` this file would
 * enforce nothing.
 *
 * Adding a field to `TranscriptionDefaults` without classifying it here is
 * a `tsc` error (TS1360, "Property '<name>' is missing").
 *
 * ## Why it is shared rather than duplicated
 *
 * `step1.tsx` (production seeding, at transcription completion) and the
 * Step 1 preview now call the SAME function.  A classification is not
 * enough on its own — `fade-opacity.ts` claimed in its JSDoc to "mirror"
 * the ASS writer while actually re-deriving the value independently
 * (REQ-0320 §1).  Sharing the code, not the intent, is what makes
 * "the preview shows what will be burned in" structurally true.
 */

import { makeEntryLayoutDefaults } from '../../shared/burnin-defaults'
import type { SubtitleEntryOriginal, TranscriptionDefaults } from '../../shared/types'
import { getAnchorAssPosition } from './preview-coords'

/**
 * How a `TranscriptionDefaults` field reaches a newly created cue.
 *
 * - `copy`      — written verbatim onto the cue under the SAME key name.
 *                 `undefined` is written as `undefined`, so an untouched
 *                 setting leaves the cue field unset and every renderer
 *                 falls back to its own neutral default.
 * - `resolve`   — reaches the cue through a computed path: a fallback to
 *                 `makeEntryLayoutDefaults()`, or a rename
 *                 (`posOffsetX/Y` → absolute `posX/posY`).  `RESOLVE_TARGETS`
 *                 below names the cue field each one feeds.
 * - `animation` — owned by `animationFieldsForNewCue` in
 *                 `shared/cue-animation.ts`, which already exists as the one
 *                 place animation defaults are resolved.  Re-deriving them
 *                 here would recreate the two-implementations bug this file
 *                 exists to forbid.
 * - `not-style` — not part of the cue's look at all (`whisperModel`).
 */
export type StyleSeedRule = 'copy' | 'resolve' | 'animation' | 'not-style'

/**
 * Classification of every `TranscriptionDefaults` field.
 *
 * The `not-style` and `animation` variants are deliberately spelled out
 * rather than left absent — same reasoning as the (empty) `omit` variant in
 * `BURNIN_FIELD_DISPOSITION`: the original bug was invisible precisely
 * because "not seeded" was an *absence* rather than a *statement*.
 */
export const TRANSCRIPTION_DEFAULTS_TO_ENTRY = {
  // --- base typography -------------------------------------------------
  fontSizePx: 'copy',
  textColorHex: 'copy',
  outlineColorHex: 'copy',
  outlineThicknessPx: 'copy',
  // --- style effects (REQ-0293 / REQ-0277 / REQ-0310) ------------------
  shadowDepth: 'copy',
  shadowColor: 'copy',
  shadowAlpha: 'copy',
  textAlpha: 'copy',
  outlineAlpha: 'copy',
  casing: 'copy',
  rotation: 'copy',
  // --- karaoke (REQ-0293 §2) ------------------------------------------
  karaokeEnabled: 'copy',
  karaokeHighlightColor: 'copy',
  // --- keyword emphasis (REQ-0305) -------------------------------------
  // The master toggle + colour + size are defaults; per-word selection is
  // inherently per-cue (chosen in the inspector), so no spans are seeded.
  keywordEmphasisEnabled: 'copy',
  emphasisColorHex: 'copy',
  emphasisScalePercent: 'copy',
  // --- layout (REQ-0295) -----------------------------------------------
  // Optional in defaults, REQUIRED on the cue, so these need the
  // `makeEntryLayoutDefaults()` fallback rather than a raw copy.
  horizontalPosition: 'resolve',
  verticalPosition: 'resolve',
  verticalMarginPx: 'resolve',
  // REQ-0332 — line spacing (行間).  Optional on the cue too, so it copies.
  lineSpacingPercent: 'copy',
  // --- offset (REQ-0295 §1 「オフセット」) -------------------------------
  // Renamed on the way through: an offset from the alignment anchor becomes
  // an ABSOLUTE `posX` / `posY`, which needs the video dimensions.
  posOffsetX: 'resolve',
  posOffsetY: 'resolve',
  // --- entrance / exit animation (REQ-0325 §2) -------------------------
  animationType: 'animation',
  animationInEnabled: 'animation',
  animationOutEnabled: 'animation',
  animationDurationSec: 'animation',
  animationStartScalePercent: 'animation',
  animationBlurPx: 'animation',
  // --- not a look ------------------------------------------------------
  whisperModel: 'not-style',
} as const satisfies { readonly [K in keyof TranscriptionDefaults]-?: StyleSeedRule }

type Rules = typeof TRANSCRIPTION_DEFAULTS_TO_ENTRY

/** The default names carrying a given rule. */
type KeysWithRule<R extends StyleSeedRule> = {
  [K in keyof Rules]: Rules[K] extends R ? K : never
}[keyof Rules]

/**
 * Which cue field each `resolve` default feeds.
 *
 * Load-bearing, not documentation: the mapped type means classifying a NEW
 * default as `resolve` without naming its target here is a `tsc` error, and
 * the target must be a real `SubtitleEntry` field.  This is where the
 * `posOffsetX` → `posX` rename is written down instead of being buried in
 * the function body.
 */
export const RESOLVE_TARGETS = {
  horizontalPosition: 'horizontalPosition',
  verticalPosition: 'verticalPosition',
  verticalMarginPx: 'verticalMarginPx',
  posOffsetX: 'posX',
  posOffsetY: 'posY',
} as const satisfies { readonly [K in KeysWithRule<'resolve'>]: keyof SubtitleEntryOriginal }

/** The cue fields produced by the `copy` rule. */
type CopiedFields = Pick<SubtitleEntryOriginal, KeysWithRule<'copy'>>

/** The cue fields produced by the `resolve` rule. */
type ResolvedFields = Pick<SubtitleEntryOriginal, (typeof RESOLVE_TARGETS)[keyof typeof RESOLVE_TARGETS]>

/** Everything this module contributes to a new cue. */
export type StyleFieldsFromDefaults = CopiedFields & ResolvedFields

/**
 * Frame size used to turn `posOffsetX/Y` into an absolute `posX/posY`.
 * Both `undefined` (no video picked yet) means the offsets cannot be
 * resolved, and the cue stays on pure alignment-based positioning.
 */
export interface StyleSeedGeometry {
  videoWidthPx: number | undefined
  videoHeightPx: number | undefined
}

/**
 * Project the user's style defaults onto the style fields of a new cue.
 *
 * Pure — no store access.  Callers own the fields that are NOT defaults
 * (`startSec` / `endSec` / `text` / `fontId` / `words` / `fadeDurationSec`)
 * and the `subtitleBackground` sub-object, which must be a fresh literal
 * per row (`makeEntryLayoutDefaults()`).
 *
 * Spread this AFTER `makeEntryLayoutDefaults()` so the resolved layout
 * triple wins over the raw `BURNIN_DEFAULTS` one.
 */
export function styleFieldsFromDefaults(
  defaults: TranscriptionDefaults,
  geometry: StyleSeedGeometry,
): StyleFieldsFromDefaults {
  // `copy` fields are written even when `undefined` so the produced key set
  // does not depend on which settings the user has touched.  Every consumer
  // reads them as `field ?? <neutral>`, and a stable key set keeps a cue's
  // `original` snapshot shaped the same as its live fields.
  const copied: Record<string, unknown> = {}
  for (const [key, rule] of Object.entries(TRANSCRIPTION_DEFAULTS_TO_ENTRY)) {
    if (rule !== 'copy') continue
    copied[key] = (defaults as unknown as Record<string, unknown>)[key]
  }

  const layout = makeEntryLayoutDefaults()
  const horizontalPosition = defaults.horizontalPosition ?? layout.horizontalPosition
  const verticalPosition = defaults.verticalPosition ?? layout.verticalPosition
  const verticalMarginPx = defaults.verticalMarginPx ?? layout.verticalMarginPx

  // When both offsets are 0 (or unset), leave `posX` / `posY` undefined so
  // the cue uses pure alignment-based positioning and the ASS writer emits
  // no `\pos` tag — byte-identical to pre-REQ-0295 output.
  const offX = defaults.posOffsetX ?? 0
  const offY = defaults.posOffsetY ?? 0
  let posX: number | undefined
  let posY: number | undefined
  if ((offX !== 0 || offY !== 0) && geometry.videoWidthPx && geometry.videoHeightPx) {
    const anchor = getAnchorAssPosition(
      horizontalPosition,
      verticalPosition,
      verticalMarginPx,
      geometry.videoWidthPx,
      geometry.videoHeightPx,
    )
    posX = anchor.x + offX
    posY = anchor.y + offY
  }

  const resolved: ResolvedFields = {
    horizontalPosition,
    verticalPosition,
    verticalMarginPx,
    posX,
    posY,
  }

  return { ...(copied as unknown as CopiedFields), ...resolved }
}
