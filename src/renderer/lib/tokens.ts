/**
 * Design token constants for runtime use (canvas drawing, JS calculations).
 * For React components, prefer Tailwind utility classes defined in DESIGN_SYSTEM.md.
 */

export const colors = {
  // Background scale — mirrors the DARK --neutral-N ladder in globals.css.
  // REQ-0418 v2 contrast overhaul: cool 220° blue-grey ramp (was zero-hue
  // grey).  These hex values are the resolved equivalents of the new
  // --surface-* triplets; used by canvas / JS callers (subtitle-overlay
  // compositing, overflow calculations, timeline drawing) that can't read
  // the CSS vars directly.  Keep in sync with globals.css :root.
  bgBase: '#14161a',       // surface-0  220 14% 9%
  bgSurface: '#1d2025',    // surface-1  220 12% 13%
  bgElevated: '#272a30',   // surface-2  220 11% 17%
  bgInput: '#14161a',      // = surface-0
  bgHover: '#2c2f35',      // neutral-5  220 10% 19%

  // Border scale
  borderDefault: '#373b43',   // border-default 220 10% 24%
  borderStrong: '#4e545f',    // border-strong  220 10% 34%
  borderSubtle: '#22252a',    // neutral-3      220 11% 15%

  // Text scale
  textPrimary: '#f3f4f7',     // 220 20% 96%
  textSecondary: '#b5bac5',   // 220 12% 74%
  textTertiary: '#8f96a3',    // 220 10% 60%
  textMuted: '#6f7785',       // 220 9% 48%
  textOnAccent: '#0b2317',    // primary-foreground 150 52% 9%

  // Accent: vivid green — REQ-0418 v2 (was desaturated #45aa7a).
  // H 148 / S 64 % / L 54 % ≈ #3FD585.
  accent: '#3fd585',          // primary        148 64% 54%
  accentHover: '#31b971',     // primary-hover  148 58% 46%
  accentActive: '#2bab67',    // primary-active 148 60% 42%
  accentSoft: 'rgba(63,213,133,0.10)',
  accentSoftBorder: 'rgba(63,213,133,0.20)',

  // Semantic — REQ-0418 v2: success tracks the vivid accent; warning /
  // danger / info brightened per the target palette.
  warning: '#f7b23b',                       // 38 92% 60%
  warningSoft: 'rgba(247,178,59,0.10)',
  danger: '#f16f6f',                        // 0 82% 69%
  dangerSoft: 'rgba(241,111,111,0.10)',
  success: '#3fd585',                       // tracks accent
  successSoft: 'rgba(63,213,133,0.10)',
  info: '#5ba6f1',                          // 210 84% 65%
  infoSoft: 'rgba(91,166,241,0.10)'
} as const

// REQ-0177 Phase A — flat radius scale.  Mirrors tailwind.config.ts
// borderRadius so JS callers (canvas ROI rects, timeline block rounds)
// match the DOM UI.
export const radius = {
  sm: 2,
  md: 3,
  lg: 4,
  xl: 5,
  '2xl': 6
} as const

export const motion = {
  hover: 150,
  state: 200,
  page: 250
} as const

export const typography = {
  // Inter was previously listed as the preferred Latin face but the
  // woff2 was never wired up (the @font-face was commented out in
  // fonts.css) and the woff2 itself has now been removed from the repo
  // to dodge an OFL distribution obligation for an unused font.  The
  // bundled Noto Sans JP covers Latin glyphs adequately for the UI.
  // REQ-0275 §2 — CSS family renamed to MOJIOKO-namespaced form to
  // avoid a system-installed Noto Sans JP silently shadowing our
  // bundled TTF at burn-in time (libass DirectWrite behavior).  The
  // UI stack follows the same rename so the app UI renders from the
  // bundled face we actually shipped.
  fontSans: "'MOJIOKO Noto Sans JP', system-ui, sans-serif",
  fontMono: "'SF Mono', Monaco, Consolas, monospace"
} as const

/**
 * ASS left/right margin in pixels.
 * Single source of truth lives in shared/constants.ts; re-exported here so
 * renderer-side modules can import from one place without reaching into shared/.
 */
export { ASS_MARGIN_LR_PX } from '../../shared/constants'
