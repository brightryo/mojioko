/**
 * REQ-0447 / spec §3.4 — output resolution scaling for `mojioko burn`.
 *
 * `--resolution WxH` / `--preset <name>` re-canvases the output. These pure
 * helpers resolve the target dims and scale the cue pixel fields by the content
 * scale factor so the subtitle keeps its apparent size.
 *
 * REQ-0460 — the ACTUAL video scaling is no longer a separate pre-encode. It was
 * a standalone `h264_mf` pass with no rate control (`scaleVideoTo`, removed)
 * that collapsed the output bitrate before the burn even ran. It is now folded
 * into the single burn encode via `BurninStartRequest.scaleTo` (see
 * `services/ffmpeg-burnin.ts`), so the source is scaled+padded and the ASS
 * burned at PlayRes = target in ONE cq-quality pass.
 *
 * NOTE (spec §9): for aspect-changing presets (e.g. 16:9 → 9:16 "shorts") the
 * padded canvas means bottom-anchored placement lands relative to the FULL
 * canvas, not the video content band — WYSIWYG placement fidelity there needs
 * visual confirmation and may be refined. The output resolution itself is exact.
 */
import type { SubtitleEntry } from '../../shared/types'

export interface TargetResolution {
  w: number
  h: number
}

/** Named presets (extensible). Vertical short-form is the primary target. */
export const RESOLUTION_PRESETS: Readonly<Record<string, [number, number]>> = {
  shorts: [1080, 1920],
  vertical: [1080, 1920],
  reels: [1080, 1920],
  tiktok: [1080, 1920],
  square: [1080, 1080],
  '1080p': [1920, 1080],
  '720p': [1280, 720],
}

/** Resolve `--resolution`/`--preset` to a target, or a usage error, or null (no scaling). */
export function resolveTarget(
  resolution: string | undefined,
  preset: string | undefined,
): { ok: true; target: TargetResolution | null } | { ok: false; message: string } {
  if (preset) {
    const p = RESOLUTION_PRESETS[preset]
    if (!p) return { ok: false, message: `unknown --preset "${preset}" (${Object.keys(RESOLUTION_PRESETS).join('|')})` }
    return { ok: true, target: { w: p[0], h: p[1] } }
  }
  if (resolution) {
    const m = /^(\d+)x(\d+)$/i.exec(resolution.trim())
    if (!m) return { ok: false, message: `invalid --resolution "${resolution}" (expected WxH, e.g. 1080x1920)` }
    return { ok: true, target: { w: Number(m[1]), h: Number(m[2]) } }
  }
  return { ok: true, target: null }
}

/** The content scale factor when fitting (origW×origH) inside (w×h) preserving aspect. */
export function contentScaleFactor(origW: number, origH: number, w: number, h: number): number {
  if (origW <= 0 || origH <= 0) return 1
  return Math.min(w / origW, h / origH)
}

/**
 * Scale a cue's pixel-space fields so its apparent size is preserved (spec §3.4).
 *
 * ## Three different rounding rules, on purpose (REQ-0503 §1)
 *
 * - **`fontSizePx`** — floored at 1 unconditionally. There is no such thing as
 *   a legitimate zero font size, so clamping can never contradict a request.
 * - **`outlineThicknessPx` / `shadowDepth`** — floored at 1 ONLY when the
 *   pre-scale value was already > 0. These are *effects that can be switched
 *   off by setting them to zero*, so an unconditional floor would turn an
 *   explicit `--outline 0` into a 1px outline the caller never asked for. But
 *   letting a REQUESTED effect round away to nothing is the other failure: at
 *   4K → shorts the factor is 0.28, so `--outline 1` became 0, the outline
 *   vanished, and the background box went with it (libass draws the box AS the
 *   border). "Preserve the apparent size" cannot mean "delete the feature".
 * - **`verticalMarginPx` / `posX` / `posY`** — plain rounding, no floor. These
 *   are POSITIONS, not effects. A margin that scales to 0 is genuinely at the
 *   edge, and flooring a coordinate would move the cue somewhere it was not
 *   asked to be.
 *
 * History: `px()` and its `Math.max(1, …)` arrived with this function
 * (REQ-0447 Phase 2b) and was wired to `fontSizePx` alone. Nothing documents or
 * tests the difference, and the simple fix — reusing `px()` — would have broken
 * `--outline 0`, so the nuanced form below was simply never written. Treated as
 * an omission rather than a decision (RES-0503 §1.1 records the evidence).
 */
export function scaleEntries(entries: SubtitleEntry[], f: number): SubtitleEntry[] {
  /** Sizes: never below 1, because 0 is not a meaningful size. */
  const px = (n: number): number => Math.max(1, Math.round(n * f))
  /** Effects: 0 stays 0 (switched off); anything positive survives as ≥1. */
  const effectPx = (n: number): number => (n > 0 ? Math.max(1, Math.round(n * f)) : Math.round(n * f))
  return entries.map((e) => ({
    ...e,
    fontSizePx: px(e.fontSizePx),
    outlineThicknessPx: effectPx(e.outlineThicknessPx),
    verticalMarginPx: Math.round(e.verticalMarginPx * f),
    ...(typeof e.posX === 'number' ? { posX: Math.round(e.posX * f) } : {}),
    ...(typeof e.posY === 'number' ? { posY: Math.round(e.posY * f) } : {}),
    ...(typeof e.shadowDepth === 'number' ? { shadowDepth: effectPx(e.shadowDepth) } : {}),
  }))
}
