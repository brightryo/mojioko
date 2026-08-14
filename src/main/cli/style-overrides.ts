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
import type { SubtitleEntry } from '../../shared/types'
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
}

/** Read an integer CLI option (first non-empty of `keys`), or undefined. */
function optIntOpt(opts: ParsedArgs['opts'], ...keys: string[]): number | undefined {
  const s = optString(opts, ...keys)
  if (s === undefined || s === '') return undefined
  const n = Number.parseInt(s, 10)
  return Number.isFinite(n) ? n : undefined
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
        },
  )
}
