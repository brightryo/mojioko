/**
 * Shared 30-color palette displayed in every ColorPicker popover.
 *
 * Three groups:
 *  1. Basic colours (10) — high-contrast singles usable as either text
 *     colour or outline colour.
 *  2. Recommended pairs (5) — text + outline combinations.  A single
 *     click on a pair applies BOTH halves to the calling context (only
 *     works in surfaces that can set text + outline together; see the
 *     ColorPicker's `onPairApply` prop).
 *  3. Colour-vision-deficiency (CUD) friendly (10) — the canonical
 *     "Color Universal Design" recommended set.  Values are taken
 *     verbatim from the CUD reference and must not be tweaked.
 *
 * Same constants are reused by every call site (subtitle-table per-row
 * pickers, bulk-edit-bar, default-style-controls) so the palette is
 * identical everywhere.  REQ-033.
 */

export const BASIC_COLORS: readonly string[] = [
  '#FFFFFF', // 白
  '#000000', // 黒
  '#FF0000', // 赤
  '#0000FF', // 青
  '#00B000', // 緑
  '#FFFF00', // 黄
  '#FF8000', // オレンジ
  '#FF40A0', // ピンク
  '#00C0FF', // 水色
  '#8000FF'  // 紫
]

/**
 * Text × Outline recommended combinations.  `text` is the fill colour,
 * `outline` is the stroke around each glyph — same semantic as the
 * SubtitleEntry fields they target.
 */
export interface ColorPair {
  text: string
  outline: string
}

// REQ-039 #1: expanded from 5 to 10 pairs.  Pairs 1-5 unchanged; pairs 6-10
// added below.  Pairs 6-8 are provisional values pending owner finalisation;
// pairs 9-10 (white×black / black×white) are confirmed.  Layout in the
// ColorPicker popover stays compact at grid-cols-5 (5 columns × 2 rows)
// to avoid breaking REQ-035's "fits in Settings dialog" constraint.
export const COLOR_PAIRS: readonly ColorPair[] = [
  { text: '#FFFF00', outline: '#001040' },
  // REQ-034 #2: pair 2 reworked to be red-on-orange with strong luminance
  // contrast.  Earlier value (#FF4B00 × #FFF8E0) was orange-on-cream and
  // didn't match the "red text, orange outline" intent.  L*(#E00000) ≈ 36,
  // L*(#FFB000) ≈ 76 — ~40 L* gap gives the outline a clearly visible
  // halo without losing the warm red identity.
  { text: '#E00000', outline: '#FFB000' },
  { text: '#4DC4FF', outline: '#003060' },
  { text: '#AEEA00', outline: '#0A3D1E' },
  { text: '#FF80A0', outline: '#3A0A4A' },
  // REQ-041 #3: pairs 6-8 rebalanced.  Previous provisional values
  // (white×darkRed / black×yellow / cyan×black) overlapped with pairs
  // 1-5 (red, yellow, cyan-ish) and produced clumped hue coverage.
  // New values add three missing hues (orange / cyan-teal / purple)
  // with dark-on-text or light-on-text contrast pairings.
  { text: '#FF7A00', outline: '#3A1A00' }, // pair 6 ★: 鮮やかオレンジ×濃茶
  { text: '#00E0D0', outline: '#00303A' }, // pair 7 ★: シアン×濃青緑
  { text: '#B060FF', outline: '#FFFFFF' }, // pair 8 ★: 明るい紫×白
  { text: '#FFFFFF', outline: '#000000' }, // pair 9 ★確定: 白×黒
  { text: '#000000', outline: '#FFFFFF' }  // pair 10 ★確定: 黒×白
]

/**
 * Color Universal Design (CUD) recommended palette.  Hex values verbatim
 * from the CUD spec — preserved so designers can rely on a known-safe
 * set for users with colour vision deficiency.  Do not tweak.
 */
export const CUD_COLORS: readonly string[] = [
  '#FF4B00', // 赤
  '#FFF100', // 黄
  '#03AF7A', // 緑
  '#005AFF', // 青
  '#4DC4FF', // 空色
  '#FF8082', // ピンク
  '#F6AA00', // オレンジ
  '#990099', // 紫
  '#804000', // 茶
  '#84919E'  // グレー
]
