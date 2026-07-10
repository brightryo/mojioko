/**
 * Design token constants for runtime use (canvas drawing, JS calculations).
 * For React components, prefer Tailwind utility classes defined in DESIGN_SYSTEM.md.
 */

export const colors = {
  // Background scale — mirrors the --neutral-N ladder in globals.css.
  // REQ-0177 Phase A: lifted from 4 % to 11 % L to leave near-black.
  // REQ-0178 Phase B-1: further +2 % L on top of Phase A (surface-0
  // now at 13 %) after owner Phase A feedback "still reads too
  // black".  Values here are used by canvas / JS callers
  // (subtitle-overlay compositing, overflow calculations, timeline
  // drawing) that can't read the CSS vars directly.
  bgBase: '#212121',       // was #1c1c1c — neutral-1 at 13 %
  bgSurface: '#292929',    // was #242424 — neutral-2 at 16 %
  bgElevated: '#2e2e2e',   // was #2b2b2b — neutral-4 at 18 %
  bgInput: '#212121',      // was #1c1c1c — matches bgBase
  bgHover: '#363636',      // was #333333 — neutral-5 at 21 %

  // Border scale
  borderDefault: '#3f3f3f',   // was #3d3d3d — neutral-6 at 25 %
  borderStrong: '#474747',    // unchanged — neutral-7 at 28 %
  borderSubtle: '#262626',    // was #212121 — neutral-3 at 15 %

  // Text scale
  textPrimary: '#fafafa',
  textSecondary: '#a1a1aa',
  textTertiary: '#71717a',
  textMuted: '#52525b',
  textOnAccent: '#052e16',

  // Accent: desaturated green — REQ-0177 tone-down from #22c55e emerald.
  // H 152 / S 42 % / L 47 % ≈ #45AA7A, brand-recognisable but calmer.
  accent: '#45aa7a',
  accentHover: '#388d63',
  accentActive: '#2b6d4c',
  accentSoft: 'rgba(69,170,122,0.10)',
  accentSoftBorder: 'rgba(69,170,122,0.20)',

  // Semantic — REQ-0177: success tracks the desaturated accent so the
  // brand-green ladder stays coherent; info desaturated to a Resolve-
  // friendly muted blue.  warning / danger untouched (their vividness
  // is load-bearing for user attention).
  warning: '#fbbf24',
  warningSoft: 'rgba(251,191,36,0.10)',
  danger: '#ef4444',
  dangerSoft: 'rgba(239,68,68,0.10)',
  success: '#45aa7a',                       // was #22c55e — tracks accent
  successSoft: 'rgba(69,170,122,0.10)',     // was rgba(34,197,94,0.10)
  info: '#5989b9',                          // was #3b82f6 — desaturated
  infoSoft: 'rgba(89,137,185,0.10)'
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
  fontSans: "'Noto Sans JP', system-ui, sans-serif",
  fontMono: "'SF Mono', Monaco, Consolas, monospace"
} as const

/**
 * ASS left/right margin in pixels.
 * Single source of truth lives in shared/constants.ts; re-exported here so
 * renderer-side modules can import from one place without reaching into shared/.
 */
export { ASS_MARGIN_LR_PX } from '../../shared/constants'
