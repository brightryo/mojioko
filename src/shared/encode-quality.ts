/**
 * REQ-0460 — pure encode-quality helpers shared by the burn path.
 *
 * Extracted from `main/services/encoder-detector.ts` (which imports electron via
 * `lib/paths`) so the per-encoder ffmpeg quality argument mapping and the
 * `--bitrate` string parser are unit-testable without an electron runtime.
 * `encoder-detector` re-exports `buildEncoderArgs` so existing importers are
 * unaffected.
 *
 * Design (see the REQ-0460 investigation): the GUI and CLI/MCP share this one
 * builder, whose default is CONSTANT-QUALITY (`-cq 20` for nvenc, `-quality 70`
 * for h264_mf, …) — content-adaptive, NOT a bitrate target.  An `EncodeQuality`
 * override lets a headless caller pin a value; passing none reproduces the
 * pre-REQ-0460 args byte-for-byte.
 */
import type { H264Encoder, EncodeQuality } from './types'

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, Math.round(n)))

/**
 * Resolve the numeric value for `encoder`'s constant-quality slot from an
 * optional override.  With no override this returns the historical per-encoder
 * default so `buildEncoderArgs` stays byte-identical to pre-REQ-0460.
 *
 * Scales differ by encoder: nvenc/qsv/amf use a CRF-like 0..51 (lower = better);
 * h264_mf uses 1..100 (higher = better).  `crf` is native to the former and
 * `quality` to the latter; each is translated to the other with a documented
 * linear approximation so a single flag works across whatever encoder resolves.
 */
export function constantQualityFor(encoder: H264Encoder, q: EncodeQuality): number {
  if (encoder === 'h264_mf') {
    // h264_mf `-quality`: 1..100, higher = better.  Default 70.
    if (typeof q.quality === 'number') return clamp(q.quality, 1, 100)
    if (typeof q.crf === 'number') return clamp(100 - q.crf * 1.6, 1, 100) // crf 18→71, 20→68, 28→55
    return 70
  }
  // CQ-style (nvenc -cq / qsv -global_quality / amf -qp_i): 0..51, lower = better.  Default 20.
  if (typeof q.crf === 'number') return clamp(q.crf, 0, 51)
  if (typeof q.quality === 'number') return clamp(51 - q.quality * 0.5, 0, 51) // quality 70→16, 100→1
  return 20
}

/**
 * ffmpeg arg arrays for each encoder.
 *
 * `quality` optionally overrides the built-in constant-quality default.  A
 * `bitrateKbps` override switches to a VBR bitrate target
 * (`-b:v`/`-maxrate`/`-bufsize`) universally; otherwise `crf`/`quality` feed the
 * encoder's constant-quality slot.  Passing no override reproduces the previous
 * fixed args (nvenc `-cq 20`, amf `-qp_i 20 -qp_p 22`, qsv `-global_quality 20`,
 * mf `-quality 70`).
 */
export function buildEncoderArgs(encoder: H264Encoder, quality?: EncodeQuality): string[] {
  const q = quality ?? {}

  // Bitrate target (VBR) wins over constant-quality — universal across encoders.
  if (typeof q.bitrateKbps === 'number' && q.bitrateKbps > 0) {
    const b = Math.round(q.bitrateKbps)
    const rate = ['-b:v', `${b}k`, '-maxrate', `${Math.round(b * 1.45)}k`, '-bufsize', `${Math.round(b * 2)}k`]
    switch (encoder) {
      case 'h264_nvenc':
        return ['-c:v', 'h264_nvenc', '-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', ...rate]
      case 'h264_amf':
        return ['-c:v', 'h264_amf', '-quality', 'quality', '-rc', 'vbr_peak', ...rate]
      case 'h264_qsv':
        return ['-c:v', 'h264_qsv', '-preset', 'slower', ...rate]
      case 'h264_mf':
        return ['-c:v', 'h264_mf', ...rate]
    }
  }

  const cq = constantQualityFor(encoder, q)
  switch (encoder) {
    case 'h264_nvenc':
      return ['-c:v', 'h264_nvenc', '-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', String(cq)]
    case 'h264_amf':
      return ['-c:v', 'h264_amf', '-quality', 'quality', '-rc', 'cqp', '-qp_i', String(cq), '-qp_p', String(cq + 2)]
    case 'h264_qsv':
      return ['-c:v', 'h264_qsv', '-preset', 'slower', '-global_quality', String(cq)]
    case 'h264_mf':
      return ['-c:v', 'h264_mf', '-rate_control', 'quality', '-quality', String(cq)]
  }
}

/**
 * Parse a `--bitrate` value into kbps.  Accepts `16M` (Mbps), `16000k` (kbps),
 * or a bare `16000` (treated as kbps).  Returns `undefined` for empty / invalid
 * input so the caller falls back to constant-quality.
 */
export function parseBitrateKbps(s: string | undefined): number | undefined {
  if (s === undefined || s === '') return undefined
  const m = /^(\d+(?:\.\d+)?)\s*([mMkK]?)$/.exec(s.trim())
  if (!m) return undefined
  const n = Number.parseFloat(m[1])
  if (!Number.isFinite(n) || n <= 0) return undefined
  const unit = m[2].toLowerCase()
  const kbps = unit === 'm' ? n * 1000 : n // 'k' or bare ⇒ already kbps
  return Math.round(kbps)
}
