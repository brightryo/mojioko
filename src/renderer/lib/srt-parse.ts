/**
 * REQ-0223 — pure SRT parser.
 *
 * Parses the SRT text format `buildSrtContent` (step2.tsx) emits, plus
 * common variants written by DaVinci Resolve, Subtitle Edit, VLC, and
 * hand-edited files.  Kept as a pure function (no I/O, no store
 * mutation) so `tests/unit/srt-parse.test.ts` can exhaust the format
 * corner cases without spinning up the renderer.
 *
 * Supported inputs (permissive on the read path, matching what real-
 * world tools emit):
 *
 *   - UTF-8 with or without BOM (buildSrtContent emits BOM; VLC does not)
 *   - CRLF, LF, and mixed line endings
 *   - Multi-line captions (joined with the ASS `\N` sentinel to match
 *     MOJIOKO's internal representation — same convention `SubtitleEntry.text`
 *     uses everywhere else)
 *   - Optional numeric index line before the time line (SRT technically
 *     requires it, but we don't; the writer emits it, the reader tolerates
 *     its absence)
 *   - Leading / trailing whitespace on the whole file
 *   - Extra blank lines between blocks (2+, common in hand edits)
 *
 * Explicitly NOT supported (produces an error, not a silent drop):
 *
 *   - Time lines that don't match `HH:MM:SS,mmm --> HH:MM:SS,mmm`
 *   - Blocks with no text lines at all (a SRT block with a time but no
 *     caption is meaningless; buildSrtContent never emits these)
 *   - endSec < startSec (impossible; almost always a hand-edit typo)
 *
 * The parser returns whatever cues it CAN salvage plus a list of
 * human-readable errors (with 1-based line numbers).  The caller
 * (subtitle-table's import handler) uses the presence of errors as a
 * hard "don't clear the store" signal — see RES-0223 §6.
 */

export interface SrtCue {
  startSec: number
  endSec: number
  /** MOJIOKO's ASS-style `\N` sentinel for line breaks, never a raw newline. */
  text: string
}

export interface ParseSrtResult {
  cues: SrtCue[]
  /** Human-readable errors, each including a 1-based line number when possible. */
  errors: string[]
}

const TIME_LINE_RE =
  /^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*$/

/**
 * Convert `HH:MM:SS,mmm` (or its `.` variant emitted by some tools) to
 * seconds.  Returns null on syntactic mismatch; the caller records an
 * error with the surrounding line number.
 */
export function parseSrtTime(s: string): number | null {
  // Split around `,` or `.` for the millisecond separator (SRT spec is
  // `,` but WebVTT and a few tools emit `.` — accept both on read).
  const parts = s.trim().split(/[,.]/)
  if (parts.length !== 2) return null
  const hms = parts[0].split(':')
  if (hms.length !== 3) return null
  const h = Number(hms[0])
  const m = Number(hms[1])
  const sec = Number(hms[2])
  // Millisecond field may be 1-3 digits; pad-right to normalize
  // `1` → `100 ms`, `12` → `120 ms`, `123` → `123 ms`.  Matches
  // ffmpeg / SubtitleEdit's read behaviour on truncated writes.
  const msRaw = parts[1]
  if (!/^\d{1,3}$/.test(msRaw)) return null
  const ms = Number((msRaw + '000').slice(0, 3))
  if (!Number.isFinite(h) || !Number.isFinite(m) || !Number.isFinite(sec)) return null
  if (m >= 60 || sec >= 60) return null
  return h * 3600 + m * 60 + sec + ms / 1000
}

export function parseSrt(raw: string): ParseSrtResult {
  const cues: SrtCue[] = []
  const errors: string[] = []

  // Strip UTF-8 BOM if present (buildSrtContent prepends it for
  // DaVinci Resolve compatibility; the read path silently tolerates
  // it OR its absence).
  let text = raw
  if (text.charCodeAt(0) === 0xFEFF) {
    text = text.slice(1)
  }

  // Normalize line endings.  Some SRT writers emit CR-only (Mac
  // Classic era); we handle that too because the cost is a single
  // regex pass and files from vintage tools still show up.
  text = text.replace(/\r\n?/g, '\n')

  // Fast-path: empty file after trimming means no cues + no errors
  // (the caller treats this as "nothing to import" and doesn't touch
  // the store — RES-0223 §6's "importing 0 cues does not clear the
  // existing entries" contract).
  if (text.trim() === '') {
    return { cues, errors }
  }

  // Split into blocks on 2+ consecutive newlines.  This is more
  // permissive than the strict spec (exactly one blank line between
  // blocks) but matches what SubtitleEdit / VLC / hand-edited files
  // routinely produce.
  const blocks = text.split(/\n\s*\n+/)

  // Track the running line number so error messages can point at the
  // right source line.  We recompute by counting newlines up through
  // the current block position.
  let cursorLine = 1

  for (const rawBlock of blocks) {
    const blockStartLine = cursorLine
    // Advance the running cursor by this block's line count PLUS the
    // blank line(s) that separated it from the next.  Off-by-one is
    // fine — we only need approximate line numbers for error text.
    cursorLine += rawBlock.split('\n').length + 1

    const block = rawBlock.trim()
    if (block === '') continue  // stray whitespace-only block

    const lines = block.split('\n')

    // Skip a leading index line if present (`1`, `2`, `42`, ...).  If
    // absent, the first line IS the time line — this handles files
    // written without indexes.
    let idx = 0
    if (/^\d+\s*$/.test(lines[0])) idx = 1

    const timeLine = lines[idx]
    if (timeLine === undefined) {
      errors.push(`line ${blockStartLine}: block has no time line`)
      continue
    }

    const m = TIME_LINE_RE.exec(timeLine)
    if (!m) {
      errors.push(
        `line ${blockStartLine + idx}: could not parse time line: ${JSON.stringify(timeLine)}`,
      )
      continue
    }

    const startSec = parseSrtTime(`${m[1]}:${m[2]}:${m[3]},${m[4]}`)
    const endSec = parseSrtTime(`${m[5]}:${m[6]}:${m[7]},${m[8]}`)
    if (startSec === null || endSec === null) {
      errors.push(
        `line ${blockStartLine + idx}: time line values out of range: ${JSON.stringify(timeLine)}`,
      )
      continue
    }
    if (endSec < startSec) {
      errors.push(
        `line ${blockStartLine + idx}: end time precedes start time (${startSec.toFixed(3)}s > ${endSec.toFixed(3)}s)`,
      )
      continue
    }

    const textLines = lines.slice(idx + 1).map((l) => l.trimEnd())
    // Drop trailing empty text lines (a hand-edited block sometimes
    // has a stray blank line before the block separator).
    while (textLines.length > 0 && textLines[textLines.length - 1] === '') {
      textLines.pop()
    }
    if (textLines.length === 0) {
      errors.push(`line ${blockStartLine}: block has no caption text`)
      continue
    }

    // Join multi-line captions with the ASS `\N` sentinel that
    // MOJIOKO stores in `SubtitleEntry.text` everywhere else.  This
    // is the inverse of `buildSrtContent`'s `text.replace(/\\N/g, '\n')`.
    const jointText = textLines.join('\\N')

    cues.push({ startSec, endSec, text: jointText })
  }

  return { cues, errors }
}
