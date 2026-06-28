/**
 * REQ-086 — shared amix audio filter builder.
 *
 * Extracted from the legacy `ffmpeg-burnin.ts` no-cuts simple-audio path
 * (the block that wrapped every source track in `[0:a:i]` labels and
 * fed them into `amix=inputs=N:duration=longest:normalize=0[aout]`).
 * The byte-for-byte same filter string is now used by:
 *
 *   - `ffmpeg-burnin.ts`     — burn-in's simple audio mode, no cuts.
 *   - `preview-mix.ts`       — pre-generated multi-track preview audio
 *                              (always uses simple amix; preview never
 *                              applies cuts at generation time — those
 *                              are honoured at playback by useCutSkip).
 *
 * The trim+concat path (`ffmpeg-trim-filter.ts`) builds its OWN per-track
 * concat outputs first and then amixes those; it does not call into here
 * to avoid coupling the two filter shapes.
 *
 * Pure function — no Electron or filesystem dependencies — so the unit
 * tests in `tests/unit/preview-mix-filter.test.ts` exercise every branch
 * without spawning ffmpeg.
 */
export interface AmixFilterResult {
  /**
   * Value to pass to ffmpeg `-filter_complex`.  Empty string when
   * `audioTrackCount === 0` (caller emits `-an` via codecArgs) or
   * `audioTrackCount === 1` (caller maps `0:a:0` directly through
   * mapArgs — no filter graph needed for a single track).
   */
  filterComplex: string
  /**
   * Sequence of `-map` argv pairs.  For N === 0 callers usually do not
   * append this; for N === 1 we map the source track directly; for N >= 2
   * we map the `[aout]` filter output.
   */
  mapArgs: string[]
  /**
   * Sequence of output codec argv.  Always AAC 192 kbps for N >= 1 so the
   * preview matches the burn-in's simple-mode sound.  `['-an']` for N === 0.
   */
  codecArgs: string[]
}

export function buildAmixAudioFilter(audioTrackCount: number): AmixFilterResult {
  if (audioTrackCount <= 0) {
    return { filterComplex: '', mapArgs: [], codecArgs: ['-an'] }
  }
  // N === 1 deliberately goes through the same amix shape as N >= 2 even
  // though `amix=inputs=1` is a no-op pass-through.  This matches the
  // pre-REQ-086 burnin behaviour (which always used amix when N >= 1) and
  // the trim-concat filter convention (`ffmpeg-trim-filter.ts`).  Keeping
  // one shape across N=1..N keeps the call site simple and the
  // burnin's output byte-identical to the pre-REQ-086 single-track runs.
  const inputLabels = Array.from({ length: audioTrackCount }, (_, i) => `[0:a:${i}]`).join('')
  const filterComplex = `${inputLabels}amix=inputs=${audioTrackCount}:duration=longest:normalize=0[aout]`
  return {
    filterComplex,
    mapArgs: ['-map', '[aout]'],
    codecArgs: ['-c:a', 'aac', '-b:a', '192k'],
  }
}
