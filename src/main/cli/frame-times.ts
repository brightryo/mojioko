/**
 * REQ-0502 §1 — parsing and naming for `export_frame`'s multi-time capture.
 *
 * Pure and electron-free, so the cap, the rejection rules and the filename
 * scheme can be unit-tested without dragging in `frame-exporter` → `lib/paths`
 * → `electron`. (`commands/export-frame.ts` re-exports these so the command
 * remains the single import site for callers.)
 */
import { CliError } from './output'

/**
 * How many frames one call may produce.
 *
 * Each frame is a full two-pass ffmpeg render, so an unbounded list turns a
 * "quick check" into a multi-minute job. 20 is well past any verification need
 * — the point is sampling a burn, not extracting a sequence — and small enough
 * that the call stays interactive.
 */
export const EXPORT_FRAME_MAX_TIMES = 20

/**
 * Parse `--time` into one or more timestamps.
 *
 * Accepts `1.5` and `1.0,3.5,7.2`. Order and duplicates are preserved rather
 * than normalized: silently reordering or de-duplicating would make the result
 * differ from the request, which is the failure mode REQ-0499 onwards has been
 * removing. Filenames carry an index, so duplicates cannot collide.
 */
export function parseTimes(raw: string | undefined): number[] {
  const parts = (raw ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '')
  if (parts.length === 0) {
    throw new CliError('USAGE', '時刻（--time <秒>）が必要です。', 'mojioko export_frame ... --time 1.5   /   --time 1.0,3.5,7.2')
  }
  if (parts.length > EXPORT_FRAME_MAX_TIMES) {
    throw new CliError(
      'USAGE',
      `--time に指定できる時刻は最大 ${EXPORT_FRAME_MAX_TIMES} 件です（指定: ${parts.length} 件）。`,
      `時刻を ${EXPORT_FRAME_MAX_TIMES} 件以下に減らしてください。`,
      { max: EXPORT_FRAME_MAX_TIMES, requested: parts.length },
    )
  }
  return parts.map((p) => {
    const n = Number.parseFloat(p)
    if (!Number.isFinite(n) || n < 0 || !/^\d*\.?\d+$/.test(p)) {
      throw new CliError('USAGE', `--time の値が不正です: ${p}`, '例: --time 1.5 / --time 1.0,3.5,7.2')
    }
    return n
  })
}

/**
 * Per-frame output path for a multi-shot call.
 *
 * `out.png` + [1.0, 3.5] → `out-01-1.000s.png`, `out-02-3.500s.png`.
 * Index first so a directory listing sorts in request order; the timestamp is
 * in the name so an agent can tell which frame is which without reading the
 * result JSON. That readability is what makes skipping a contact sheet
 * acceptable (REQ-0502 §1-3).
 */
export function frameOutputPath(out: string, index: number, timeSec: number): string {
  const dot = out.lastIndexOf('.')
  const stem = dot > 0 ? out.slice(0, dot) : out
  const ext = dot > 0 ? out.slice(dot) : ''
  return `${stem}-${String(index + 1).padStart(2, '0')}-${timeSec.toFixed(3)}s${ext}`
}
