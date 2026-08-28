/**
 * REQ-0414 — developer live-token editor: DOM side-effects.
 *
 * Split from `dev-tokens.ts` (pure) so the conversions stay unit-testable
 * without a browser.  Everything here reads the *running* document — the
 * current, possibly-already-overridden values — and writes overrides onto
 * `:root` (`document.documentElement`) for instant, app-wide live reflection.
 *
 * DEV-ONLY: only reached from the import.meta.env.DEV-guarded panel.
 */

import { hexToHslTriplet, hslTripletToHex, isHslTriplet, rgbStringToHex } from './dev-tokens'

/**
 * Resolve any CSS colour expression to `#rrggbb` by letting the browser do
 * the work (handles arbitrarily-nested `var()` chains).  Returns `#000000`
 * if resolution fails.
 */
function resolveColorExpr(expr: string): string {
  const probe = document.createElement('span')
  probe.style.color = expr
  probe.style.display = 'none'
  probe.setAttribute('aria-hidden', 'true')
  document.body.appendChild(probe)
  const rgb = getComputedStyle(probe).color
  probe.remove()
  return rgbStringToHex(rgb) ?? '#000000'
}

/**
 * Current rendered value of a colour token, as `#rrggbb`, seeding the native
 * colour input.  Resolves through the full `hsl(var(--x))` chain, so any live
 * override already applied is reflected.
 */
export function readColorHex(name: string): string {
  return resolveColorExpr(`hsl(var(--${name}))`)
}

/**
 * The token's current value as an HSL triplet (for display / export).
 * Prefers, in order:
 *   1. a live override we wrote on `:root` (exact),
 *   2. the authored value if the cascade exposes a bare triplet,
 *   3. a triplet re-derived from the resolved hex (may differ by ~1 step).
 */
export function readColorTriplet(name: string): string {
  const inline = document.documentElement.style.getPropertyValue(`--${name}`).trim()
  if (isHslTriplet(inline)) return inline
  const computed = getComputedStyle(document.documentElement)
    .getPropertyValue(`--${name}`)
    .trim()
  if (isHslTriplet(computed)) return computed
  return hexToHslTriplet(readColorHex(name)) ?? computed
}

/**
 * Apply a colour edit.  Accepts a hex (from the native input) and writes the
 * equivalent HSL triplet onto `:root`, so every `hsl(var(--name))` consumer
 * updates instantly.  No-op on malformed input.
 */
export function applyColorHex(name: string, hex: string): void {
  const triplet = hexToHslTriplet(hex)
  if (!triplet) return
  document.documentElement.style.setProperty(`--${name}`, triplet)
}

/** Apply a raw triplet override directly (used when seeding from export). */
export function applyColorTriplet(name: string, triplet: string): void {
  if (!isHslTriplet(triplet)) return
  document.documentElement.style.setProperty(`--${name}`, triplet)
}

/** Remove a colour override, reverting to the authored globals.css value. */
export function resetColor(name: string): void {
  document.documentElement.style.removeProperty(`--${name}`)
}

/* -------------------------------------------------------------------------
 * Font sizes — `--fs-<name>` backing (see tailwind.config.ts, REQ-0414)
 * ------------------------------------------------------------------------- */

/**
 * Current rendered size + line-height of a type-scale step, read from a probe
 * carrying the real `text-<name>` utility class — so the value comes from the
 * live cascade (fallback px, or an `--fs-*` override if one is applied).
 */
export function readSize(name: string): { px: number; lineHeight: string } {
  const probe = document.createElement('span')
  probe.className = `text-${name}`
  probe.style.position = 'absolute'
  probe.style.visibility = 'hidden'
  probe.style.pointerEvents = 'none'
  probe.textContent = 'Ag'
  probe.setAttribute('aria-hidden', 'true')
  document.body.appendChild(probe)
  const cs = getComputedStyle(probe)
  const px = parseFloat(cs.fontSize) || 0
  const lineHeight = cs.lineHeight
  probe.remove()
  return { px, lineHeight }
}

/** Override a type-scale step's size live via `--fs-<name>`. */
export function applySize(name: string, px: number): void {
  document.documentElement.style.setProperty(`--fs-${name}`, `${px}px`)
}

/** Remove a size override, reverting to the tailwind fallback px. */
export function resetSize(name: string): void {
  document.documentElement.style.removeProperty(`--fs-${name}`)
}

/* -------------------------------------------------------------------------
 * Alphas — plain 0–1 `:root` numbers (REQ-0526)
 *
 * Unlike colours these are read straight off the cascade rather than through a
 * probe: there is no `hsl()` chain to resolve, the value IS the number.
 * ------------------------------------------------------------------------- */

/** Current value of an alpha var, as a number.  Falls back to 1 if unset. */
export function readAlpha(name: string): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim()
  const n = Number.parseFloat(raw)
  return Number.isFinite(n) ? n : 1
}

/** Current value of an alpha var as authored text (for the export block). */
export function readAlphaRaw(name: string): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim()
  return raw === '' ? '1' : raw
}

/** Override an alpha live.  Clamped to [0, 1] — outside that CSS ignores it. */
export function applyAlpha(name: string, value: number): void {
  const v = Math.min(1, Math.max(0, value))
  // Trailing zeros trimmed so the export reads like the authored file
  // (`0.7`, not `0.70000000000000001`).
  document.documentElement.style.setProperty(`--${name}`, String(Number(v.toFixed(3))))
}

/** Remove an alpha override, reverting to the authored globals.css value. */
export function resetAlpha(name: string): void {
  document.documentElement.style.removeProperty(`--${name}`)
}

/** Remove every override this editor may have set. */
export function resetAll(
  colorNames: readonly string[],
  sizeNames: readonly string[],
  alphaNames: readonly string[] = [],
): void {
  const root = document.documentElement
  for (const n of colorNames) root.style.removeProperty(`--${n}`)
  for (const n of sizeNames) root.style.removeProperty(`--fs-${n}`)
  for (const n of alphaNames) root.style.removeProperty(`--${n}`)
}

// Re-export for panel convenience.
export { hslTripletToHex }
