import log from '../lib/logger'
import type { SubtitleEntry, VideoInfo, BurninPosition, SubtitleBackground } from '../../shared/types'
import { ASS_MARGIN_LR_PX, FADE_DURATION_SEC_DEFAULT } from '../../shared/constants'

type HorizontalPos = 'left' | 'center' | 'right'
type VerticalPos = 'top' | 'bottom'

function getAlignment(h: HorizontalPos, v: VerticalPos): number {
  if (v === 'bottom') {
    if (h === 'left') return 1
    if (h === 'center') return 2
    return 3
  } else {
    if (h === 'left') return 7
    if (h === 'center') return 8
    return 9
  }
}

/** Convert "#RRGGBB" to ASS "&H00BBGGRR&" */
function hexToAss(hex: string): string {
  const clean = hex.replace('#', '').padStart(6, '0')
  const r = clean.slice(0, 2)
  const g = clean.slice(2, 4)
  const b = clean.slice(4, 6)
  return `&H00${b}${g}${r}&`
}

/** Convert seconds to ASS time format H:MM:SS.cc */
function formatAssTime(sec: number): string {
  const totalCentis = Math.round(sec * 100)
  const cc = totalCentis % 100
  const totalSecs = Math.floor(totalCentis / 100)
  const ss = totalSecs % 60
  const totalMins = Math.floor(totalSecs / 60)
  const mm = totalMins % 60
  const hh = Math.floor(totalMins / 60)
  return `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(cc).padStart(2, '0')}`
}

/**
 * Escape special ASS characters in text, preserving `\N` as a line-break tag.
 *
 * Round-trip: `\N` is first replaced with a real newline so the backslash
 * escape below doesn't double it (without this, `\N` becomes `\\N` and libass
 * renders the literal text "\N" instead of breaking the line).  The final
 * `\n` → `\N` step then restores it as a libass line-break tag.
 */
function escapeAssText(text: string): string {
  return text
    .replace(/\\N/g, '\n')
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\n/g, '\\N')
}

/**
 * Convert an opacity percentage (0–100) to an ASS alpha hex byte string.
 * ASS alpha: 0x00 = fully opaque, 0xFF = fully transparent.
 */
function opacityToAssAlpha(opacityPercent: number): string {
  const alpha = Math.round((1 - opacityPercent / 100) * 255)
  return alpha.toString(16).toUpperCase().padStart(2, '0')
}

export function generateAss(
  entries: SubtitleEntry[],
  video: VideoInfo,
  burnin: BurninPosition,
  fadeDurationSec: number = FADE_DURATION_SEC_DEFAULT,
  subtitleBackground?: SubtitleBackground
): string {
  const alignment = getAlignment(burnin.horizontalPosition, burnin.verticalPosition)
  const marginV = burnin.verticalMarginPx
  const bgEnabled = subtitleBackground?.enabled === true

  // BorderStyle: 1 = outline + shadow, 3 = opaque box background
  const borderStyle = bgEnabled ? 3 : 1

  log.debug('[ass-generator] generateAss called', {
    bgEnabled,
    borderStyle,
    subtitleBackground: subtitleBackground ?? null,
    entryCount: entries.length,
  })

  const scriptInfo = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${video.widthPx}`,
    `PlayResY: ${video.heightPx}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    ''
  ].join('\n')

  const styles = [
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BorderStyle, Outline, Alignment, MarginL, MarginR, MarginV',
    `Style: Default,Noto Sans JP SemiBold,100,&H00FFFFFF,&H00000000,${borderStyle},3,${alignment},${ASS_MARGIN_LR_PX},${ASS_MARGIN_LR_PX},${marginV}`,
    ''
  ].join('\n')

  const activeEntries = entries.filter((e) => !e.isDeleted)

  const events = [
    '[Events]',
    'Format: Layer, Start, End, Style, MarginL, MarginR, MarginV, Effect, Text',
    ...activeEntries.map((e) => {
      const fadeDurationMs = Math.round(fadeDurationSec * 1000)
      const fadeTag = e.fadeEnabled ? `\\fad(${fadeDurationMs},${fadeDurationMs})` : ''

      let styleTag: string
      if (bgEnabled && subtitleBackground) {
        // Box background mode: remove outline, add background colour + alpha
        const bgColor = subtitleBackground.color === 'white' ? '00FFFFFF' : '000000'
        const bgAlpha = opacityToAssAlpha(subtitleBackground.opacityPercent)
        styleTag = [
          `\\fs${e.fontSizePx}`,
          `\\c${hexToAss(e.textColorHex)}`,
          `\\bord0`,
          `\\shad5`,
          `\\4c&H${bgColor}&`,
          `\\4a&H${bgAlpha}&`,
          fadeTag
        ]
          .filter(Boolean)
          .join('')
      } else {
        styleTag = [
          `\\fs${e.fontSizePx}`,
          `\\c${hexToAss(e.textColorHex)}`,
          `\\3c${hexToAss(e.outlineColorHex)}`,
          `\\bord${e.outlineThicknessPx}`,
          fadeTag
        ]
          .filter(Boolean)
          .join('')
      }

      const text = `{${styleTag}}${escapeAssText(e.text)}`
      const dialogueLine = `Dialogue: 0,${formatAssTime(e.startSec)},${formatAssTime(e.endSec)},Default,0,0,0,,${text}`
      return dialogueLine
    }),
    ''
  ].join('\n')

  const assContent = [scriptInfo, styles, events].join('\n')

  // Log the Style line and first Dialogue line for diagnostics.
  const styleLineMatch = assContent.match(/^Style:.*$/m)
  const dialogueLineMatch = assContent.match(/^Dialogue:.*$/m)
  log.debug('[ass-generator] Style   :', styleLineMatch?.[0] ?? '(none)')
  log.debug('[ass-generator] Dialogue:', dialogueLineMatch?.[0] ?? '(none)')

  return assContent
}
