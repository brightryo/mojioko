import { describe, it, expect } from 'vitest'
import { buildEncoderArgs, constantQualityFor, parseBitrateKbps } from '../../src/shared/encode-quality'
import type { H264Encoder } from '../../src/shared/types'

/**
 * REQ-0460 — the CLI/MCP burn path shares `buildEncoderArgs` with the GUI.  The
 * default (no override) MUST stay byte-identical to the pre-REQ-0460 args, and
 * the crf/bitrate/quality overrides must map onto each encoder's knobs.
 */
describe('REQ-0460 — buildEncoderArgs default (byte-identical to pre-REQ-0460)', () => {
  it('reproduces the historical fixed args for every encoder', () => {
    expect(buildEncoderArgs('h264_nvenc')).toEqual(['-c:v', 'h264_nvenc', '-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', '20'])
    expect(buildEncoderArgs('h264_amf')).toEqual(['-c:v', 'h264_amf', '-quality', 'quality', '-rc', 'cqp', '-qp_i', '20', '-qp_p', '22'])
    expect(buildEncoderArgs('h264_qsv')).toEqual(['-c:v', 'h264_qsv', '-preset', 'slower', '-global_quality', '20'])
    expect(buildEncoderArgs('h264_mf')).toEqual(['-c:v', 'h264_mf', '-rate_control', 'quality', '-quality', '70'])
  })
  it('an empty override object is the same as no override', () => {
    for (const enc of ['h264_nvenc', 'h264_amf', 'h264_qsv', 'h264_mf'] as H264Encoder[]) {
      expect(buildEncoderArgs(enc, {})).toEqual(buildEncoderArgs(enc))
    }
  })
})

describe('REQ-0460 — crf override feeds the constant-quality slot', () => {
  it('nvenc/qsv/amf take crf directly on the 0..51 CQ scale', () => {
    expect(buildEncoderArgs('h264_nvenc', { crf: 18 })).toContain('18')
    expect(buildEncoderArgs('h264_nvenc', { crf: 18 }).slice(-2)).toEqual(['-cq', '18'])
    expect(buildEncoderArgs('h264_qsv', { crf: 30 }).slice(-2)).toEqual(['-global_quality', '30'])
    // amf keeps the +2 delta between qp_i and qp_p.
    const amf = buildEncoderArgs('h264_amf', { crf: 18 })
    expect(amf.slice(-4)).toEqual(['-qp_i', '18', '-qp_p', '20'])
  })
  it('crf is clamped to 0..51', () => {
    expect(buildEncoderArgs('h264_nvenc', { crf: 999 }).slice(-1)).toEqual(['51'])
    expect(buildEncoderArgs('h264_nvenc', { crf: -5 }).slice(-1)).toEqual(['0'])
  })
  it('h264_mf translates crf onto its inverted 1..100 -quality scale', () => {
    // crf 20 → 100 - 20*1.6 = 68
    expect(buildEncoderArgs('h264_mf', { crf: 20 }).slice(-2)).toEqual(['-quality', '68'])
  })
})

describe('REQ-0460 — quality override (1..100, higher = better)', () => {
  it('h264_mf takes quality directly', () => {
    expect(buildEncoderArgs('h264_mf', { quality: 85 }).slice(-2)).toEqual(['-quality', '85'])
  })
  it('cq encoders translate quality onto the CQ scale (lower = better)', () => {
    // quality 70 → 51 - 70*0.5 = 16
    expect(buildEncoderArgs('h264_nvenc', { quality: 70 }).slice(-2)).toEqual(['-cq', '16'])
  })
  it('crf wins over quality when both are present', () => {
    expect(buildEncoderArgs('h264_nvenc', { crf: 22, quality: 99 }).slice(-2)).toEqual(['-cq', '22'])
  })
})

describe('REQ-0460 — bitrate override switches to a VBR target (wins over crf/quality)', () => {
  it('emits -b:v/-maxrate/-bufsize on every encoder', () => {
    const nv = buildEncoderArgs('h264_nvenc', { bitrateKbps: 16000, crf: 18 })
    expect(nv).toContain('-b:v')
    expect(nv).toContain('16000k')
    expect(nv).toContain('-maxrate')
    expect(nv).toContain('23200k') // 16000 * 1.45
    expect(nv).toContain('-bufsize')
    expect(nv).toContain('32000k') // 16000 * 2
    // crf must NOT also appear — bitrate mode replaces constant-quality.
    expect(nv).not.toContain('-cq')
    expect(buildEncoderArgs('h264_mf', { bitrateKbps: 12000 })).toEqual(['-c:v', 'h264_mf', '-b:v', '12000k', '-maxrate', '17400k', '-bufsize', '24000k'])
  })
  it('a non-positive bitrate is ignored (falls back to constant quality)', () => {
    expect(buildEncoderArgs('h264_nvenc', { bitrateKbps: 0 })).toEqual(buildEncoderArgs('h264_nvenc'))
  })
})

describe('REQ-0460 — constantQualityFor defaults', () => {
  it('returns 20 for CQ encoders and 70 for mf with no override', () => {
    expect(constantQualityFor('h264_nvenc', {})).toBe(20)
    expect(constantQualityFor('h264_mf', {})).toBe(70)
  })
})

describe('REQ-0460 — parseBitrateKbps', () => {
  it('parses M / k / bare units into kbps', () => {
    expect(parseBitrateKbps('16M')).toBe(16000)
    expect(parseBitrateKbps('16m')).toBe(16000)
    expect(parseBitrateKbps('16000k')).toBe(16000)
    expect(parseBitrateKbps('16000')).toBe(16000)
    expect(parseBitrateKbps('1.5M')).toBe(1500)
  })
  it('returns undefined for empty / invalid input', () => {
    expect(parseBitrateKbps(undefined)).toBeUndefined()
    expect(parseBitrateKbps('')).toBeUndefined()
    expect(parseBitrateKbps('abc')).toBeUndefined()
    expect(parseBitrateKbps('0')).toBeUndefined()
    expect(parseBitrateKbps('-5M')).toBeUndefined()
  })
})
