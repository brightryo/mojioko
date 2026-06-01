/**
 * Design token constants for runtime use (canvas drawing, JS calculations).
 * For React components, prefer Tailwind utility classes defined in DESIGN_SYSTEM.md.
 */

export const colors = {
  // Background scale
  bgBase: '#0a0a0a',
  bgSurface: '#141414',
  bgElevated: '#171717',
  bgInput: '#0a0a0a',
  bgHover: '#1f1f1f',

  // Border scale
  borderDefault: '#27272a',
  borderStrong: '#3f3f46',
  borderSubtle: '#1f1f1f',

  // Text scale
  textPrimary: '#fafafa',
  textSecondary: '#a1a1aa',
  textTertiary: '#71717a',
  textMuted: '#52525b',
  textOnAccent: '#052e16',

  // Accent: green
  accent: '#22c55e',
  accentHover: '#16a34a',
  accentActive: '#15803d',
  accentSoft: 'rgba(34,197,94,0.10)',
  accentSoftBorder: 'rgba(34,197,94,0.20)',

  // Semantic
  warning: '#fbbf24',
  warningSoft: 'rgba(251,191,36,0.10)',
  danger: '#ef4444',
  dangerSoft: 'rgba(239,68,68,0.10)',
  success: '#22c55e',
  successSoft: 'rgba(34,197,94,0.10)',
  info: '#3b82f6',
  infoSoft: 'rgba(59,130,246,0.10)'
} as const

export const radius = {
  sm: 4,
  md: 6,
  lg: 8,
  xl: 10,
  '2xl': 12
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
