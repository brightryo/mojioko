import type { EncoderDetectionResult, H264Encoder, EncoderSetting } from '../../shared/ipc-contracts'

export type { EncoderDetectionResult, H264Encoder, EncoderSetting }

export const ENCODER_LABELS: Record<H264Encoder, string> = {
  h264_nvenc: 'NVIDIA H.264',
  h264_amf: 'AMD H.264',
  h264_qsv: 'Intel H.264',
  h264_mf: 'Media Foundation H.264'
}

export async function detectEncoders(): Promise<EncoderDetectionResult> {
  return window.electronAPI.detectEncoders()
}

export function resolveEffectiveEncoder(
  setting: EncoderSetting,
  detection: EncoderDetectionResult
): { encoder: H264Encoder; overridden: boolean } {
  if (setting === 'auto') {
    return { encoder: detection.best, overridden: false }
  }
  if (detection.available.includes(setting as H264Encoder)) {
    return { encoder: setting as H264Encoder, overridden: false }
  }
  return { encoder: detection.best, overridden: true }
}
