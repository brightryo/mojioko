/**
 * REQ-0447 / spec §3.4 — output resolution scaling for `mojioko burn`.
 *
 * `--resolution WxH` / `--preset <name>` re-canvases the output. We pre-scale
 * the source into the target canvas (fit + pad, aspect preserved) with a
 * separate ffmpeg pass — isolated from the shared burn service — then burn onto
 * the scaled video at PlayRes = target. Cue pixel fields are scaled by the
 * content scale factor so the subtitle keeps its apparent size.
 *
 * NOTE (spec §9): for aspect-changing presets (e.g. 16:9 → 9:16 "shorts") the
 * padded canvas means bottom-anchored placement lands relative to the FULL
 * canvas, not the video content band — WYSIWYG placement fidelity there needs
 * visual confirmation and may be refined. The output resolution itself is exact.
 */
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

/** Scale a cue's pixel-space fields so its apparent size is preserved (spec §3.4). */
export function scaleEntries(entries: SubtitleEntry[], f: number): SubtitleEntry[] {
  const px = (n: number): number => Math.max(1, Math.round(n * f))
  return entries.map((e) => ({
    ...e,
    fontSizePx: px(e.fontSizePx),
    outlineThicknessPx: Math.round(e.outlineThicknessPx * f),
    verticalMarginPx: Math.round(e.verticalMarginPx * f),
    ...(typeof e.posX === 'number' ? { posX: Math.round(e.posX * f) } : {}),
    ...(typeof e.posY === 'number' ? { posY: Math.round(e.posY * f) } : {}),
    ...(typeof e.shadowDepth === 'number' ? { shadowDepth: Math.round(e.shadowDepth * f) } : {}),
  }))
}

/**
 * Pre-scale `input` into a `w×h` canvas (fit + centered pad, aspect preserved),
 * writing a temp MP4 and resolving its path. Uses `h264_mf` (always available
 * on Windows; the bundled LGPL ffmpeg lacks libx264).
 */
export function scaleVideoTo(ffmpegPath: string, input: string, w: number, h: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const out = join(tmpdir(), `mojioko-scale-${process.pid}-${Date.now()}.mp4`)
    const vf = `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`
    const args = ['-y', '-i', input, '-vf', vf, '-c:v', 'h264_mf', '-c:a', 'aac', out]
    const proc = spawn(ffmpegPath, args, { windowsHide: true })
    let stderr = ''
    proc.stderr.on('data', (d) => {
      stderr += d.toString()
    })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) resolve(out)
      else reject(new Error(`ffmpeg scale failed (exit ${code}): ${stderr.slice(-300)}`))
    })
  })
}
