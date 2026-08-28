/**
 * REQ-0461 — make `mojioko burn`'s per-cue style flags actually change the
 * render.  `--weight` / `--font-size` / `--text-color` / `--outline-color` /
 * `--outline` were advertised (help + MCP) but never read, so passing them did
 * nothing; `--margin-v` only fed the vertical-overflow budget and never the ASS
 * `verticalMarginPx` (the real bottom/top offset).
 *
 * These are pure helpers so a unit test can prove the flags land on the entry
 * (and, via `generateAss`, on the ASS `\fs` / `\c` / `\3c` / `\bord` / `\fn` /
 * per-line `\pos` anchor) without spawning ffmpeg.  Validation lives in the
 * command (it needs `CliError`); this module only maps + applies.
 */
import {
  getFontMeta,
  getFontIdForFamilyAndWeight,
  type FontId,
} from '../../shared/fonts'
import type { SubtitleBackground, SubtitleEntry } from '../../shared/types'
import type { KaraokeStyle } from '../../shared/karaoke-style'
import { optString, type ParsedArgs } from './args'
import { CliError } from './output'

/**
 * CLI weight labels, in ascending OpenType weight-class order.  Single source
 * of truth — `help.ts` (the `--weight` enum) and `mcp/tools.ts` import this so
 * the advertised values cannot drift from what `weightLabelToClass` accepts.
 */
export const CLI_WEIGHT_LABELS = [
  'Thin',
  'ExtraLight',
  'Light',
  'Regular',
  'Medium',
  'SemiBold',
  'Bold',
  'ExtraBold',
  'Black',
] as const

export type CliWeightLabel = (typeof CLI_WEIGHT_LABELS)[number]

/**
 * Map a `--weight` label to its OpenType weight class (Thin=100 … Black=900),
 * case-insensitively.  Returns undefined for an unknown label so the caller can
 * raise a USAGE error listing the accepted values.
 */
export function weightLabelToClass(label: string): number | undefined {
  const idx = CLI_WEIGHT_LABELS.findIndex(
    (w) => w.toLowerCase() === label.trim().toLowerCase(),
  )
  return idx < 0 ? undefined : (idx + 1) * 100
}

/**
 * Resolve `--weight <label>` to a concrete FontId within the ACTIVE font's
 * family.  Weight is a per-family axis (`noto-sans-jp-bold`, …), so the label
 * is mapped to a class and looked up in `activeFontId`'s `cssFontFamily`.  When
 * the family has no registered face at that weight the shared resolver falls
 * back to the family default (`getFontIdForFamilyAndWeight`), so a single-weight
 * display face degrades gracefully rather than erroring.  Returns undefined only
 * when the label itself is invalid (the caller rejects that).
 */
export function resolveWeightFontId(
  activeFontId: FontId,
  label: string,
): FontId | undefined {
  const weightClass = weightLabelToClass(label)
  if (weightClass === undefined) return undefined
  const family = getFontMeta(activeFontId).cssFontFamily
  return getFontIdForFamilyAndWeight(family, weightClass)
}

/** `#RRGGBB` (case-insensitive).  Rejects `#RGB`, names, and missing `#`. */
export function isHexColor(s: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(s.trim())
}

/**
 * The resolved per-cue style overrides.  Every field is optional: only the
 * flags the user actually passed are present, so an omitted flag leaves the
 * cue's existing (seeded / `.mojioko` / preset) value untouched.
 */
export interface StyleOverrides {
  fontSizePx?: number
  textColorHex?: string
  outlineColorHex?: string
  outlineThicknessPx?: number
  /** Resolved from `--weight` against the active font family. */
  fontId?: FontId
  /** The ASS vertical margin (`--margin-v`) — the real bottom/top offset. */
  verticalMarginPx?: number
  /**
   * REQ-0500 §2 — karaoke, the one effect a headless caller could not escape.
   *
   * Cues seeded from `TranscriptionDefaults` inherit `karaokeEnabled` from the
   * app settings, so on a machine with karaoke ON *every* CLI/MCP burn came out
   * with a sweep and there was no flag to turn it off (RES-0498 confirmed this
   * in real pixels). The only workaround was a saved preset with karaoke off —
   * which cannot be authored headlessly. That made it a defect, not a gap.
   */
  karaokeEnabled?: boolean
  karaokeHighlightColor?: string
  karaokeStyle?: KaraokeStyle

  /**
   * REQ-0501 §1 — the remaining GUI-settable style axes (second wave).
   *
   * Ranges mirror the GUI controls exactly, because "what the GUI can set" is
   * the contract these flags exist to expose headlessly.  `shadowColor` and
   * `shadowAlpha` are deliberately ABSENT: they are real cue fields, but no GUI
   * surface can set them (they are auto-seeded to `#000000` / `100` the first
   * time shadow depth crosses 0), so a CLI flag would create a capability the
   * app itself does not offer.
   */
  keywordEmphasisEnabled?: boolean
  emphasisColorHex?: string
  emphasisScalePercent?: number
  shadowDepth?: number
  rotation?: number
  casing?: 'none' | 'uppercase'
  lineSpacingPercent?: number
  textAlpha?: number
  outlineAlpha?: number
  /**
   * Background box, kept as three FLAT fields rather than a nested object.
   *
   * `subtitleBackground` is a required concrete object on every cue, so
   * overriding it wholesale would clobber the sub-fields the caller did not
   * mention.  Flat fields let `applyStyleOverrides` merge onto the cue's own
   * value, so `--background on` alone keeps that cue's colour and opacity.
   */
  backgroundEnabled?: boolean
  backgroundColor?: SubtitleBackground['color']
  backgroundOpacityPercent?: number
}

/** Read an integer CLI option (first non-empty of `keys`), or undefined. */
function optIntOpt(opts: ParsedArgs['opts'], ...keys: string[]): number | undefined {
  const s = optString(opts, ...keys)
  if (s === undefined || s === '') return undefined
  const n = Number.parseInt(s, 10)
  return Number.isFinite(n) ? n : undefined
}

/**
 * REQ-0501 §1 — an integer option constrained to the GUI's range.
 *
 * Rejects rather than clamps: a silently clamped value is the same class of
 * lie as a silently ignored flag (REQ-0499).  Returns undefined when the flag
 * is absent, so an omitted flag never writes to the cue.
 */
function optRangedInt(
  opts: ParsedArgs['opts'],
  key: string,
  min: number,
  max: number,
  example: string,
): number | undefined {
  const s = optString(opts, key)
  if (s === undefined || s === '') return undefined
  const n = Number.parseInt(s, 10)
  if (!Number.isFinite(n) || String(n) !== s.trim()) {
    throw new CliError('USAGE', `--${key} は整数: ${s}`, example)
  }
  if (n < min || n > max) {
    throw new CliError('USAGE', `--${key} は ${min}..${max} の範囲: ${n}`, example)
  }
  return n
}

/** An `on|off` option.  Undefined when absent; USAGE on anything else. */
function optOnOff(opts: ParsedArgs['opts'], key: string): boolean | undefined {
  const s = optString(opts, key)
  if (s === undefined || s === '') return undefined
  const v = s.trim().toLowerCase()
  if (v !== 'on' && v !== 'off') {
    throw new CliError('USAGE', `--${key} は on|off: ${s}`, `例: --${key} off`)
  }
  return v === 'on'
}

/** A `#RRGGBB` option.  Undefined when absent; USAGE on a malformed value. */
function optHexColor(opts: ParsedArgs['opts'], key: string, example: string): string | undefined {
  const s = optString(opts, key)
  if (s === undefined || s === '') return undefined
  if (!isHexColor(s)) throw new CliError('USAGE', `--${key} は #RRGGBB 形式: ${s}`, example)
  return s.trim()
}

/**
 * REQ-0461 — parse + validate the per-cue style flags shared by `burn` and
 * `export_frame` (so the preview frame renders the same overrides a burn will).
 * `--weight` resolves against `activeFontId`'s family.  Throws `CliError`
 * (USAGE) on a malformed value; omitted flags leave the field undefined.
 */
export function parseStyleOverrides(
  opts: ParsedArgs['opts'],
  activeFontId: FontId,
): StyleOverrides {
  const ov: StyleOverrides = {}

  const fontSize = optIntOpt(opts, 'font-size')
  if (fontSize !== undefined) {
    if (fontSize <= 0) throw new CliError('USAGE', `--font-size は正の整数(px): ${fontSize}`, '例: --font-size 64')
    ov.fontSizePx = fontSize
  }

  const textColor = optString(opts, 'text-color')
  if (textColor !== undefined && textColor !== '') {
    if (!isHexColor(textColor)) throw new CliError('USAGE', `--text-color は #RRGGBB 形式: ${textColor}`, '例: --text-color #FFEE00')
    ov.textColorHex = textColor.trim()
  }

  const outlineColor = optString(opts, 'outline-color')
  if (outlineColor !== undefined && outlineColor !== '') {
    if (!isHexColor(outlineColor)) throw new CliError('USAGE', `--outline-color は #RRGGBB 形式: ${outlineColor}`, '例: --outline-color #000000')
    ov.outlineColorHex = outlineColor.trim()
  }

  const outline = optIntOpt(opts, 'outline')
  if (outline !== undefined) {
    if (outline < 0) throw new CliError('USAGE', `--outline は 0 以上の整数(px): ${outline}`, '例: --outline 4')
    ov.outlineThicknessPx = outline
  }

  const weight = optString(opts, 'weight')
  if (weight !== undefined && weight !== '') {
    const weightFontId = resolveWeightFontId(activeFontId, weight)
    if (weightFontId === undefined) throw new CliError('USAGE', `unknown --weight: ${weight}`, CLI_WEIGHT_LABELS.join('|'))
    ov.fontId = weightFontId
  }

  // `--margin-v` is the ASS vertical margin (real bottom/top offset), distinct
  // from `--margin-y` (overflow safety budget, handled by the burn command).
  const marginV = optIntOpt(opts, 'margin-v')
  if (marginV !== undefined) {
    if (marginV < 0) throw new CliError('USAGE', `--margin-v は 0 以上の整数(px): ${marginV}`, '例: --margin-v 80')
    ov.verticalMarginPx = marginV
  }

  // REQ-0500 §2 — karaoke.  `--karaoke off` must be expressible, so this reads
  // an explicit on|off rather than being a bare boolean flag.
  const karaoke = optString(opts, 'karaoke')
  if (karaoke !== undefined && karaoke !== '') {
    const v = karaoke.trim().toLowerCase()
    if (v !== 'on' && v !== 'off') {
      throw new CliError('USAGE', `--karaoke は on|off: ${karaoke}`, '例: --karaoke off')
    }
    ov.karaokeEnabled = v === 'on'
  }

  const karaokeColor = optString(opts, 'karaoke-color')
  if (karaokeColor !== undefined && karaokeColor !== '') {
    if (!isHexColor(karaokeColor)) throw new CliError('USAGE', `--karaoke-color は #RRGGBB 形式: ${karaokeColor}`, '例: --karaoke-color #FFFF00')
    ov.karaokeHighlightColor = karaokeColor.trim()
  }

  // The per-cue `karaokeStyle` was previously unreachable from ANY headless
  // path: it is absent from `TranscriptionDefaults`, so seeded cues leave it
  // undefined and every renderer falls back to `KARAOKE_STYLE_DEFAULT`.  Setting
  // it explicitly here does not disturb that fallback (REQ-0500 §2-5) — an
  // omitted flag still leaves the field undefined.
  const karaokeStyleFlag = optString(opts, 'karaoke-style')
  if (karaokeStyleFlag !== undefined && karaokeStyleFlag !== '') {
    const v = karaokeStyleFlag.trim().toLowerCase()
    if (v !== 'sweep' && v !== 'switch') {
      throw new CliError('USAGE', `--karaoke-style は sweep|switch: ${karaokeStyleFlag}`, '例: --karaoke-style switch')
    }
    ov.karaokeStyle = v
  }

  // --- REQ-0501 §1 — remaining GUI-settable axes -----------------------------
  // Every bound below is the GUI control's own min/max, verified against the
  // inspector / bulk-edit / defaults panels.  Where the GUI's *step* is coarser
  // than its range (opacity steps by 5, rotation by 15), the CLI accepts the
  // full integer range: the shared clamp helpers already do, and refusing a
  // value the app can store would be a gratuitous difference.

  // Keyword emphasis.  The master toggle + colour + scale only; the emphasized
  // SPANS are per-cue character offsets, so a whole-file broadcast of them is
  // meaningless (they belong with the cue-addressing API).
  ov.keywordEmphasisEnabled = optOnOff(opts, 'emphasis')
  ov.emphasisColorHex = optHexColor(opts, 'emphasis-color', '例: --emphasis-color #FFD400')
  ov.emphasisScalePercent = optRangedInt(opts, 'emphasis-scale', 50, 200, '例: --emphasis-scale 130')

  // Shadow: depth only (0 = off, which is how the GUI encodes the toggle).
  ov.shadowDepth = optRangedInt(opts, 'shadow', 0, 50, '例: --shadow 10（0=影なし）')

  ov.rotation = optRangedInt(opts, 'rotation', 0, 359, '例: --rotation 15')
  ov.lineSpacingPercent = optRangedInt(opts, 'line-spacing', -50, 100, '例: --line-spacing -20')
  ov.textAlpha = optRangedInt(opts, 'text-alpha', 0, 100, '例: --text-alpha 100')
  ov.outlineAlpha = optRangedInt(opts, 'outline-alpha', 0, 100, '例: --outline-alpha 100')

  // Casing is a two-state switch in the GUI, so the flag is on|off rather than
  // exposing the internal `'none' | 'uppercase'` spelling.
  const uppercase = optOnOff(opts, 'uppercase')
  if (uppercase !== undefined) ov.casing = uppercase ? 'uppercase' : 'none'

  ov.backgroundEnabled = optOnOff(opts, 'background')
  const bgColor = optString(opts, 'background-color')
  if (bgColor !== undefined && bgColor !== '') {
    const v = bgColor.trim().toLowerCase()
    // Deliberately NOT a hex: the cue field is a two-value union, and the GUI
    // offers a segmented black/white control rather than a colour picker.
    if (v !== 'black' && v !== 'white') {
      throw new CliError('USAGE', `--background-color は black|white: ${bgColor}`, '例: --background-color black')
    }
    ov.backgroundColor = v
  }
  ov.backgroundOpacityPercent = optRangedInt(opts, 'background-opacity', 0, 100, '例: --background-opacity 50')

  return ov
}

/** True when no override was supplied (so the caller can skip the map entirely). */
export function isEmptyStyleOverrides(ov: StyleOverrides): boolean {
  // Written as "every declared field is undefined" rather than a hand-listed
  // chain: the previous form silently ignored any field added to the interface
  // without a matching clause here — the same optional-field-plus-manual-list
  // trap catalogued in `style-defaults-to-entry.ts`.
  const probe: Required<{ [K in keyof StyleOverrides]: true }> = {
    fontSizePx: true,
    textColorHex: true,
    outlineColorHex: true,
    outlineThicknessPx: true,
    fontId: true,
    verticalMarginPx: true,
    karaokeEnabled: true,
    karaokeHighlightColor: true,
    karaokeStyle: true,
    keywordEmphasisEnabled: true,
    emphasisColorHex: true,
    emphasisScalePercent: true,
    shadowDepth: true,
    rotation: true,
    casing: true,
    lineSpacingPercent: true,
    textAlpha: true,
    outlineAlpha: true,
    backgroundEnabled: true,
    backgroundColor: true,
    backgroundOpacityPercent: true,
  }
  return Object.keys(probe).every((k) => ov[k as keyof StyleOverrides] === undefined)
}

/**
 * Apply the overrides to every non-deleted cue, returning a new array (deleted
 * cues and untouched fields pass through unchanged).  Applied in SOURCE-pixel
 * space BEFORE resolution scaling, so `fontSizePx` / `outlineThicknessPx` /
 * `verticalMarginPx` scale with the target the same way a `.mojioko` cue's own
 * values do (`scaleEntries`).  `#RRGGBB` colours and the weight FontId are
 * scale-invariant.
 */
export function applyStyleOverrides(
  entries: SubtitleEntry[],
  ov: StyleOverrides,
): SubtitleEntry[] {
  if (isEmptyStyleOverrides(ov)) return entries
  return entries.map((e) =>
    e.isDeleted
      ? e
      : {
          ...e,
          ...(ov.fontSizePx !== undefined ? { fontSizePx: ov.fontSizePx } : {}),
          ...(ov.textColorHex !== undefined ? { textColorHex: ov.textColorHex } : {}),
          ...(ov.outlineColorHex !== undefined ? { outlineColorHex: ov.outlineColorHex } : {}),
          ...(ov.outlineThicknessPx !== undefined ? { outlineThicknessPx: ov.outlineThicknessPx } : {}),
          ...(ov.fontId !== undefined ? { fontId: ov.fontId } : {}),
          ...(ov.verticalMarginPx !== undefined ? { verticalMarginPx: ov.verticalMarginPx } : {}),
          ...(ov.karaokeEnabled !== undefined ? { karaokeEnabled: ov.karaokeEnabled } : {}),
          ...(ov.karaokeHighlightColor !== undefined ? { karaokeHighlightColor: ov.karaokeHighlightColor } : {}),
          ...(ov.karaokeStyle !== undefined ? { karaokeStyle: ov.karaokeStyle } : {}),
          // REQ-0501 §1
          ...(ov.keywordEmphasisEnabled !== undefined ? { keywordEmphasisEnabled: ov.keywordEmphasisEnabled } : {}),
          ...(ov.emphasisColorHex !== undefined ? { emphasisColorHex: ov.emphasisColorHex } : {}),
          ...(ov.emphasisScalePercent !== undefined ? { emphasisScalePercent: ov.emphasisScalePercent } : {}),
          ...(ov.shadowDepth !== undefined ? { shadowDepth: ov.shadowDepth } : {}),
          ...(ov.rotation !== undefined ? { rotation: ov.rotation } : {}),
          ...(ov.casing !== undefined ? { casing: ov.casing } : {}),
          ...(ov.lineSpacingPercent !== undefined ? { lineSpacingPercent: ov.lineSpacingPercent } : {}),
          ...(ov.textAlpha !== undefined ? { textAlpha: ov.textAlpha } : {}),
          ...(ov.outlineAlpha !== undefined ? { outlineAlpha: ov.outlineAlpha } : {}),
          // The background box is a required concrete object, so its three
          // flags MERGE onto the cue's own value instead of replacing it —
          // `--background on` alone must not reset that cue's colour/opacity.
          ...(ov.backgroundEnabled !== undefined ||
          ov.backgroundColor !== undefined ||
          ov.backgroundOpacityPercent !== undefined
            ? {
                subtitleBackground: {
                  ...e.subtitleBackground,
                  ...(ov.backgroundEnabled !== undefined ? { enabled: ov.backgroundEnabled } : {}),
                  ...(ov.backgroundColor !== undefined ? { color: ov.backgroundColor } : {}),
                  ...(ov.backgroundOpacityPercent !== undefined ? { opacityPercent: ov.backgroundOpacityPercent } : {}),
                },
              }
            : {}),
        },
  )
}
