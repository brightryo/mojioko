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
import { CLI_WEIGHT_LABELS } from './style-overrides'

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
const WEIGHTS = [...CLI_WEIGHT_LABELS] // REQ-0461 — single source of truth (shared with burn's `--weight`).
const PRESETS = ['shorts', 'vertical', 'reels', 'tiktok', 'square', '1080p', '720p']

const OUT_REQ: OptionSpec = { flag: '-o, --out', type: 'path', required: true, desc: '出力ファイルパス' }
/**
 * REQ-0499 §2-7 — `transcribe` / `run` do NOT select the device with this flag:
 * the sidecar picks it from the app setting, and the flag only feeds the
 * `--strict` assertion.  The wording used to read as a selector, which is why
 * RES-0498 classified it a partial no-op.  `translate` DOES select (see
 * `DEVICE_SELECT`), so the two are deliberately worded differently.
 */
const DEVICE_ASSERT: OptionSpec = { flag: '--device', type: 'enum', values: ['cpu', 'gpu'], desc: '期待デバイスの表明（選択はしない。実デバイスは設定の activeAccelerator。--strict と併用）' }
const DEVICE_SELECT: OptionSpec = { flag: '--device', type: 'enum', values: ['cpu', 'gpu'], desc: '実行デバイスを選択（既定: CUDA があれば gpu）' }
/**
 * REQ-0501 §2-1 — `--overwrite` is enforced by `overwrite.ts:assertWritable` on
 * EIGHT commands but was advertised on only three, so five commands could fail
 * with OUTPUT_EXISTS and offer no documented way out (the error's `remedy`
 * named the flag, but help did not).  One shared spec so they cannot drift.
 */
const OVERWRITE: OptionSpec = { flag: '--overwrite', type: 'boolean', default: 'false', desc: '既存出力を上書き（既定は拒否＝OUTPUT_EXISTS）' }
const STRICT: OptionSpec = { flag: '--strict', type: 'boolean', default: 'false', desc: '--device gpu で CUDA 不可なら fallback せず失敗' }

/**
 * REQ-0504 — the per-cue style flags, defined ONCE.
 *
 * `burn` / `export_frame` / `run` / `preset save` all feed the same
 * `parseStyleOverrides`, so four hand-maintained copies of this list was three
 * chances for them to drift — the exact shape of the REQ-0468 `margin_x`
 * incident. The CLI↔MCP parity gate is what surfaced the fourth copy.
 */
const STYLE_FLAG_SPECS: OptionSpec[] = [
  // REQ-0500 §2 — karaoke was previously inescapable from a headless run: cues
  // inherit `karaokeEnabled` from the app settings and no flag could turn it
  // off. `--karaoke-style` had no headless route at all.
  { flag: '--karaoke', type: 'enum', values: ['on', 'off'], desc: 'カラオケ表示の ON/OFF（既定=アプリ設定）' },
  { flag: '--karaoke-color', type: 'string', desc: '発話済み色 #RRGGBB' },
  { flag: '--karaoke-style', type: 'enum', values: ['sweep', 'switch'], desc: 'カラオケ表示方式（既定 sweep）' },
  // REQ-0501 §1 — the remaining GUI-settable style axes. Ranges mirror the GUI
  // controls exactly. `shadowColor` / `shadowAlpha` are intentionally absent:
  // no GUI surface can set them.
  { flag: '--emphasis', type: 'enum', values: ['on', 'off'], desc: 'キーワード強調の ON/OFF（強調語の指定は非対応）' },
  { flag: '--emphasis-color', type: 'string', desc: '強調色 #RRGGBB' },
  { flag: '--emphasis-scale', type: 'int', default: '130', desc: '強調の拡大率(%) 50..200' },
  { flag: '--shadow', type: 'int', desc: '影の大きさ(px) 0..50（0=影なし）' },
  { flag: '--rotation', type: 'int', desc: '回転(度) 0..359' },
  { flag: '--uppercase', type: 'enum', values: ['on', 'off'], desc: '大文字化（表示のみ・SRT 出力は原文）' },
  { flag: '--line-spacing', type: 'int', desc: '行間(%) -50..100（フォントサイズ比）' },
  { flag: '--text-alpha', type: 'int', desc: '文字の不透明度(%) 0..100' },
  { flag: '--outline-alpha', type: 'int', desc: '縁の不透明度(%) 0..100' },
  { flag: '--background', type: 'enum', values: ['on', 'off'], desc: '背景ボックスの ON/OFF' },
  { flag: '--background-color', type: 'enum', values: ['black', 'white'], desc: '背景ボックスの色' },
  { flag: '--background-opacity', type: 'int', desc: '背景ボックスの不透明度(%) 0..100' },
]

/** REQ-0504 — the base typography overrides, shared by the same four commands. */
const BASE_STYLE_SPECS: OptionSpec[] = [
  { flag: '--weight', type: 'enum', values: WEIGHTS, desc: 'フォントウェイト（既定=アプリ設定）' },
  { flag: '--font-size', type: 'int', desc: 'フォントサイズ上書き(px)' },
  { flag: '--text-color', type: 'string', desc: '文字色 #RRGGBB' },
  { flag: '--outline-color', type: 'string', desc: '縁色 #RRGGBB' },
  { flag: '--outline', type: 'int', desc: '縁の太さ(px)' },
  { flag: '--margin-v', type: 'int', desc: '字幕を画面の下端(または上端)からどれだけ離すか。入力動画の px で指定し、--preset/--resolution では一緒に縮小される' },
]

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
      // REQ-0501 §2-1 — implemented since REQ-0456 but never advertised.
      { flag: '--auto-break', type: 'enum', values: ['on', 'off'], default: 'on', desc: '自動折り返し（ASS の \\N 挿入）。off で無効' },
      OVERWRITE,
      DEVICE_ASSERT,
      STRICT,
    ],
    examples: ['mojioko transcribe input.mp4 -o out.mojioko --lang ja'],
    // REQ-0517 §1-3 — `--track N` for a track the file does not have is a
    // USAGE refusal, not a silent substitution.
    errorCodes: ['USAGE', 'INPUT_NOT_FOUND', 'UNSUPPORTED_FORMAT', 'MODEL_NOT_FOUND', 'TRANSCRIBE_FAILED', 'OUTPUT_WRITE_FAILED', 'GPU_INIT_FAILED'],
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
      OVERWRITE,
      DEVICE_SELECT,
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
      { flag: '--margin-v', type: 'int', desc: '字幕を画面の下端(または上端)からどれだけ離すか。入力動画の px で指定し、--preset/--resolution では一緒に縮小される' },
      { flag: '--margin-x', type: 'int', default: '10', desc: '左右の余白(px)。字幕はここに収まるよう自動折り返しされる（位置そのものは動かさない）。出力解像度の px' },
      { flag: '--margin-y', type: 'int', default: '10', desc: '「縦にはみ出した」と判定する上下の余白(px)。判定と --overflow shrink の縮小にのみ影響し、字幕は動かない。出力解像度の px（未指定なら --margin-v を出力解像度へ換算した値）' },
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
      ...STYLE_FLAG_SPECS,
      { flag: '--position', type: 'enum', values: ['top', 'center', 'bottom'], desc: '縦位置' },
      { flag: '--style', type: 'string', desc: 'GUI 保存のスタイルプリセット名を全 cue に適用（status で一覧）' },
      OVERWRITE,
      { flag: '--dry-run', type: 'boolean', default: 'false', desc: '焼かずに overflow(shrink/warn/error)判定のみ返す' },
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
      // REQ-0501 §2-4 — these already worked (run spreads its opts into the
      // burn stage) and the MCP schema already declared them; only help was
      // silent, so the parity gate flagged the reverse asymmetry.
      { flag: '--crf', type: 'int', desc: '画質(定質) 0..51（--burn 時）' },
      { flag: '--bitrate', type: 'string', desc: 'VBR目標ビットレート 例 16M（--burn 時）' },
      { flag: '--quality', type: 'int', desc: '画質 1..100（--burn 時）' },
      ...STYLE_FLAG_SPECS,
      OVERWRITE,
      DEVICE_ASSERT,
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
      // REQ-0502 §1 — the same flag now takes a list, so `--time 1.5` is
      // unchanged and there is no second spelling to choose between.
      { flag: '--time', type: 'string', required: true, desc: '抽出する時刻（秒）。カンマ区切りで複数可（最大20・例 1.0,3.5,7.2）' },
      { flag: '--format', type: 'enum', values: ['mojioko', 'srt'], desc: '字幕フォーマット（既定: 拡張子）' },
      // REQ-0461 — same per-cue style overrides as `burn`, so a preview frame is
      // a faithful still of the burn (change a flag → verify in real pixels).
      { flag: '--weight', type: 'enum', values: WEIGHTS, desc: 'フォントウェイト（既定=アプリ設定）' },
      { flag: '--font-size', type: 'int', desc: 'フォントサイズ上書き(px)' },
      { flag: '--text-color', type: 'string', desc: '文字色 #RRGGBB' },
      { flag: '--outline-color', type: 'string', desc: '縁色 #RRGGBB' },
      { flag: '--outline', type: 'int', desc: '縁の太さ(px)' },
      { flag: '--margin-v', type: 'int', desc: '字幕を画面の下端(または上端)からどれだけ離すか。入力動画の px で指定し、--preset/--resolution では一緒に縮小される' },
      // REQ-0468 — same placement/layout args as `burn`, resolved by the shared
      // pipeline, so a still previews the burn (position/margins/overflow/解像度).
      ...STYLE_FLAG_SPECS,
      { flag: '--position', type: 'enum', values: ['top', 'center', 'bottom'], desc: '縦位置（burn と同一）' },
      { flag: '--margin-x', type: 'int', default: '10', desc: '左右の余白(px)。字幕はここに収まるよう自動折り返しされる（位置そのものは動かさない）。出力解像度の px' },
      { flag: '--margin-y', type: 'int', desc: '「縦にはみ出した」と判定する上下の余白(px)。判定にのみ影響し、字幕は動かない。出力解像度の px（未指定なら --margin-v を換算）' },
      { flag: '--overflow', type: 'enum', values: ['shrink', 'warn', 'error'], default: 'warn', desc: '縦はみ出し（warn=計上 / shrink=自動縮小 / error=失敗）' },
      { flag: '--preset', type: 'enum', values: PRESETS, desc: '出力プリセット（縦ショート等）。burn と同一' },
      { flag: '--resolution', type: 'string', desc: 'WxH（例 1080x1920）。--preset と排他' },
      { flag: '--style', type: 'string', desc: 'GUI 保存のスタイルプリセット名を全 cue に適用（status で一覧）' },
      OVERWRITE,
    ],
    examples: ['mojioko export_frame input.mp4 out.mojioko -o frame.png --time 1.5 --position bottom --margin-v 200 --preset shorts'],
    errorCodes: ['INPUT_NOT_FOUND', 'UNSUPPORTED_FORMAT', 'USAGE', 'SUBTITLE_OVERFLOW', 'BURN_FAILED'],
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
    summary: '字幕の cue 一覧（index/開始/終了/テキスト・--with-style でスタイルも）を返す',
    usage: 'mojioko read_subtitle <subtitle> [--with-style]',
    positionals: [{ name: 'subtitle', required: true, desc: '.mojioko または .srt' }],
    optionSpecs: [
      { flag: '--format', type: 'enum', values: ['mojioko', 'srt'], desc: '既定: 拡張子' },
      // REQ-0500 §1 — off by default: the 4-field shape is the existing contract.
      { flag: '--with-style', type: 'boolean', default: 'false', desc: 'cue ごとの解決済みスタイルと id/cueNumber も返す（.mojioko のみ）' },
    ],
    examples: ['mojioko read_subtitle out.mojioko', 'mojioko read_subtitle out.mojioko --with-style'],
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
      OVERWRITE,
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
      OVERWRITE,
    ],
    examples: ['mojioko convert out.mojioko -o out.srt'],
    errorCodes: ['INPUT_NOT_FOUND', 'UNSUPPORTED_FORMAT', 'USAGE', 'OUTPUT_WRITE_FAILED'],
  },
  {
    name: 'preset',
    summary: 'スタイルプリセットの一覧・確認・保存・削除（GUI と同じ保存先）',
    usage: 'mojioko preset [list | show <name> | save <name> --from <sub.mojioko> | delete <name>]',
    positionals: [
      { name: 'subcommand', required: false, desc: 'list（既定）| show | save | delete' },
      { name: 'name', required: false, desc: 'show / save / delete の対象名' },
    ],
    optionSpecs: [
      { flag: '--from', type: 'path', desc: 'save: 元にする .mojioko（cue のスタイルを取り込む）' },
      { flag: '--index', type: 'int', default: '0', desc: 'save: 元にする cue 番号（0始まり）' },
      // save: the captured cue can be tweaked on the way in, using the same
      // flags a burn would take.
      ...BASE_STYLE_SPECS,
      ...STYLE_FLAG_SPECS,
      OVERWRITE,
    ],
    examples: [
      'mojioko preset list',
      'mojioko preset show "My Bold"',
      'mojioko preset save "My Bold" --from out.mojioko --index 3',
      'mojioko preset delete "My Bold"',
    ],
    errorCodes: ['USAGE', 'INPUT_NOT_FOUND', 'UNSUPPORTED_FORMAT', 'OUTPUT_EXISTS'],
  },
  {
    name: 'export-mcpb',
    summary: 'Claude Desktop 用 .mcpb を書き出す（GUI「MCP 拡張を書き出す」と同一・自動化用。REQ-0467）',
    usage: 'mojioko export-mcpb -o <path.mcpb>',
    positionals: [],
    optionSpecs: [
      OUT_REQ,
      OVERWRITE,
    ],
    examples: ['mojioko export-mcpb -o mojioko.mcpb'],
    errorCodes: ['USAGE', 'OUTPUT_EXISTS', 'OUTPUT_WRITE_FAILED'],
  },
]

const COMMON_FLAGS: [string, string][] = [
  ['--json / --no-json', 'stdout に結果 JSON を出す（既定 on。help は既定テキスト）'],
  ['--quiet', 'stderr の進捗・info を抑止'],
  ['--verbose', 'stderr に debug ログを追加'],
  // REQ-0499 §1 — unknown options warn by default; this makes them fatal.
  ['--strict-args', '未知のオプションを警告ではなく USAGE エラー(exit 2)にする'],
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
  /**
   * REQ-0508 §1-4 — this line replaces `FONT_UNAVAILABLE` / `FONT_RESTRICTED`,
   * BOTH of which were advertised here with no emitter anywhere in `src`
   * (REQ-0507 §1 found the second; grepping for the first while fixing it found
   * the same hole).
   *
   *   - `FONT_RESTRICTED` described a tier refusal. The chosen behaviour is
   *     substitute-and-warn, not refusal, so the warning it described cannot
   *     occur; `FONT_TIER_SUBSTITUTED` is what actually happens and is emitted
   *     by `detectFontTierSubstitution`.
   *   - `FONT_UNAVAILABLE` described "font file missing → substitute + warn".
   *     The code did not do that: `stageFontsDir` THREW and the caller turned it
   *     into `BURN_FAILED`. Advertising a warning for what is really a hard
   *     error is worse than saying nothing, so the advert went — and RES-0508
   *     recorded the gap. **REQ-0509 made the documented behaviour true** and
   *     brought the code back, this time with an emitter
   *     (`detectFontSubstitutions`) landing in the same commit.
   *
   * `tests/unit/font-tier-req-0508.test.ts` scans this table and fails on any
   * code with no emitter in `src/`, so the next hollow entry cannot land — and
   * it is why the line below could only be restored together with its sender.
   */
  ['FONT_TIER_SUBSTITUTED', '無料版で有料フォントを Noto へ置換（成功レスポンス内・REQ-0508）'],
  ['FONT_UNAVAILABLE', 'フォントファイルが無く Noto へ置換して続行（成功レスポンス内・REQ-0509）'],
  // REQ-0517 §1-4 — the settings default did not exist in the input file, so
  // the shared ladder fell back to Track 1.  Advertised together with its
  // emitter (`commands/transcribe.ts`), per the scan test's rule above.
  ['AUDIO_TRACK_FALLBACK', '既定の音声トラックが入力に無く、トラック 1 で続行（成功レスポンス内・REQ-0517）'],
  // REQ-0516 §3 — scale/pop animation on a multi-line cue: the burn's line
  // pitch does not scale, so the preview and the output differ.
  ['SCALE_ANIM_LINE_PITCH_FIXED', '複数行 cue の scale/pop で行間が拡大縮小しない（成功レスポンス内・REQ-0516）'],
  // REQ-0529 §1 — cue times are never validated against the video's length on
  // this path, so part of a subtitle track can fall off the end unreported.
  // The GUI has shown this as the 時間超過 badge since v1.0; headless had
  // nothing.  Emitter: `no-op-warnings.ts` `detectCuesBeyondVideoEnd`.
  ['CUE_BEYOND_VIDEO_END', '動画の尺を超える cue がある（成功レスポンス内・REQ-0529）'],
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

/**
 * The long-option keys in an `OptionSpec.flag` string.
 *
 * `flag` is display text (`'-o, --out'`, `'--margin-v'`), so the machine-usable
 * key set has to be parsed back out of it.  Short aliases (`-o`) are dropped:
 * the parser rewrites `-o` to `out` before anything sees it (`args.ts`).
 */
function optionKeysOf(flag: string): string[] {
  return flag
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.startsWith('--'))
    .map((token) => token.slice(2))
}

/**
 * Every long-option key `command` advertises in help.
 *
 * REQ-0499 §1 — the unknown-option detector (`known-opts.ts`) and the
 * option-wiring gate both read the flag list from here, so help stays the
 * single declaration of what a command accepts.  Unknown command ⇒ `[]`.
 */
export function advertisedOptionKeys(command: string): string[] {
  const doc = COMMANDS.find((c) => c.name === command)
  if (!doc) return []
  return doc.optionSpecs.flatMap((o) => optionKeysOf(o.flag))
}

/** Every command name in help (canonical spellings). */
export function helpCommandNames(): string[] {
  return COMMANDS.map((c) => c.name)
}

/** REQ-0499 §3 — the full advertised option set, for the wiring gate. */
export function allAdvertisedOptions(): { command: string; key: string }[] {
  return COMMANDS.flatMap((c) =>
    c.optionSpecs.flatMap((o) => optionKeysOf(o.flag).map((key) => ({ command: c.name, key }))),
  )
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
