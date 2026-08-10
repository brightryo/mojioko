/**
 * REQ-0447 §3.6 / REQ-0449 §3 — `mojioko help` / `-h` / `--help`.
 *
 * Top-level help: overview, command list, chained example, common flags,
 * exit-code summary, references. Per-command help: options + examples.
 * `--json` returns a MACHINE-READABLE structure with every command, every
 * option (type / required / default / allowed values), the exit-code table, and
 * the stable error-code strings — so an agent can build commands with no
 * guessing (REQ-0449 §3).
 */
import { APP_VERSION } from '../../shared/app-info'
import { CODE_TO_EXIT, EXIT_OK, type CliContext } from './output'

type OptType = 'string' | 'boolean' | 'int' | 'float' | 'enum' | 'path'

interface OptionSpec {
  flag: string
  type: OptType
  required?: boolean
  default?: string
  values?: string[]
  desc: string
}

interface PositionalSpec {
  name: string
  required: boolean
  desc: string
}

interface CommandDoc {
  name: string
  summary: string
  usage: string
  positionals: PositionalSpec[]
  optionSpecs: OptionSpec[]
  examples: string[]
  errorCodes: string[]
}

const LANGS = ['auto', 'ja', 'en', 'zh', 'ko', 'es', 'fr', 'de', 'pt', 'ru', 'ar']
const TARGETS = ['en', 'ja', 'es', 'fr', 'de', 'pt']
const WEIGHTS = ['Thin', 'ExtraLight', 'Light', 'Regular', 'Medium', 'SemiBold', 'Bold', 'ExtraBold', 'Black']
const PRESETS = ['shorts', 'vertical', 'reels', 'tiktok', 'square', '1080p', '720p']

const OUT_REQ: OptionSpec = { flag: '-o, --out', type: 'path', required: true, desc: '出力ファイルパス' }
const DEVICE: OptionSpec = { flag: '--device', type: 'enum', values: ['cpu', 'gpu'], desc: '実行デバイス（既定: 設定の activeAccelerator）' }
const STRICT: OptionSpec = { flag: '--strict', type: 'boolean', default: 'false', desc: '--device gpu で CUDA 不可なら fallback せず失敗' }

const COMMANDS: CommandDoc[] = [
  {
    name: 'status',
    summary: '一括の状態＋ready/blockers（エージェントの最初の一手）',
    usage: 'mojioko status [--json]',
    positionals: [],
    optionSpecs: [],
    examples: ['mojioko status --json'],
    errorCodes: [],
  },
  {
    name: 'tools',
    summary: 'ツール・モデル・GPU の状態照会とセットアップ（list / download / use）',
    usage: 'mojioko tools [list|download <whisper|translation|gpu>|use <whisper|translation|device> <value>]',
    positionals: [
      { name: 'subcommand', required: false, desc: 'list（既定）| download | use' },
      { name: 'target', required: false, desc: 'whisper | translation | gpu | device' },
      { name: 'value', required: false, desc: 'use device の cpu|gpu 等' },
    ],
    optionSpecs: [
      { flag: '--model', type: 'string', desc: 'whisper: large-v3|large-v3-turbo / translation: 3b|7b' },
      { flag: '--device', type: 'enum', values: ['cpu', 'gpu'], desc: 'use device の値（位置引数でも可）' },
      { flag: '--force', type: 'boolean', default: 'false', desc: 'アプリ起動中でも設定を上書き（use）' },
    ],
    examples: ['mojioko tools', 'mojioko tools download whisper --model large-v3-turbo', 'mojioko tools use device gpu'],
    errorCodes: ['USAGE', 'MODEL_NOT_FOUND', 'TOOL_NOT_DOWNLOADED', 'OUTPUT_WRITE_FAILED'],
  },
  {
    name: 'transcribe',
    summary: '動画/音声 → 字幕（.mojioko / SRT）',
    usage: 'mojioko transcribe <input> -o <out>',
    positionals: [{ name: 'input', required: true, desc: '入力の動画/音声ファイル' }],
    optionSpecs: [
      OUT_REQ,
      { flag: '--model', type: 'enum', values: ['large-v3', 'large-v3-turbo'], desc: '既定: 設定のアクティブモデル' },
      { flag: '--lang', type: 'enum', values: LANGS, default: 'auto', desc: '言語（自動検出=auto）' },
      { flag: '--track', type: 'int', default: '1', desc: '音声トラック（1-based）' },
      { flag: '--vad', type: 'enum', values: ['on', 'off'], default: 'on', desc: 'VAD フィルタ' },
      { flag: '--vad-threshold', type: 'float', default: '0.5', desc: 'VAD しきい値 0..1' },
      { flag: '--beam-size', type: 'int', default: '5', desc: 'ビームサイズ' },
      { flag: '--min-speech-ms', type: 'int', default: '250', desc: '最小発話長(ms)' },
      { flag: '--min-silence-ms', type: 'int', default: '2000', desc: '最小無音長(ms)' },
      { flag: '--format', type: 'enum', values: ['mojioko', 'srt'], desc: '既定: -o 拡張子から判定' },
      DEVICE,
      STRICT,
    ],
    examples: ['mojioko transcribe input.mp4 -o out.mojioko --lang ja'],
    errorCodes: ['INPUT_NOT_FOUND', 'UNSUPPORTED_FORMAT', 'MODEL_NOT_FOUND', 'TRANSCRIBE_FAILED', 'OUTPUT_WRITE_FAILED', 'GPU_INIT_FAILED'],
  },
  {
    name: 'translate',
    summary: '字幕 → 字幕（既定=現在テキスト / --from-original で原文から）',
    usage: 'mojioko translate <input> --to <lang> -o <out>',
    positionals: [{ name: 'input', required: true, desc: '.mojioko または .srt' }],
    optionSpecs: [
      { flag: '--to', type: 'enum', values: TARGETS, required: true, desc: '翻訳先言語' },
      OUT_REQ,
      { flag: '--model', type: 'enum', values: ['3b', '7b'], desc: '既定: 設定のアクティブ翻訳モデル' },
      { flag: '--from-original', type: 'boolean', default: 'false', desc: '文字起こし原文から訳す（.mojioko 必須）' },
      { flag: '--format', type: 'enum', values: ['mojioko', 'srt'], desc: '既定: -o 拡張子から判定' },
      DEVICE,
      STRICT,
    ],
    examples: ['mojioko translate out.mojioko --to en --from-original -o out.en.mojioko'],
    errorCodes: ['INPUT_NOT_FOUND', 'UNSUPPORTED_FORMAT', 'TOOL_NOT_DOWNLOADED', 'DEPS_MISSING', 'TRANSLATION_FAILED', 'OUTPUT_WRITE_FAILED'],
  },
  {
    name: 'burn',
    summary: '字幕焼き込み（libass）。解像度/プリセット対応。フォントはアプリ既定スタイルを継承',
    usage: 'mojioko burn <video> <subtitle> -o <out.mp4>',
    positionals: [
      { name: 'video', required: true, desc: '入力動画' },
      { name: 'subtitle', required: true, desc: '.mojioko または .srt' },
    ],
    optionSpecs: [
      OUT_REQ,
      { flag: '--preset', type: 'enum', values: PRESETS, desc: '出力プリセット（縦ショート等）' },
      { flag: '--resolution', type: 'string', desc: 'WxH（例 1080x1920）。--preset と排他' },
      { flag: '--margin-v', type: 'int', desc: '縦マージン(px)' },
      { flag: '--margin-x', type: 'int', default: '10', desc: '横マージン(px)。改行幅＋ASS MarginL/R' },
      { flag: '--margin-y', type: 'int', default: '10', desc: '縦オーバーフロー判定の上下安全域(px)' },
      { flag: '--overflow', type: 'enum', values: ['shrink', 'warn', 'error'], default: 'warn', desc: '縦はみ出し（warn=計上 / shrink=自動縮小 / error=失敗）' },
      { flag: '--encoder', type: 'enum', values: ['auto', 'h264_nvenc', 'h264_amf', 'h264_qsv', 'h264_mf'], default: 'auto', desc: '映像エンコーダ' },
      { flag: '--crf', type: 'int', desc: '画質(定質) 0..51 低いほど高画質。既定=エンコーダ既定(≈GUI)' },
      { flag: '--bitrate', type: 'string', desc: 'VBR目標ビットレート（例 16M / 16000k）。crf/quality より優先' },
      { flag: '--quality', type: 'int', desc: '画質 1..100 高いほど高画質（h264_mf 基準・crf の代替）' },
      { flag: '--audio', type: 'enum', values: ['preserve', 'simple', 'none'], default: 'simple', desc: '音声処理' },
      { flag: '--container', type: 'enum', values: ['mp4', 'same'], default: 'mp4', desc: '出力コンテナ' },
      { flag: '--weight', type: 'enum', values: WEIGHTS, desc: 'フォントウェイト（既定=アプリ設定）' },
      { flag: '--font-size', type: 'int', desc: 'フォントサイズ上書き(px)' },
      { flag: '--text-color', type: 'string', desc: '文字色 #RRGGBB' },
      { flag: '--outline-color', type: 'string', desc: '縁色 #RRGGBB' },
      { flag: '--outline', type: 'int', desc: '縁の太さ(px)' },
      { flag: '--position', type: 'enum', values: ['top', 'center', 'bottom'], desc: '縦位置' },
      { flag: '--style', type: 'string', desc: 'GUI 保存のスタイルプリセット名を全 cue に適用（status で一覧）' },
      { flag: '--overwrite', type: 'boolean', default: 'false', desc: '既存出力を上書き（既定は拒否）' },
      { flag: '--dry-run', type: 'boolean', default: 'false', desc: '焼かずに overflow(shrink/warn/error)判定のみ返す' },
      DEVICE,
    ],
    examples: ['mojioko burn input.mp4 out.en.mojioko -o final.mp4 --preset shorts --style "My Bold"'],
    errorCodes: ['INPUT_NOT_FOUND', 'UNSUPPORTED_FORMAT', 'USAGE', 'SUBTITLE_OVERFLOW', 'BURN_FAILED', 'OUTPUT_WRITE_FAILED'],
  },
  {
    name: 'run',
    summary: '統合ワンショット（transcribe → translate → burn を内部連結）',
    usage: 'mojioko run <video> [--translate <lang>] [--burn] -o <out>',
    positionals: [{ name: 'video', required: true, desc: '入力動画' }],
    optionSpecs: [
      OUT_REQ,
      { flag: '--subtitle', type: 'path', desc: '既存字幕を渡すと文字起こしをスキップ（REQ-0457 D11）' },
      { flag: '--translate', type: 'enum', values: TARGETS, desc: '指定時に翻訳を挟む' },
      { flag: '--burn', type: 'boolean', default: 'false', desc: '焼き込みまで実行（-o は .mp4）' },
      { flag: '--preset', type: 'enum', values: PRESETS, desc: 'burn 用（--burn 時）' },
      { flag: '--style', type: 'string', desc: 'スタイルプリセット名（--burn 時）' },
      { flag: '--overwrite', type: 'boolean', default: 'false', desc: '既存出力を上書き' },
      DEVICE,
      STRICT,
    ],
    examples: ['mojioko run input.mp4 --translate en --burn -o final.mp4 --preset shorts'],
    errorCodes: ['(各段のエラーコードを継承)'],
  },
  {
    name: 'export_frame',
    summary: '動画＋字幕の1フレームを指定時刻で PNG/JPG 出力（焼き上がりを画像で検証）',
    usage: 'mojioko export_frame <video> <subtitle> -o <out.png> --time <sec>',
    positionals: [
      { name: 'video', required: true, desc: '入力動画' },
      { name: 'subtitle', required: true, desc: '.mojioko または .srt' },
    ],
    optionSpecs: [
      OUT_REQ,
      { flag: '--time', type: 'float', required: true, desc: '抽出する時刻（秒）' },
      { flag: '--format', type: 'enum', values: ['mojioko', 'srt'], desc: '字幕フォーマット（既定: 拡張子）' },
    ],
    examples: ['mojioko export_frame input.mp4 out.mojioko -o frame.png --time 1.5'],
    errorCodes: ['INPUT_NOT_FOUND', 'UNSUPPORTED_FORMAT', 'USAGE', 'BURN_FAILED'],
  },
  {
    name: 'probe',
    summary: '動画/音声のメタ情報（尺・解像度・fps・音声トラック）',
    usage: 'mojioko probe <video>',
    positionals: [{ name: 'video', required: true, desc: '動画/音声ファイル' }],
    optionSpecs: [],
    examples: ['mojioko probe input.mp4'],
    errorCodes: ['INPUT_NOT_FOUND', 'UNSUPPORTED_FORMAT', 'USAGE'],
  },
  {
    name: 'read_subtitle',
    summary: '字幕の cue 一覧（index/開始/終了/テキスト）を返す',
    usage: 'mojioko read_subtitle <subtitle>',
    positionals: [{ name: 'subtitle', required: true, desc: '.mojioko または .srt' }],
    optionSpecs: [{ flag: '--format', type: 'enum', values: ['mojioko', 'srt'], desc: '既定: 拡張子' }],
    examples: ['mojioko read_subtitle out.mojioko'],
    errorCodes: ['INPUT_NOT_FOUND', 'UNSUPPORTED_FORMAT', 'USAGE'],
  },
  {
    name: 'edit_subtitle',
    summary: 'cue 単位でテキストを差し替える（.mojioko はスタイル保持）',
    usage: 'mojioko edit_subtitle <in> -o <out> --index N --text "..."',
    positionals: [{ name: 'subtitle', required: true, desc: '.mojioko または .srt' }],
    optionSpecs: [
      OUT_REQ,
      { flag: '--index', type: 'int', required: true, desc: '対象 cue 番号（0始まり・read_subtitle 参照）' },
      { flag: '--text', type: 'string', required: true, desc: '新しいテキスト' },
    ],
    examples: ['mojioko edit_subtitle out.mojioko -o out.mojioko --index 3 --text "正しいテキスト"'],
    errorCodes: ['INPUT_NOT_FOUND', 'UNSUPPORTED_FORMAT', 'USAGE', 'OUTPUT_WRITE_FAILED'],
  },
  {
    name: 'convert',
    summary: '字幕フォーマット変換（.mojioko ↔ .srt・再文字起こしなし）',
    usage: 'mojioko convert <in> -o <out> [--video <path>]',
    positionals: [{ name: 'subtitle', required: true, desc: '.mojioko または .srt' }],
    optionSpecs: [
      OUT_REQ,
      { flag: '--video', type: 'path', desc: 'SRT→.mojioko 時に参照する動画（任意）' },
    ],
    examples: ['mojioko convert out.mojioko -o out.srt'],
    errorCodes: ['INPUT_NOT_FOUND', 'UNSUPPORTED_FORMAT', 'USAGE', 'OUTPUT_WRITE_FAILED'],
  },
]

const COMMON_FLAGS: [string, string][] = [
  ['--json / --no-json', 'stdout に結果 JSON を出す（既定 on。help は既定テキスト）'],
  ['--quiet', 'stderr の進捗・info を抑止'],
  ['--verbose', 'stderr に debug ログを追加'],
  ['-h, --help', 'ヘルプを表示'],
  ['--version', 'バージョンを表示'],
]

const EXIT_SUMMARY: [number, string][] = [
  [0, '成功'],
  [1, 'その他/未実装 (UNEXPECTED / NOT_IMPLEMENTED)'],
  [2, '引数・使用法エラー (USAGE)'],
  [3, '入力ファイルなし・読取不可 (INPUT_NOT_FOUND)'],
  [4, '非対応フォーマット (UNSUPPORTED_FORMAT)'],
  [5, '必要ツール未 DL (TOOL_NOT_DOWNLOADED / MODEL_NOT_FOUND)'],
  [6, '環境依存の欠如 (DEPS_MISSING / GPU_INIT_FAILED --strict)'],
  [7, '処理実行時失敗 (TRANSCRIBE/TRANSLATION/BURN_FAILED)'],
  [8, '出力書込失敗 (OUTPUT_WRITE_FAILED)'],
  [9, '縦オーバーフロー (SUBTITLE_OVERFLOW, --overflow=error)'],
  [130, 'ユーザーキャンセル (CANCELED, SIGINT)'],
]

const ERROR_CODE_DESCRIPTIONS: Record<string, string> = {
  USAGE: '引数・使用法エラー',
  INPUT_NOT_FOUND: '入力ファイルが無い/読めない',
  UNSUPPORTED_FORMAT: '非対応フォーマット',
  TOOL_NOT_DOWNLOADED: 'ツール/翻訳/GPU が未 DL',
  MODEL_NOT_FOUND: '指定モデルが未導入',
  DEPS_MISSING: 'Python 依存/ffmpeg 等の欠如',
  GPU_INIT_FAILED: 'CUDA 初期化失敗（既定は warning、--strict で致命）',
  TRANSCRIBE_FAILED: '文字起こし実行失敗',
  TRANSLATION_FAILED: '翻訳実行失敗',
  BURN_FAILED: '焼き込み失敗',
  OUTPUT_WRITE_FAILED: '出力書込失敗',
  OUTPUT_EXISTS: '出力が既存（--overwrite 未指定）',
  SUBTITLE_OVERFLOW: '縦オーバーフロー（--overflow=error）',
  CANCELED: 'ユーザーキャンセル',
  NOT_IMPLEMENTED: '未実装',
  UNEXPECTED: '未分類の失敗',
}

const WARNING_CODES: [string, string][] = [
  ['GPU_INIT_FAILED', 'CPU フォールバック時（成功レスポンス内）'],
  ['SUBTITLE_OVERFLOW', '--overflow warn 時（成功レスポンス内）'],
  ['FONT_UNAVAILABLE', '利用不可フォントを Noto へ置換（成功レスポンス内）'],
  ['FONT_RESTRICTED', '同上（tier/未同梱）'],
]

const CHAINED_EXAMPLE = [
  '# 0) まず状態確認',
  'mojioko status --json',
  '# 1) 文字起こし → プロジェクト',
  'mojioko transcribe input.mp4 -o out.mojioko --lang ja',
  '# 2) 英語へ翻訳（原文から）',
  'mojioko translate out.mojioko --to en --from-original -o out.en.mojioko',
  '# 3) 焼き込み（縦ショート）',
  'mojioko burn input.mp4 out.en.mojioko -o final.mp4 --preset shorts',
  '# ワンショット（同等）',
  'mojioko run input.mp4 --translate en --burn -o final.mp4',
]

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length)
}

/** The command list ({name, summary}) — shared with `mojioko status`. */
export function commandSummaries(): { name: string; summary: string }[] {
  return COMMANDS.map((c) => ({ name: c.name, summary: c.summary }))
}

/** Print help. `command` targets per-command help; undefined = top-level. */
export function printHelp(ctx: CliContext, command?: string): number {
  const target = command ? COMMANDS.find((c) => c.name === command) : undefined

  if (ctx.json) {
    const errorCodes = Object.entries(ERROR_CODE_DESCRIPTIONS).map(([code, desc]) => ({
      code,
      exitCode: CODE_TO_EXIT[code] ?? 1,
      desc,
    }))
    const data = target
      ? { command: target }
      : {
          version: APP_VERSION,
          invocation: 'MOJIOKO.exe <command> [args]  (bundled shim: mojioko <command>)',
          commands: COMMANDS,
          commonFlags: COMMON_FLAGS.map(([flag, desc]) => ({ flag, desc })),
          exitCodes: EXIT_SUMMARY.map(([code, desc]) => ({ code, desc })),
          errorCodes,
          warningCodes: WARNING_CODES.map(([code, desc]) => ({ code, desc })),
          examples: CHAINED_EXAMPLE,
        }
    process.stdout.write(JSON.stringify({ ok: true, command: 'help', data, warnings: [] }) + '\n')
    return EXIT_OK
  }

  const out = process.stdout
  if (target) {
    out.write(`\nmojioko ${target.name} — ${target.summary}\n\n`)
    out.write(`USAGE\n  ${target.usage}\n`)
    if (target.positionals.length) {
      out.write(`\nARGUMENTS\n`)
      for (const p of target.positionals) out.write(`  ${pad(p.name, 14)}${p.required ? '(必須) ' : '(任意) '}${p.desc}\n`)
    }
    if (target.optionSpecs.length) {
      out.write(`\nOPTIONS\n`)
      for (const o of target.optionSpecs) {
        const meta = [o.type, o.required ? 'required' : '', o.default ? `default ${o.default}` : '', o.values ? `{${o.values.join('|')}}` : '']
          .filter(Boolean)
          .join(' ')
        out.write(`  ${pad(o.flag, 18)}${o.desc}  [${meta}]\n`)
      }
    }
    out.write(`\nEXAMPLES\n`)
    for (const e of target.examples) out.write(`  ${e}\n`)
    if (target.errorCodes.length) out.write(`\nERROR CODES\n  ${target.errorCodes.join(', ')}\n`)
    return EXIT_OK
  }

  out.write(`\nMOJIOKO CLI ${APP_VERSION} — ローカル動画字幕ツール（ヘッドレス実行）\n`)
  out.write(`  実体: MOJIOKO.exe <command>  （同梱シム: mojioko <command>）\n\n`)
  out.write(`COMMANDS\n`)
  for (const c of COMMANDS) out.write(`  ${pad(c.name, 12)}${c.summary}\n`)
  out.write(`\nEXAMPLE (status → transcribe → translate → burn)\n`)
  for (const e of CHAINED_EXAMPLE) out.write(`  ${e}\n`)
  out.write(`\nCOMMON FLAGS\n`)
  for (const [flag, desc] of COMMON_FLAGS) out.write(`  ${pad(flag, 22)}${desc}\n`)
  out.write(`\nEXIT CODES\n`)
  for (const [n, d] of EXIT_SUMMARY) out.write(`  ${pad(String(n), 5)}${d}\n`)
  out.write(`\nSEE ALSO\n`)
  out.write(`  詳細仕様: dev-docs/specs/mojioko-cli.md\n`)
  out.write(`  mojioko <command> -h  でコマンド別ヘルプ（--json で機械可読）\n`)
  out.write(`  mojioko status --json  で現在のセットアップ状況\n\n`)
  return EXIT_OK
}
