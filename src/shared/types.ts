import type { WhisperModelId } from './burnin-defaults'
import type { FontId } from './fonts'
// REQ-0307 — the emphasis storage shape lives with its resolution logic in
// `emphasis.ts`.  Type-only, so this does not create a runtime import cycle.
import type { EmphasisSpan } from './emphasis'
import type { KaraokeStyle } from './karaoke-style'
import type { AnimationType, AnimationDirection } from './cue-animation'
// REQ-0335 §3 — style presets live with their field classification in
// `style-preset.ts`.  Type-only (that module imports `SubtitleEntry` back),
// so this does not create a runtime import cycle — same shape as `emphasis`.
import type { StylePreset } from './style-preset'
import type { TranslationToolId } from './translation-tools'
export type { WhisperModelId }

// ---------------------------------------------------------------------------
// Video / Audio
// ---------------------------------------------------------------------------

export interface AudioTrack {
  /** 1-based index matching user-facing display. */
  index: number
  channels: 'mono' | 'stereo' | string
  sampleRateHz: number
  codec: string
  language?: string
}

export interface VideoInfo {
  path: string
  /**
   * REQ-027/028: `false` for audio-only inputs (mp3 / wav / m4a / aac /
   * flac / ogg).  When false, `widthPx` / `heightPx` / `fps` / `videoCodec`
   * are placeholders (0 / '') with no meaning — callers must check this
   * flag before reading them.  Existing video flows that read these
   * fields unconditionally continue to work for video inputs because
   * those still set the flag to `true`.
   */
  hasVideoStream: boolean
  widthPx: number
  heightPx: number
  durationSec: number
  fps: number
  container: 'mp4' | 'mkv' | string
  videoCodec: string
  audioTracks: AudioTrack[]
  fileSizeBytes: number
}

// ---------------------------------------------------------------------------
// Subtitles
// ---------------------------------------------------------------------------

export interface SubtitleEntryOriginal {
  startSec: number
  endSec: number
  text: string
  /** Integer, 30–600 px. */
  fontSizePx: number
  textColorHex: string
  outlineColorHex: string
  outlineThicknessPx: number
  /**
   * REQ-20260615-050 — per-entry fade ramp duration in seconds.
   *
   * Range: `[0, 0.5]`, step 0.1.  Semantics: **`0` means no fade**
   * (the ASS writer skips `\fad`, the preview rAF skips the opacity
   * ramp), `0.1`–`0.5` is the in/out duration applied symmetrically
   * (same value for fade-in and fade-out, matching libass `\fad(t,t)`).
   *
   * Replaces the legacy boolean `fadeEnabled` + global setting pair —
   * the migration path on store hydrate seeds this from the old
   * `fadeEnabled ? settings.fadeDurationSec : 0`.  New entries copy
   * `settings.fadeDurationSec` at creation time so the consolidated
   * General-tab slider IS the "default for new entries".
   */
  fadeDurationSec: number
  /**
   * Optional per-row font override.  When undefined, the row inherits the
   * project default (`useSettingsStore.activeFontId`) — both for preview
   * width measurement and for ASS `\fn` emission at burn-in time.  Stored
   * here (rather than only on the live entry) so the "Reset row" button
   * has a stable per-row reference point.  REQ-021.
   */
  fontId?: FontId
  /**
   * Per-row subtitle layout (REQ-20260613-016 / v1.2.2 機能A).
   *
   * Required (not optional) because the v1.2.2 data model is "作成時コピー
   * 方式" — every entry carries its own concrete values, no global
   * fallback at render time.  All entry-creation sites (fixtures, Step 2
   * add-row dialog, transcription segment mapping, duplicateRow,
   * style-sample-preview) seed from `ENTRY_LAYOUT_DEFAULTS` in
   * `shared/burnin-defaults.ts`.
   */
  horizontalPosition: 'left' | 'center' | 'right'
  /**
   * REQ-0140 — widened from `'top' | 'bottom'` (CLAUDE.md §21 protected
   * `SubtitleEntry` field, owner-approved 2026-07-08).  When `'center'`
   * the entry ignores `verticalMarginPx` (libass `\an4/5/6` anchors at
   * the vertical middle regardless of MarginV), and the inspector /
   * bulk-edit margin input is disabled with an explanatory tooltip.
   * `'top'` / `'bottom'` retain their pre-REQ-0140 semantics.
   */
  verticalPosition: 'top' | 'center' | 'bottom'
  verticalMarginPx: number
  /**
   * Per-row subtitle background (REQ-20260613-016 / v1.2.2 機能A).
   *
   * Same "作成時コピー方式" — required concrete value seeded from
   * `ENTRY_LAYOUT_DEFAULTS.subtitleBackground` at creation time.
   */
  subtitleBackground: SubtitleBackground
  /**
   * Free-position override (REQ-20260613-016 / v1.2.2 機能B).
   *
   * ASS coordinate space (= output video pixel space, same as
   * PlayResX/Y).  When both `posX` and `posY` are defined the row is
   * pinned at that point via `\pos(x,y)` and the alignment / MarginV
   * fields above are ignored on burn-in.  Independently undefined →
   * row uses alignment-based layout.  `\pos` is set/cleared as a pair;
   * see ass-generator and subtitle-overlay for the consumption sites.
   */
  posX?: number
  posY?: number
  /**
   * REQ-0332 — line spacing (行間) for a multi-line cue, as a percentage OF
   * `fontSizePx`.  Range −50 … +100; `undefined` and `0` are the same thing
   * and reproduce today's output EXACTLY (pinned by
   * `ass-generator-baseline-ac1fd67.test.ts`).
   *
   * The natural pitch libass uses for a `\N` inside one Dialogue event is
   * `fontSizePx` itself (measured — REQ-20260614-001 補遺⑳, re-measured in
   * REQ-0332 §6), so the field multiplies that: pitch = `fontSizePx ×
   * (1 + lineSpacingPercent/100)`.  There is deliberately no `libassScale`
   * in it; see `shared/line-spacing.ts`.
   *
   * ASS has no line-spacing tag and `ass_set_line_spacing()` is not exposed
   * by ffmpeg, so a non-zero value makes the writer emit ONE EVENT PER
   * DISPLAY LINE with an explicit `\pos`.  That takes the cue out of libass's
   * collision detection, which is why a split cue drags its whole
   * simultaneously-visible group onto self-computed positions
   * (`shared/stack-offsets.ts`).  Ignored for a single-line cue — there is no
   * gap to change, so no split happens and nothing about the output moves.
   */
  lineSpacingPercent?: number
  /**
   * REQ-0392 (positioning-redesign Phase 2) — z-order.  Higher = nearer the
   * front (drawn on top).  Additive field, `undefined` ≡ `0` — read everywhere
   * through `resolveLayer` (mirrors `lineSpacingPercent` / `resolveLineSpacingPercent`).
   *
   * Maps to the ASS Dialogue **Layer** column on burn-in and to the overlay's
   * CSS `z-index` in the preview; within one layer the tie-break is emission /
   * DOM order (later on top), so a new or duplicated cue — appended after its
   * peers — still paints in front at the default layer 0 (the Phase 1b default,
   * unchanged).  `\pos` (positioning) and Layer (z-order) are orthogonal.
   *
   * z-order is a POSITION attribute, so it is deliberately NOT carried by a
   * style preset (a preset must not reshuffle front/back — REQ-0392 §1).
   */
  layer?: number

  // ---------------------------------------------------------------------------
  // REQ-0277 Phase A — additional per-row style effects.  All optional +
  // neutral default so existing project files (pre-REQ-0277) hydrate as
  // "effect off" without any migration.  Renderers (ass-generator + CSS
  // preview) treat `undefined` identically to "off" / neutral value.
  // ---------------------------------------------------------------------------
  /**
   * REQ-0277 §1 — display-only casing transform.  `'uppercase'` renders
   * the text in ALL CAPS at burn-in + preview time WITHOUT mutating the
   * stored transcript.  SRT export uses the original text unchanged.
   * Latin-only in effect; CJK has no case.  `undefined` = `'none'`.
   */
  casing?: 'none' | 'uppercase'
  /**
   * REQ-0277 §2 — drop shadow.  ASS `\shad<depth>` + `\4c` + `\4a`.
   * libass draws shadows at a fixed bottom-right offset (there is no
   * angle control in ASS); the depth in px is the offset magnitude.
   *
   * REQ-0293 §1 — the shadow's ON/OFF is now encoded in the depth
   * itself: `undefined` OR `0` = disabled (no `\shad` / `\4c` / `\4a`
   * emitted at all, and no CSS text-shadow), `> 0` = shadow drawn.
   * The pre-REQ-0293 `shadowEnabled` boolean was removed because it
   * duplicated the "depth is 0" state and made the UI need a Switch
   * *and* a slider for what is really one control.  Legacy dev
   * project files that carried `shadowEnabled` still hydrate cleanly
   * — the unknown field is silently dropped, and rendering falls
   * back to the depth alone.  Range: 0–`SHADOW_DEPTH_MAX_PX` (= 50).
   */
  shadowDepth?: number
  /** `#RRGGBB`; default `#000000`. */
  shadowColor?: string
  /** Integer 0-100 (opacity %; higher = more opaque).  Default `100`. */
  shadowAlpha?: number
  /**
   * REQ-0310 — opacity of the TEXT FILL, 0–100 % (higher = more opaque).
   * `undefined` = 100 (fully opaque), which emits no ASS alpha tag at all, so
   * a cue that never touched the control renders byte-identically to
   * pre-REQ-0310.
   *
   * Which ASS colour this modifies depends on karaoke, because the two
   * features share the same colour slots: karaoke OFF → `\1a`
   * (PrimaryColour = the fill); karaoke ON → `\2a` (SecondaryColour = the
   * UNSPOKEN half).  The spoken half is never given an alpha, so setting this
   * to 0 with karaoke on makes each word appear as it is spoken — the effect
   * this field was added for.  0 is intentionally legal and never clamped
   * away (REQ-0310 §2).
   */
  textAlpha?: number
  /**
   * REQ-0310 — opacity of the OUTLINE, 0–100 % (higher = more opaque).
   * `undefined` = 100.  Always maps to `\3a`, regardless of karaoke.
   *
   * On a row with a background box the box is itself painted with `\3c`/`\3a`,
   * so the box's own opacity still wins (its tags are emitted later on a
   * last-write-wins basis) — REQ-0310 must not change existing box behaviour.
   */
  outlineAlpha?: number
  // REQ-0278 — glow (glowEnabled / glowRadius / glowColor) was
  // removed here.  See SPECIFICATION.md §11: reason was "colour is
  // the essence of a glow effect but the colour picker never made
  // it into the UI, so the shipped feature had a white-only halo
  // that was less useful than promised."  Fields deleted rather
  // than deprecated because no released version persisted them —
  // pre-REQ-0278 project files do not carry these keys, and any
  // legacy JSON that hypothetically does will hit the standard
  // "unknown key on parse" tolerance (see project-store hydrate)
  // and be silently ignored.
  /**
   * REQ-0277 §4 — clockwise text rotation in degrees, 0-360.  ASS
   * `\frz<deg>`.  Preview: CSS `transform: rotate(<deg>deg)` with
   * `transform-origin: center`.  `undefined` = `0` (no rotation).
   *
   * Note (from REQ): libass measures degrees COUNTER-clockwise on the
   * `\frz` axis but our UI convention is clockwise (standard CSS/user
   * expectation).  ass-generator negates the value before emitting.
   */
  rotation?: number

  /**
   * REQ-0286 Phase B — karaoke / per-word highlight.  When
   * `karaokeEnabled === true` AND the tier gate
   * (`canUseKaraokeInTier(isMsix)`) allows AND
   * `areWordsValidForText(words, text)` holds, the burn-in path emits
   * ASS `\k` tags and the preview highlights each word as its
   * timestamp is reached.  Any of those three failing → the cue
   * falls back to plain rendering (see the fallback contract in
   * REQ-0286 §0).
   *
   * Colour resolution:
   *   - `karaokeHighlightColor` unset → `KARAOKE_DEFAULT_HIGHLIGHT_COLOR`
   *     (yellow accent).  Also seeded into this field when the user
   *     toggles karaoke ON via inspector / bulk-edit so the picker has
   *     a starting swatch.
   *   - Base (unspoken/future) colour is ALWAYS `entry.textColorHex`
   *     (REQ-0293 §2).  The pre-REQ-0293 `karaokeBaseColor` per-cue
   *     override was removed — the owner-facing model is now "pick
   *     the accent colour; unspoken text stays the cue's own colour."
   *     This makes editing `textColorHex` also update the karaoke
   *     base half in one step (no divergence surface).  Legacy dev
   *     saves carrying `karaokeBaseColor` still hydrate — the
   *     unknown field is silently dropped, and rendering falls back
   *     to `textColorHex` for the base.
   *
   * When karaoke is off the fields are ignored and the cue uses
   * `textColorHex` as usual.
   *
   * `undefined` / `false` on `karaokeEnabled` = disabled (default) —
   * pre-REQ-0286 project files load with no karaoke behaviour, matching
   * the additive-optional contract every Phase A/B field follows.
   */
  karaokeEnabled?: boolean
  /** `#RRGGBB` — spoken/past words (maps to ASS PrimaryColour when karaoke on). */
  karaokeHighlightColor?: string

  /**
   * REQ-0322 §3 — per-cue karaoke animation style.
   *
   *   - `'switch'` — ASS `\k`: each word flips to the highlight colour at
   *     its own start.  Two discrete states per word, no intermediate frame.
   *   - `'sweep'`  — ASS `\kf`: the highlight wipes across each word over
   *     its speech duration.  Continuous.
   *
   * `undefined` = **follow the new-cue default**
   * (`useSettingsStore.karaokeStyle`, itself defaulting to
   * `KARAOKE_STYLE_DEFAULT` = `'sweep'`).  Resolve with
   * `resolveKaraokeStyle(entry.karaokeStyle, fallback)` — never with
   * `coerceKaraokeStyle`, which collapses `undefined` to a hard-coded
   * default and would freeze today's choice into every untouched cue.
   *
   * Deliberately NOT seeded at cue-creation time (unlike the v1.2.2
   * layout fields' 作成時コピー方式): staying `undefined` is what makes
   * the settings value behave as a *default* rather than a one-shot
   * stamp — changing it still moves every cue the user never touched.
   * Pre-REQ-0322 project files therefore need no migration.
   *
   * Ignored entirely when `karaokeEnabled` is not true.
   */
  karaokeStyle?: KaraokeStyle

  /**
   * REQ-0336 §2 — 「発話タイミング」: use this cue's real per-word timings
   * (`words`) for the karaoke sweep, or split the cue's window evenly across
   * its characters.
   *
   * `undefined` = **use the real timings whenever they are usable**, which is
   * exactly the pre-REQ-0336 behaviour — existing projects look unchanged and
   * no migration runs.  `false` is the user's explicit opt-out; `true` is what
   * the toggle writes when switched back on (identical in effect to
   * `undefined`).
   *
   * This field only expresses the USER'S CHOICE.  Whether the real timings are
   * usable at all is derived from the data — `words` present, still matching
   * `text`, and the cue's times unchanged from `original` — by
   * `karaokeWordTimingBlocker` in `shared/karaoke-timing.ts`.  Never re-derive
   * either half at a call site: `resolveKaraokeTiming(entry)` combines them and
   * is what both the preview and the ASS writer read.
   *
   * Ignored entirely when `karaokeEnabled` is not true.
   */
  karaokeUseWordTimings?: boolean

  // ---------------------------------------------------------------------------
  // REQ-0323 §1-5 (Phase C) — entrance / exit animation.  Additive and
  // optional; a cue with none of these set animates exactly as it did
  // before this REQ (see `resolveAnimation` for the `fadeDurationSec`
  // migration), and the ASS writer emits nothing extra for it, so
  // pre-REQ-0323 projects burn byte-identically.
  //
  // The geometry and timing live in `shared/cue-animation.ts`, which BOTH
  // the preview rAF loop and the ASS writer read.  Do not re-derive the
  // curves at a call site.
  // ---------------------------------------------------------------------------
  /**
   * Which entrance/exit animation this cue uses.  `undefined` means "not
   * chosen yet" and routes through the legacy `fadeDurationSec`
   * translation in `resolveAnimation` — it is NOT the same as `'none'`,
   * which is an explicit "no animation" the user picked.
   */
  animationType?: AnimationType
  /** Animate on the way in.  `undefined` = true. */
  animationInEnabled?: boolean
  /** Animate on the way out.  `undefined` = true. */
  animationOutEnabled?: boolean
  /** Ramp length in seconds, 0–1 (`ANIMATION_DURATION_*`). */
  animationDurationSec?: number
  /** Slide direction (REQ-0323 §3).  Ignored by the other types. */
  animationDirection?: AnimationDirection
  /** Slide distance in ASS px, 0–200 (REQ-0323 §3).  Ignored otherwise. */
  animationDistancePx?: number
  /**
   * REQ-0331 §1-3 — the scale the cue STARTS from for `scale` / `pop`, in
   * percent of natural size (`ANIMATION_START_SCALE_*`).  `undefined` =
   * the per-type default (`defaultStartScalePercent`), which is what every
   * pre-REQ-0331 cue is, so their look is unchanged.
   *
   * ★ REQ-0337 §2-3 — this is a START SCALE, where SMALLER means a BIGGER
   * movement.  The UI shows the inverse (`100 − this`) so 「強さ」 runs the
   * same way round as blur's, but nothing outside the control converts:
   * the stored meaning, the curves and the ASS writer are unchanged.
   */
  animationStartScalePercent?: number
  /**
   * REQ-0331 §1-3 — "強さ" for `blur`: peak blur radius in ASS px
   * (`ANIMATION_BLUR_*`).  `undefined` = `BLUR_MAX_PX`.  REQ-0337 §2-4
   * moved the range to 20–40 (default 30); cues holding the earlier 8 are
   * clamped up by `resolveAnimation`, never by the UI.
   */
  animationBlurPx?: number

  /**
   * REQ-0285 Phase B foundation — per-word timestamps captured by
   * faster-whisper at transcribe time.  Absolute video seconds (same
   * axis as `startSec` / `endSec`).  `text` retains faster-whisper's
   * leading space where present (`" hello"`) so a future re-tokenise
   * has the raw input.
   *
   * `undefined` means "no per-word data available for this row" — either
   * a pre-REQ-0285 project file, or the entry was created outside a
   * fresh transcribe (Add row, project import).  REQ-0288 removed the
   * pre-existing "text edit clears words" behaviour, so `undefined`
   * is NO LONGER produced by text mutations — words persist through
   * every edit and the render-time `areWordsValidForText` predicate
   * decides whether they're currently usable.  Empty array (`[]`)
   * means "words WERE captured but the segment contained no timed
   * word tokens" (silence-only chunk); Phase B visual features treat
   * empty identically to undefined and fall back to plain rendering.
   *
   * Validity: use `areWordsValidForText(words, text)` from
   * `src/shared/words-validity.ts` before consuming.  A cue whose
   * `words` textual concatenation no longer matches `text` (project
   * file was edited by hand, cue was split/merged without clearing
   * words) MUST fall back to plain rendering — the visual features
   * cannot safely animate mis-aligned word data.
   *
   * NOT reset on the row's Reset button — `original.words` mirrors
   * `words` at creation time exactly like every other original-snapshot
   * field, so Reset row also restores the initial word data.
   */
  words?: WordSpan[]

  /**
   * REQ-0305 Phase B / REQ-0307 — Hormozi-style keyword emphasis.  Additive,
   * optional, default-OFF (mirrors the karaoke fields above).  When
   * `keywordEmphasisEnabled` is true, the character spans listed in
   * `emphasisSpans` are rendered in `emphasisColorHex` at
   * `emphasisScalePercent` % of `fontSizePx`.
   *
   * `undefined` / `false` = disabled (pre-REQ-0305 project files load with no
   * emphasis behaviour).  Emphasis does NOT consult `words` in any way
   * (REQ-0306 §1 / REQ-0307 §3): it works on cues with no or invalid per-word
   * data, and survives text edits.
   *
   * REQ-0306 §3 coexistence with karaoke: when BOTH are on, the emphasised
   * text grows AND recolours to `emphasisColorHex` when spoken (the karaoke
   * sweep still animates it; its *spoken* colour becomes the emphasis colour
   * instead of the karaoke highlight — owner-confirmed 2026-07-26).  REQ-0307
   * §4 extends that to spans which straddle `\k` block boundaries: the span is
   * split at the boundary so timing and emphasis coexist.
   */
  keywordEmphasisEnabled?: boolean
  /** `#RRGGBB` — colour applied to emphasised text. */
  emphasisColorHex?: string
  /** Emphasised-text font size as a percent of `fontSizePx` (e.g. 130 = 1.3×). */
  emphasisScalePercent?: number
  /**
   * REQ-0307 — emphasised character spans, chosen per character in the
   * emphasis picker dialog.  Each span carries `{ start, end }` (code-unit
   * offsets into `text`) AND `text` (the anchor substring), so the exact
   * occurrence the user picked is emphasised even when the same substring
   * appears elsewhere in the cue, while a text edit re-anchors rather than
   * silently emphasising the wrong glyphs.  See `shared/emphasis.ts`
   * `resolveEmphasisSpans` for the three-step resolution order.
   *
   * An empty array = "on the current model, nothing selected".  `undefined` =
   * fall back to the legacy `emphasisKeywords` / `emphasizedWordIndices`,
   * migrated on read by `resolveEmphasis`; if both are absent, no emphasis.
   */
  emphasisSpans?: EmphasisSpan[]
  /**
   * @deprecated REQ-0306 keyword-substring emphasis, superseded by
   * `emphasisSpans` (REQ-0307) because a repeated keyword emphasised every
   * occurrence with no way to pick one.  Retained only so legacy dev saves
   * parse and migrate; never written by new code.
   */
  emphasisKeywords?: string[]
  /**
   * @deprecated REQ-0305 word-index emphasis, superseded by
   * `emphasisKeywords` (REQ-0306) then `emphasisSpans` (REQ-0307).  Retained
   * only so legacy dev saves parse and migrate; never written by new code.
   * 0-based indices into `words`.
   */
  emphasizedWordIndices?: number[]
}

/**
 * REQ-0285 — per-word timing.  Single source of truth: this file.
 * `ipc-contracts.ts` re-exports the same symbol so the sidecar's
 * `segment` event and `SubtitleEntry.words` share one declaration
 * (no shape drift between wire and domain).
 *
 * Semantics:
 *   - `startSec` / `endSec`: absolute video seconds, same axis as
 *     `SubtitleEntry.startSec` / `endSec`.
 *   - `text`: retains faster-whisper's leading space where present
 *     (`" hello"`).  Visual renderers should trim per-render if they
 *     display the word standalone; concatenation `.join('')` of a full
 *     `words[]` reproduces the original transcript spacing.
 */
export interface WordSpan {
  startSec: number
  endSec: number
  text: string
}

export interface SubtitleEntry extends SubtitleEntryOriginal {
  /** Stable UUID — survives reordering. Display index recomputed at render time. */
  id: string

  /**
   * REQ-0400 — stable, human-readable display number for the cue ("字幕ID").
   * The internal `id` is a UUID (unfriendly + hard to tell a duplicate from its
   * source), so this additive field carries a small integer the inspector shows.
   *
   * Assigned once at creation in `assignCueNumbers` (`shared/cue-number.ts`),
   * funnelled through the store's `setEntries` / `addEntry`, and monotonic per
   * project — it is NOT the list-order index (sorting or filtering never changes
   * it) and a duplicate always gets a fresh number so it is distinguishable.
   * Persists verbatim with the entry (project file), so it is stable across
   * reloads; legacy projects (field absent) are back-filled in array order on
   * load.  Optional so pre-REQ-0400 files hydrate without migration.
   */
  cueNumber?: number

  isDeleted: boolean
  /** True when any field diverges from `original`. */
  isEdited: boolean

  /** Snapshot of original values for the row Reset button. */
  original: SubtitleEntryOriginal
}

/** Row state priority: deleted > overflow > edited > normal. */
export type RowState = 'normal' | 'edited' | 'overflow' | 'deleted'

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------

export interface TranscriptionDefaults {
  /** Integer, 30–600 px. */
  fontSizePx: number
  textColorHex: string
  outlineColorHex: string
  outlineThicknessPx: number
  whisperModel: WhisperModelId

  // ------------------------------------------------------------------
  // REQ-0295 — Phase A / Phase B style defaults exposed via the
  // Settings > "字幕スタイル" tab (DefaultStyleControls).  All optional
  // + neutral-default so pre-REQ-0295 saved settings hydrate as
  // "no effect / off / neutral value" without migration.  Every new
  // field maps 1:1 to a per-cue field on `SubtitleEntry`; entry
  // creation in `step1.tsx` copies these onto each transcribed row
  // (via the same `runDefaults` snapshot used for the four legacy
  // style fields above).
  // ------------------------------------------------------------------

  /**
   * REQ-0293 §1 — default drop-shadow depth (0–50 px).  `0` = no
   * shadow (matches the shadow ON/OFF encoded in the depth itself).
   * `undefined` on load = 0 (no shadow) so pre-REQ-0295 setups keep
   * their shadowless look.
   */
  shadowDepth?: number
  /** Default drop-shadow colour, `#RRGGBB`.  `undefined` = `#000000`. */
  shadowColor?: string
  /** Default drop-shadow opacity (0–100 %).  `undefined` = `100`. */
  shadowAlpha?: number
  /**
   * REQ-0310 — default text-fill / outline opacity for new cues (0–100 %).
   * `undefined` = `100` (fully opaque), so pre-REQ-0310 saved settings hydrate
   * without migration and keep the existing look.  Seeded verbatim into every
   * transcribed row, `undefined` included, so an untouched setting leaves the
   * cue field unset too.
   */
  textAlpha?: number
  outlineAlpha?: number

  /**
   * REQ-0293 §2 — default karaoke toggle for new cues.  When `true`,
   * every transcribed row is created with `karaokeEnabled: true`.
   * `undefined` = OFF.  Base (unspoken) colour is ALWAYS
   * `textColorHex` (per REQ-0293), so there is no default for base;
   * only the highlight colour is user-configurable.
   */
  karaokeEnabled?: boolean
  /** Default karaoke highlight (spoken-word) colour.  `undefined` = yellow accent (`#FFFF00`). */
  karaokeHighlightColor?: string

  /**
   * REQ-0305 — default keyword-emphasis toggle for new cues.  When
   * `true`, every transcribed row is created with
   * `keywordEmphasisEnabled: true` (but no words are pre-emphasised —
   * `emphasizedWordIndices` is per-cue and chosen by hand in the
   * inspector).  `undefined` = OFF.  Per-word selection is NOT a
   * default (it is inherently per-cue), so only the master toggle +
   * colour + size multiplier have defaults here.
   */
  keywordEmphasisEnabled?: boolean
  /** Default emphasis colour, `#RRGGBB`.  `undefined` = gold accent (`#FFD400`). */
  emphasisColorHex?: string
  /** Default emphasis size (percent of font size).  `undefined` = 130 (1.3×). */
  emphasisScalePercent?: number

  /** REQ-0277 §1 — default casing transform.  `undefined` = `'none'`. */
  casing?: 'none' | 'uppercase'

  /** REQ-0277 §4 — default rotation in degrees clockwise (0–359).  `undefined` = 0. */
  rotation?: number

  // Layout defaults — currently seeded from `makeEntryLayoutDefaults()`
  // (= BURNIN_DEFAULTS).  When present in TranscriptionDefaults, these
  // override the BURNIN_DEFAULTS values at entry-creation time so users
  // can set a project-wide default anchor + margin from the Settings tab.
  horizontalPosition?: 'left' | 'center' | 'right'
  verticalPosition?: 'top' | 'center' | 'bottom'
  verticalMarginPx?: number
  /** REQ-0332 — default line spacing for new cues.  See `SubtitleEntry`. */
  lineSpacingPercent?: number

  /**
   * REQ-0295 §1 「オフセット」— default per-cue pin offset in pixels
   * from the alignment anchor.  When either `posOffsetX` or
   * `posOffsetY` is non-zero, new cues are created with an absolute
   * `posX` / `posY` computed as `anchor + offset` (video-dimensions
   * resolved at entry-creation time in step1.tsx).  When both are 0
   * (or undefined), new cues use pure alignment-based positioning
   * (no `\pos` tag) exactly like pre-REQ-0295.  Range: any integer;
   * negative values push the caption up/left, positive down/right.
   */
  posOffsetX?: number
  posOffsetY?: number

  // -------------------------------------------------------------------------
  // REQ-0325 §2 — entrance / exit animation defaults for NEW cues.
  //
  // Replaces the old `settingsStore.fadeDurationSec` in this role.  That
  // field was bound straight to the settings store rather than to these
  // defaults, which is the binding asymmetry REQ-0322 §3-6 reported; it
  // also stopped working as a default once the per-cue fade row was folded
  // into the animation UI (RES-0324 §1-3).  Living here means the animation
  // default is seeded at cue-creation time like every other style default.
  //
  // All optional: a settings file written before this REQ simply has none of
  // them, and `resolveAnimation` on the resulting cue falls through to the
  // `fadeDurationSec` migration exactly as before.
  // -------------------------------------------------------------------------
  animationType?: AnimationType
  animationInEnabled?: boolean
  animationOutEnabled?: boolean
  animationDurationSec?: number
  /** REQ-0331 §1-3 — strength defaults for new cues.  See `SubtitleEntry`. */
  animationStartScalePercent?: number
  animationBlurPx?: number
}

export interface ProjectState {
  video: VideoInfo | null
  /** 1-based audio track index selected for transcription. */
  selectedTrackIndex: number
  entries: SubtitleEntry[]
  /** Seed values used for newly created / transcribed rows. */
  defaults: TranscriptionDefaults
}

// ---------------------------------------------------------------------------
// Transcription advanced parameters
// ---------------------------------------------------------------------------

/**
 * Advanced faster-whisper transcription parameters, stored in AppSettings
 * and forwarded to the Python sidecar on each transcription run.
 * Default values are defined in TRANSCRIPTION_DEFAULTS (shared/constants.ts).
 */
export interface TranscriptionAdvancedParams {
  vadFilter: boolean
  vadThreshold: number
  /** Minimum speech segment duration in milliseconds. */
  minSpeechDurationMs: number
  /** Minimum silence duration to split segments, in milliseconds. */
  minSilenceDurationMs: number
  beamSize: number
  /** ISO 639-1 language code, or 'auto' for auto-detection (language=None in faster-whisper). */
  language: string
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface BurninPosition {
  horizontalPosition: 'left' | 'center' | 'right'
  verticalPosition: 'top' | 'center' | 'bottom'
  verticalMarginPx: number
}

export interface SubtitleBackground {
  enabled: boolean
  color: 'black' | 'white'
  /** Integer 0–100. Higher = more opaque. */
  opacityPercent: number
}

export type H264Encoder = 'h264_nvenc' | 'h264_amf' | 'h264_qsv' | 'h264_mf'
export type EncoderSetting = 'auto' | H264Encoder
export type AudioMode = 'simple' | 'preserve'

/**
 * Step 3 output container choice.
 * - `'mp4'`        : force `.mp4` regardless of input.  ffmpeg invoked with
 *                    `-f mp4` and `-movflags +faststart` for SNS/Web streaming.
 * - `'sameAsInput'`: keep the input file's extension.  Container is left to
 *                    ffmpeg's filename auto-detection (no `-f`).
 *
 * Session-only — like `burnin` / `subtitleBackground` / `audioMode`, this
 * value is intentionally reset on every navigation to Step 1 and on launch.
 */
export type OutputContainer = 'mp4' | 'sameAsInput'

export type AppTheme = 'dark' | 'light'

/**
 * REQ-20260615-029 / 030: user-selectable base neutral palette.  Default
 * is `'neutral'` (zero hue, truest grey).  REQ-030 swapped the cool /
 * gray-leaning options (zinc / slate / gray) for hue-distinct ones
 * (mauve / olive / mist / taupe).  See globals.css for the per-base
 * scale definitions.
 */
export type BaseColor = 'neutral' | 'stone' | 'mauve' | 'olive' | 'mist' | 'taupe'

export interface AppSettings {
  version: 1
  language: string
  /**
   * REQ-20260615-026: app-wide colour theme.  `dark` is the default and
   * the only value emitted by versions before this REQ shipped; the
   * field is optional in the persisted struct so old settings.json
   * files hydrate cleanly (falling back to `dark`).
   */
  theme?: AppTheme
  /**
   * REQ-20260615-029: app-wide base neutral palette.  Default
   * `'neutral'`.  Optional so settings.json files predating this REQ
   * hydrate cleanly.
   */
  baseColor?: BaseColor
  transcriptionDefaults: TranscriptionDefaults
  transcriptionAdvanced: TranscriptionAdvancedParams
  /** When true, \N line breaks are auto-inserted after transcription for lines exceeding video width. */
  autoLineBreak: boolean
  /**
   * Step 3 session-only `audioMode`.  Optional because the renderer does
   * not persist it — reset to BURNIN_DEFAULTS on every navigation to
   * Step 1 and on every launch.
   *
   * REQ-20260613-016 Phase 4 — `burnin` and `subtitleBackground` were
   * retired from the settings store along with the global panel UI.
   * Kept as optional dead-weight in the IPC contract so legacy
   * settings.json files from v1.0–v1.2.1 still hydrate cleanly (the
   * renderer's hydrate() now ignores both); a follow-up phase may
   * remove them entirely after the next persisted-settings migration.
   */
  burnin?: BurninPosition
  audioMode?: AudioMode
  subtitleBackground?: SubtitleBackground
  encoder: EncoderSetting
  defaultAudioTrackIndex: number
  /**
   * REQ-20260615-050 — default fade ramp duration in seconds applied
   * when a NEW SubtitleEntry is created (transcription, add-row,
   * duplicate-row).  Range `[0, 0.5]`, step 0.1; `0` means new entries
   * default to no fade.  No longer used at burn-in time — each entry
   * carries its own `fadeDurationSec` after creation.
   */
  fadeDurationSec: number
  activeModelId: WhisperModelId | null
  /**
   * REQ-0405 — the currently ENABLED translation tool (MADLAD-400 size), or
   * `null` when none is enabled.  Optional so settings files predating the
   * translation feature hydrate cleanly (absent ≡ null ≡ disabled).  Phase 1
   * only stores the selection; the translation itself is Phase 2.
   */
  translationToolActiveId?: TranslationToolId | null
  /**
   * Currently selected subtitle font ID.  Drives both the CSS preview family
   * and the ASS `Style:` `Fontname` at burn-in time.  Optional because
   * existing settings files predating font selection do not contain it;
   * defaults to `'noto-sans-jp-semibold'` when absent.
   */
  activeFontId?: FontId
  /**
   * REQ-0269 C-4 — records the `FONT_SET_VERSION` that was current the
   * last time the user completed a bulk "font set" download.  Compared
   * against `FONT_SET_VERSION` on startup / picker open: when strictly
   * less (or absent), the picker treats the on-disk set as `outdated`
   * and offers to re-download the incremental additions.
   *
   * Optional so pre-v1.3.6 settings.json files hydrate cleanly with
   * `undefined` — which correctly means "no font set downloaded" for
   * paid-tier users who never triggered the bulk flow.  Never set for
   * free-tier users (they cannot trigger the download at all, per
   * REQ-0269 C-2).
   */
  fontSetInstalledVersion?: number
  lastInputDir: string | null
  lastOutputDir: string | null
  /**
   * REQ-0121 — User-preferred fixed default folders shown in the input /
   * output dialogs.  Distinct from `lastInputDir` / `lastOutputDir` which
   * are MRU (updated after each open/save).  When `null` the dialog falls
   * back to `app.getPath('videos')`.  The main-side handler validates the
   * path on use (`fs.existsSync`) and silently falls back to Videos when
   * the folder has been removed / moved — no toast to avoid noise.
   */
  defaultInputDir?: string | null
  defaultOutputDir?: string | null
  /**
   * REQ-0194 — user-preferred default folder for the `.mojioko` project
   * file save / open dialogs.  Same shape as `defaultInputDir` /
   * `defaultOutputDir` (nullable, folder-picker on Settings > General,
   * lazy existence check on use, silent fallback to the OS Videos
   * folder).  Optional in the persisted struct so settings.json files
   * predating this REQ hydrate cleanly.
   */
  defaultProjectDir?: string | null
  /**
   * REQ-0150 — user-picked transcription accelerator.  `'cpu'` (default)
   * runs faster-whisper on the CPU path; `'gpu'` opts into CUDA via the
   * downloaded GPU tools (`%APPDATA%/MOJIOKO/gpu-tools/cuda-v1/`).
   *
   * The renderer surfaces this via the 2-card picker under the Whisper
   * model accordion; `transcription-sidecar.ts` reads it at spawn time
   * and only injects `MOJIOKO_GPU_TOOL_DIR` when this is `'gpu'` AND
   * the tools are fully installed on disk.  A user who has downloaded
   * the GPU tools but explicitly picked the CPU card gets CPU
   * execution — the tools stay on disk for a later re-select.
   *
   * Optional in the persisted struct so settings.json files predating
   * this REQ hydrate as CPU (the safe default — nothing extra to load).
   */
  activeAccelerator?: 'cpu' | 'gpu'
  /**
   * REQ-0335 §3 — user-saved subtitle style presets, newest last.
   *
   * Renderer-owned: the Step 2 inspector and bulk-edit bar are the only
   * writers, so the merge rule is `incoming-wins`.  Optional so settings.json
   * files predating this REQ hydrate as "no presets" without migration; the
   * built-in presets the owner will author later are a separate,
   * non-persisted list that this array never contains.
   *
   * Capped at `STYLE_PRESET_MAX`; see `shared/style-preset.ts` for the
   * payload shape and the exhaustive field classification.
   */
  stylePresets?: StylePreset[]
}

// ---------------------------------------------------------------------------
// Whisper model management
// ---------------------------------------------------------------------------

export type ModelStatus = 'not-installed' | 'installed' | 'active'

export interface ModelInfo {
  id: WhisperModelId
  displayName: string
  /** Actual disk usage; 0 when not installed. */
  sizeBytes: number
  /** Estimated download size before installation. */
  expectedSizeBytes: number
  status: ModelStatus
}

export interface ModelsState {
  models: ModelInfo[]
  activeModelId: WhisperModelId | null
  totalUsedBytes: number
  diskFreeBytes: number
  diskDrive: string
  modelsDir: string
}

// ---------------------------------------------------------------------------
// IPC response envelope
// ---------------------------------------------------------------------------

export type IpcOk<T> = { ok: true; data: T }
export type IpcErr = { ok: false; error: { code: string; message: string } }
export type IpcResult<T> = IpcOk<T> | IpcErr
