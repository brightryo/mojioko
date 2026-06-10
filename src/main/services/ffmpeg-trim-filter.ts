import type { Cut } from '../../shared/cuts'
import { buildKeptSegments } from '../../shared/cuts'

/**
 * REQ-074 1d — filter_complex builder for ffmpeg trim + concat + subtitles.
 *
 * Splits the source into kept segments (complement of `cuts` in
 * [0, originalDurationSec]), wraps each in `trim=start=A:end=B,
 * setpts=PTS-STARTPTS`, concats the result, then applies the subtitles=
 * filter to the post-concat video.  Audio is handled per source track and
 * either:
 *   - per-track output (audioMode === 'preserve', cuts present): keeps
 *     each source track as a separate output stream, aac re-encoded.
 *   - amix to a single stream (audioMode === 'simple'): same shape as the
 *     legacy no-cut amix path, but applied after per-track trim/concat.
 *
 * Returned `mapArgs` and `outputCodecArgs` are appended to the ffmpeg argv
 * in order.  When `audioTrackCount === 0` the function emits `-an` in
 * `outputCodecArgs` and omits all audio map entries.
 *
 * Pure function — no Electron or filesystem dependencies — so the unit
 * test exercises every branch without spawning ffmpeg.
 */
export interface TrimFilterResult {
  /** Value passed to ffmpeg `-filter_complex`. */
  filterComplex: string
  /** Sequence of `-map` argv pairs (e.g. ['-map', '[vout]', '-map', '[aout]']). */
  mapArgs: string[]
  /**
   * Sequence of output codec argv (e.g. ['-c:a', 'aac', '-b:a', '192k']
   * or ['-an']).  Encoder for video is decided elsewhere (encoder-detector)
   * and not included here.
   */
  outputCodecArgs: string[]
}

export function buildTrimConcatFilter(
  originalDurationSec: number,
  cuts: readonly Cut[],
  audioMode: 'simple' | 'preserve',
  audioTrackCount: number,
  subtitlesFilter: string,
): TrimFilterResult {
  const kept = buildKeptSegments(originalDurationSec, cuts)
  if (kept.length === 0) {
    throw new Error('buildTrimConcatFilter: no kept segments — every frame is cut')
  }

  // --- video chain ---
  const vTrim = kept
    .map(
      (seg, i) =>
        `[0:v]trim=start=${seg.startSec.toFixed(6)}:end=${seg.endSec.toFixed(6)},setpts=PTS-STARTPTS[v${i}]`,
    )
    .join(';')
  const vConcatInputs = kept.map((_, i) => `[v${i}]`).join('')
  const vConcat = `${vConcatInputs}concat=n=${kept.length}:v=1:a=0[vcat]`
  const vSubs = `[vcat]${subtitlesFilter}[vout]`
  const videoChain = `${vTrim};${vConcat};${vSubs}`

  const mapArgs: string[] = ['-map', '[vout]']

  // --- audio chain ---
  if (audioTrackCount <= 0) {
    return { filterComplex: videoChain, mapArgs, outputCodecArgs: ['-an'] }
  }

  // Per-track trim + concat — shared by both audio modes.
  const trackChains: string[] = []
  const trackCatLabels: string[] = []
  for (let t = 0; t < audioTrackCount; t++) {
    const aTrim = kept
      .map(
        (seg, i) =>
          `[0:a:${t}]atrim=start=${seg.startSec.toFixed(6)}:end=${seg.endSec.toFixed(6)},asetpts=PTS-STARTPTS[a${t}_${i}]`,
      )
      .join(';')
    const aConcatInputs = kept.map((_, i) => `[a${t}_${i}]`).join('')
    const aConcatLabel = `at${t}cat`
    const aConcat = `${aConcatInputs}concat=n=${kept.length}:v=0:a=1[${aConcatLabel}]`
    trackChains.push(`${aTrim};${aConcat}`)
    trackCatLabels.push(`[${aConcatLabel}]`)
  }

  const outputCodecArgs: string[] = ['-c:a', 'aac', '-b:a', '192k']

  if (audioMode === 'preserve') {
    for (const label of trackCatLabels) {
      mapArgs.push('-map', label)
    }
    return {
      filterComplex: `${videoChain};${trackChains.join(';')}`,
      mapArgs,
      outputCodecArgs,
    }
  }

  // simple — amix the per-track concat outputs.
  const amix = `${trackCatLabels.join('')}amix=inputs=${audioTrackCount}:duration=longest:normalize=0[aout]`
  mapArgs.push('-map', '[aout]')
  return {
    filterComplex: `${videoChain};${trackChains.join(';')};${amix}`,
    mapArgs,
    outputCodecArgs,
  }
}
