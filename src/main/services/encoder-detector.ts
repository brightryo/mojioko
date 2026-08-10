import { execFileAsync } from '../lib/child-process'
import { getBinPath } from '../lib/paths'
import type { H264Encoder, EncoderSetting } from '../../shared/types'
import log from '../lib/logger'

export type { H264Encoder }

// REQ-0460 — the per-encoder quality argument mapping is pure and lives in
// `shared/encode-quality.ts` (no electron deps) so it is unit-testable.
// Re-exported here so `buildEncoderArgs` keeps its historical import path.
export { buildEncoderArgs } from '../../shared/encode-quality'

const PRIORITY_ORDER: H264Encoder[] = ['h264_nvenc', 'h264_amf', 'h264_qsv', 'h264_mf']

let cachedAvailable: H264Encoder[] | null = null

export async function detectAvailableEncoders(): Promise<H264Encoder[]> {
  if (cachedAvailable !== null) return cachedAvailable

  const ffmpeg = getBinPath('ffmpeg')
  try {
    const result = await execFileAsync(ffmpeg, ['-encoders', '-hide_banner'], { timeout: 5000 })
    const stdout = String(result.stdout)
    cachedAvailable = PRIORITY_ORDER.filter((enc) => stdout.includes(enc))
    log.info(`[encoder-detector] available: ${cachedAvailable.join(', ') || 'none'}`)
  } catch (err) {
    log.warn('[encoder-detector] could not query ffmpeg -encoders, assuming h264_mf only', err)
    cachedAvailable = []
  }

  // h264_mf (Windows Media Foundation) is always available as the last resort
  if (!cachedAvailable.includes('h264_mf')) {
    cachedAvailable.push('h264_mf')
  }

  return cachedAvailable
}

export async function getBestEncoder(preferred: EncoderSetting = 'auto'): Promise<H264Encoder> {
  const available = await detectAvailableEncoders()

  if (preferred !== 'auto') {
    if (available.includes(preferred as H264Encoder)) {
      return preferred as H264Encoder
    }
    log.warn(`[encoder-detector] preferred encoder "${preferred}" not available, falling back to best`)
  }

  for (const enc of PRIORITY_ORDER) {
    if (available.includes(enc)) return enc
  }

  return 'h264_mf'
}
