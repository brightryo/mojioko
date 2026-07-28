/**
 * REQ-0342 §1 — generate a test SRT of any size, for performance work.
 *
 *   npm run gen:srt -- --count 1000 --duration 3600 --kind ja --out test-1000.srt
 *
 * ## Why this lives in scripts/ and not in the scratchpad
 *
 * CLAUDE.md §18: "would you write this again the next time you add the same
 * kind of thing?"  Yes — every future performance question ("is the timeline
 * still usable at 3000 cues?", "did the import path regress?") starts by
 * needing a file of that size, and hand-making one is exactly the work this
 * removes.  Same standing as `scripts/verify-outline-ring/`.
 *
 * ## Output format
 *
 * Byte-compatible with what the app's own exporter (`buildSrtContent` in
 * `routes/step2.tsx`) writes: UTF-8 BOM, 1-based index line, `HH:MM:SS,mmm -->
 * HH:MM:SS,mmm`, caption text, blocks separated by a blank line.  The BOM is
 * what DaVinci Resolve requires.  `src/renderer/lib/srt-parse.ts` reads it
 * back, so a generated file round-trips through 「SRT を読み込む」 unchanged.
 *
 * ## Text kinds, and which code path each one is for
 *
 * The point of having four is that the wrap algorithm takes a different route
 * through `applyAutoLineBreak` for each, and a benchmark that only ever feeds
 * it Japanese measures one third of the function:
 *
 *   ja     — CJK, no spaces.  Breaks land per character; `adjustBreak` never
 *            fires (it needs Latin word characters on BOTH sides).  Kinsoku
 *            applies: the corpus deliberately contains 、。」 so the
 *            no-line-start / no-line-end tables actually do something.
 *   en     — Latin with spaces.  This is the `adjustBreak` path: the
 *            pixel-accurate break gets nudged back to a word boundary.
 *   mixed  — Japanese with embedded Latin words and numbers, so kinsoku AND
 *            Latin-word protection run on the same cue.
 *   long   — 2-3 rendered lines per cue at the default 100 px / 1920 px.
 *            Exercises the multi-segment loop rather than the single-break
 *            case, and is what a "long transcript" actually looks like.
 *
 * Text is drawn deterministically from the corpus (index-derived, no RNG), so
 * two runs with the same arguments produce byte-identical files and a
 * before/after measurement compares like with like.
 */
import { writeFileSync } from 'fs'
import path from 'path'

const KINDS = ['ja', 'en', 'mixed', 'long']

/**
 * Sentence fragments per kind.  Short enough to combine; the generator
 * concatenates 1..n of them to hit the requested line count.
 */
const CORPUS = {
  ja: [
    'こんにちは、今日はいい天気ですね。',
    'この動画では字幕の付け方を説明します。',
    'まず最初に、音声を読み込んでください。',
    '次に「文字起こし」ボタンを押します。',
    '処理には数分かかる場合があります。',
    '完了したら内容を確認しましょう。',
    '誤変換があれば手動で修正できます。',
    'フォントや色は後から変更できます。',
  ],
  en: [
    'Hello and welcome back to the channel.',
    'Today we are going to look at subtitles.',
    'First, load the audio track you want.',
    'Then press the transcribe button below.',
    'This can take a few minutes to finish.',
    'Check the result once it has completed.',
    'You can fix any mistakes by hand later.',
    'Fonts and colours are adjustable too.',
  ],
  mixed: [
    'この動画では Whisper を使って文字起こしします。',
    'まず MP4 ファイルを読み込んでください。',
    'GPU があれば CUDA で高速に処理されます。',
    '「large-v3」モデルは精度が高いです。',
    '処理時間はおよそ 3 分から 5 分ほどです。',
    'SRT や MP4 で書き出すことができます。',
    'DaVinci Resolve にも読み込めます。',
    'フォントは Noto Sans JP が既定です。',
  ],
  long: [
    'この動画では、音声の文字起こしから字幕の焼き込みまでを、一通り順番に説明していきます。',
    'まず最初に動画ファイルを読み込み、使用する音声トラックを選んでから文字起こしを実行してください。',
    '処理が完了すると、認識結果が一覧で表示されるので、誤変換があればその場で修正することができます。',
    'フォント、文字サイズ、縁取りの色や太さ、背景ボックスの有無などは、あとからまとめて変更できます。',
    'The transcription runs entirely on your own machine, so nothing is uploaded to any server at any point.',
    '書き出しは SRT ファイルとしても、字幕を焼き込んだ MP4 としても保存することが可能になっています。',
  ],
}

function usage(msg) {
  if (msg) console.error(`error: ${msg}\n`)
  console.error(`generate-test-srt — REQ-0342 §1

  npm run gen:srt -- [options]

Options
  --count <n>        number of cues            (default 230)
  --duration <sec>   video length in seconds   (default 3600 = 1 hour)
  --cue <sec>        on-screen time per cue    (default: fills the timeline)
  --gap <sec>        silence between cues      (default 0.2)
  --kind <k>         ${KINDS.join(' | ')}      (default ja)
  --lines <n>        corpus fragments per cue  (default 1; 'long' implies 1)
  --out <path>       output file               (default test-<count>-<kind>.srt)

Examples
  npm run gen:srt -- --count 230  --duration 3600 --kind ja
  npm run gen:srt -- --count 1000 --duration 3600 --kind mixed
  npm run gen:srt -- --count 3000 --duration 3600 --kind long --out big.srt

Notes
  * Cues are laid out evenly across --duration.  If --count x (--cue + --gap)
    exceeds --duration the cue length is shrunk to fit and a note is printed,
    so the file always describes a real timeline.
  * Output is UTF-8 with BOM, the same shape the app's own SRT export writes,
    so 「SRT を読み込む」 reads it directly.`)
  process.exit(msg ? 1 : 0)
}

function parseArgs(argv) {
  const out = {
    count: 230, duration: 3600, cue: null, gap: 0.2, kind: 'ja', lines: 1, out: null,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') usage()
    const val = argv[++i]
    if (val === undefined) usage(`${a} needs a value`)
    switch (a) {
      case '--count': out.count = Number(val); break
      case '--duration': out.duration = Number(val); break
      case '--cue': out.cue = Number(val); break
      case '--gap': out.gap = Number(val); break
      case '--lines': out.lines = Number(val); break
      case '--kind': out.kind = val; break
      case '--out': out.out = val; break
      default: usage(`unknown option ${a}`)
    }
  }
  if (!Number.isFinite(out.count) || out.count < 1) usage('--count must be >= 1')
  if (!Number.isFinite(out.duration) || out.duration <= 0) usage('--duration must be > 0')
  if (!KINDS.includes(out.kind)) usage(`--kind must be one of ${KINDS.join(', ')}`)
  if (!Number.isFinite(out.lines) || out.lines < 1) usage('--lines must be >= 1')
  return out
}

/** `HH:MM:SS,mmm` — identical to `formatSrtTime` in routes/step2.tsx. */
function formatSrtTime(sec) {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  const ms = Math.round((sec % 1) * 1000)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:` +
         `${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`
}

/**
 * Deterministic text for cue `i`.  Index-derived rather than random so the
 * same arguments always produce the same bytes — a benchmark that changed its
 * own input between runs would not be a benchmark.
 */
function textFor(kind, lines, i) {
  const pool = CORPUS[kind]
  const n = kind === 'long' ? 1 : lines
  const parts = []
  for (let k = 0; k < n; k++) parts.push(pool[(i * 3 + k * 5) % pool.length])
  return parts.join(kind === 'en' ? ' ' : '')
}

const opts = parseArgs(process.argv.slice(2))

// Lay the cues out evenly across the timeline.  `--cue` overrides the length
// but never past the point where the last cue would run off the end.
const slot = opts.duration / opts.count
let cueLen = opts.cue ?? Math.max(0.1, slot - opts.gap)
let shrunk = false
if (cueLen + opts.gap > slot) {
  cueLen = Math.max(0.1, slot - opts.gap)
  shrunk = opts.cue !== null
}

const blocks = []
for (let i = 0; i < opts.count; i++) {
  const startSec = i * slot
  const endSec = startSec + cueLen
  blocks.push(
    `${i + 1}\n${formatSrtTime(startSec)} --> ${formatSrtTime(endSec)}\n` +
    textFor(opts.kind, opts.lines, i),
  )
}

const outPath = path.resolve(opts.out ?? `test-${opts.count}-${opts.kind}.srt`)
// BOM first — DaVinci Resolve requires it, and `srt-parse.ts` strips it.
writeFileSync(outPath, '﻿' + blocks.join('\n\n'), 'utf8')

console.log(`wrote ${outPath}`)
console.log(`  cues        ${opts.count}`)
console.log(`  kind        ${opts.kind}${opts.kind === 'long' ? '' : ` (x${opts.lines} fragment(s))`}`)
console.log(`  timeline    ${opts.duration}s  (slot ${slot.toFixed(3)}s)`)
console.log(`  cue length  ${cueLen.toFixed(3)}s + ${opts.gap}s gap`)
if (shrunk) console.log(`  note: --cue was shrunk to fit ${opts.count} cues into ${opts.duration}s`)
