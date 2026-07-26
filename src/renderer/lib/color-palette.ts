/**
 * Shared palette displayed in every ColorPicker popover.
 *
 * Three groups:
 *  1. Basic colours (12) — neutrals + vivid, warm→cool.  High-saturation
 *     picks tuned for game / streaming short-form clips where the subtitle
 *     sits on top of a busy video.  REQ-0302 replaced the previous
 *     office/Excel-leaning palette with these vivid values.
 *  2. Recommended pairs (16) — text + outline combinations (REQ-0304,
 *     8 columns × 2 rows).  A single click on a pair applies BOTH halves
 *     to the calling context (only works in surfaces that can set text +
 *     outline together; see the ColorPicker's `onPairApply` prop).
 *  3. Colour-vision-deficiency (CUD) friendly (10) — the canonical
 *     "Color Universal Design" recommended set.  Values are taken
 *     verbatim from the CUD reference and must not be tweaked.
 *
 * Same constants are reused by every call site (subtitle-table per-row
 * pickers, bulk-edit-bar, default-style-controls) so the palette is
 * identical across all three surfaces.  Original grid was REQ-033;
 * the current vivid contents come from REQ-0302.
 */

// REQ-0302: order is neutrals → warm → cool so hues flow smoothly
// left-to-right, top-to-bottom in color-picker.tsx's 6-column grid.
// Do NOT sort alphabetically or reorder without owner review — the
// visual rhythm of the swatch grid depends on this sequence.
export const BASIC_COLORS: readonly string[] = [
  '#FFFFFF', // 白
  '#000000', // 黒
  '#FFE500', // イエロー
  '#FF8A00', // オレンジ
  '#FF3B30', // レッド
  '#FF2E88', // ピンク
  '#FF00E5', // マゼンタ
  '#A45CFF', // パープル
  '#2D8CFF', // ブルー
  '#00E5FF', // シアン
  '#00FFC2', // ミント
  '#B4FF39'  // ライム
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

// REQ-0304: expanded from 10 to 16 pairs (8 columns × 2 rows in the
// ColorPicker popover).  The whole set was reworked around a "rainbow,
// balanced, pop" brief: every text colour is drawn from BASIC_COLORS
// (REQ-0302) so the recommended pairs never drift from the swatch grid.
//
// Ordering (do NOT reorder without owner review — the swatch grid's
// visual rhythm depends on it):
//   Row 1 (pairs 1-8):  neutrals + a warm→magenta→purple rainbow, each
//                       vivid text over a plain black/white outline for
//                       maximum readability on busy footage.
//   Row 2 (pairs 9-16): a cool rainbow (blue→cyan→mint→lime) over
//                       black/white, then four "applied" looks —
//                       white text over a vivid outline (13-14, the
//                       classic short-form style) and two neon
//                       text×outline combos (15-16) for eye-catch.
export const COLOR_PAIRS: readonly ColorPair[] = [
  // ── Row 1: neutrals + warm rainbow ──
  { text: '#FFFFFF', outline: '#000000' }, // 1  白 / 黒
  { text: '#000000', outline: '#FFFFFF' }, // 2  黒 / 白
  { text: '#FFE500', outline: '#000000' }, // 3  イエロー / 黒
  { text: '#FF8A00', outline: '#000000' }, // 4  オレンジ / 黒
  { text: '#FF3B30', outline: '#FFFFFF' }, // 5  レッド / 白
  { text: '#FF2E88', outline: '#FFFFFF' }, // 6  ピンク / 白
  { text: '#FF00E5', outline: '#000000' }, // 7  マゼンタ / 黒
  { text: '#A45CFF', outline: '#FFFFFF' }, // 8  パープル / 白
  // ── Row 2: cool rainbow + applied / neon ──
  { text: '#2D8CFF', outline: '#FFFFFF' }, // 9  ブルー / 白
  { text: '#00E5FF', outline: '#000000' }, // 10 シアン / 黒
  { text: '#00FFC2', outline: '#000000' }, // 11 ミント / 黒
  { text: '#B4FF39', outline: '#000000' }, // 12 ライム / 黒
  { text: '#FFFFFF', outline: '#FF00E5' }, // 13 白 / マゼンタ
  { text: '#FFFFFF', outline: '#2D8CFF' }, // 14 白 / ブルー
  { text: '#FFE500', outline: '#FF00E5' }, // 15 イエロー / マゼンタ（ネオン）
  { text: '#00E5FF', outline: '#A45CFF' }  // 16 シアン / パープル（ネオン）
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
