/**
 * REQ-0447 / spec §3.6 — `mojioko help` / `-h` / `--help`.
 *
 * Top-level help: overview, command list, chained example, common flags,
 * exit-code summary, references.  Per-command help: options + examples.
 * `--json` returns a machine-readable structure instead of formatted text.
 */
import { APP_VERSION } from '../../shared/app-info'
import { EXIT_OK, type CliContext } from './output'

interface CommandDoc {
  name: string
  summary: string
  usage: string
  options: string[]
  examples: string[]
  errorCodes: string[]
}

const COMMON_FLAGS: [string, string][] = [
  ['--json / --no-json', 'stdout に結果 JSON を出す（既定 on）'],
  ['--quiet', 'stderr の進捗・info を抑止'],
  ['--verbose', 'stderr に debug ログを追加'],
  ['--device cpu|gpu', '実行デバイス（既定: 設定の activeAccelerator）'],
  ['--strict', '--device gpu で CUDA 不可のとき fallback せず失敗'],
  ['-h, --help', 'ヘルプを表示'],
  ['--version', 'バージョンを表示'],
]

const EXIT_SUMMARY: [number, string][] = [
  [0, '成功'],
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

const COMMANDS: CommandDoc[] = [
  {
    name: 'tools',
    summary: 'ツール・モデル・GPU の状態照会とセットアップ（list / download / use）',
    usage: 'mojioko tools [list|download|use] ...',
    options: [
      'list                              状態を JSON で返す（既定・CC の前提検査用）',
      'download whisper --model <id>     Whisper モデルを DL',
      'download translation --model 3b|7b 翻訳モデル(MADLAD)を DL',
      'download gpu                      GPU ランタイム(CUDA)を DL',
      'use whisper|translation --model <id>  アクティブモデルを選択',
      'use device gpu|cpu                実行デバイスを選択',
    ],
    examples: ['mojioko tools', 'mojioko tools use device cpu'],
    errorCodes: ['USAGE', 'MODEL_NOT_FOUND', 'TOOL_NOT_DOWNLOADED'],
  },
  {
    name: 'transcribe',
    summary: '動画/音声 → 字幕（.mojioko / SRT）',
    usage: 'mojioko transcribe <input> -o <out>',
    options: [
      '--model large-v3|large-v3-turbo   既定: 設定のアクティブモデル',
      '--lang auto|ja|en|...             既定: auto',
      '--track <n>                       音声トラック(1-based)。既定: 1',
      '--vad on|off                      既定: on',
      '--device cpu|gpu, --strict',
      '--format mojioko|srt              既定: -o 拡張子から判定',
    ],
    examples: ['mojioko transcribe input.mp4 -o out.mojioko --lang ja'],
    errorCodes: ['INPUT_NOT_FOUND', 'UNSUPPORTED_FORMAT', 'MODEL_NOT_FOUND', 'TRANSCRIBE_FAILED'],
  },
  {
    name: 'translate',
    summary: '字幕 → 字幕（既定=現在テキスト / --from-original で原文から）',
    usage: 'mojioko translate <input> --to <lang> -o <out>',
    options: [
      '--to en|ja|es|fr|de|pt            翻訳先（必須）',
      '--model 3b|7b                     既定: 設定のアクティブ翻訳モデル',
      '--from-original                   文字起こし原文から訳す（.mojioko 必須）',
      '--device cpu|gpu, --strict',
    ],
    examples: ['mojioko translate out.mojioko --to en --from-original -o out.en.mojioko'],
    errorCodes: ['INPUT_NOT_FOUND', 'UNSUPPORTED_FORMAT', 'TOOL_NOT_DOWNLOADED', 'DEPS_MISSING', 'TRANSLATION_FAILED'],
  },
  {
    name: 'burn',
    summary: '字幕焼き込み（libass）。解像度/プリセット/オーバーフロー対応',
    usage: 'mojioko burn <video> <subtitle> -o <out.mp4>',
    options: [
      '--resolution WxH | --preset <name>  既定: ソース解像度維持',
      '--margin-x <px>, --margin-v <px>',
      '--overflow shrink|warn|error        既定: warn',
      '--encoder auto|h264_nvenc|...       既定: auto',
      '--audio preserve|simple|none        既定: simple',
      '--weight <Thin..Black>              フォントはアプリ既定スタイルを継承',
    ],
    examples: ['mojioko burn input.mp4 out.en.mojioko -o final.mp4 --preset shorts'],
    errorCodes: ['INPUT_NOT_FOUND', 'UNSUPPORTED_FORMAT', 'SUBTITLE_OVERFLOW', 'BURN_FAILED', 'OUTPUT_WRITE_FAILED'],
  },
  {
    name: 'run',
    summary: '統合ワンショット（transcribe → translate → burn を内部連結）',
    usage: 'mojioko run <video> [--translate <lang>] [--burn] -o <out>',
    options: ['--translate <lang>                翻訳を挟む', '--burn                            焼き込みまで実行'],
    examples: ['mojioko run input.mp4 --translate en --burn -o final.mp4'],
    errorCodes: ['(各段のエラーコードを継承)'],
  },
]

const CHAINED_EXAMPLE = [
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

/** Print help. `command` targets per-command help; undefined = top-level. */
export function printHelp(ctx: CliContext, command?: string): number {
  const target = command ? COMMANDS.find((c) => c.name === command) : undefined

  if (ctx.json) {
    const data = target
      ? { command: target }
      : {
          version: APP_VERSION,
          commands: COMMANDS.map((c) => ({ name: c.name, summary: c.summary })),
          commonFlags: COMMON_FLAGS.map(([flag, desc]) => ({ flag, desc })),
          exitCodes: Object.fromEntries(EXIT_SUMMARY.map(([n, d]) => [n, d])),
          examples: CHAINED_EXAMPLE,
        }
    process.stdout.write(JSON.stringify({ ok: true, command: 'help', data, warnings: [] }) + '\n')
    return EXIT_OK
  }

  const out = process.stdout
  if (target) {
    out.write(`\nmojioko ${target.name} — ${target.summary}\n\n`)
    out.write(`USAGE\n  ${target.usage}\n\nOPTIONS\n`)
    for (const o of target.options) out.write(`  ${o}\n`)
    out.write(`\nEXAMPLES\n`)
    for (const e of target.examples) out.write(`  ${e}\n`)
    out.write(`\nERROR CODES\n  ${target.errorCodes.join(', ')}\n`)
    return EXIT_OK
  }

  out.write(`\nMOJIOKO CLI ${APP_VERSION} — ローカル動画字幕ツール（ヘッドレス実行）\n`)
  out.write(`  実体: MOJIOKO.exe <command>  （同梱シム: mojioko <command>）\n\n`)
  out.write(`COMMANDS\n`)
  for (const c of COMMANDS) out.write(`  ${pad(c.name, 12)}${c.summary}\n`)
  out.write(`\nEXAMPLE (transcribe → translate → burn)\n`)
  for (const e of CHAINED_EXAMPLE) out.write(`  ${e}\n`)
  out.write(`\nCOMMON FLAGS\n`)
  for (const [flag, desc] of COMMON_FLAGS) out.write(`  ${pad(flag, 22)}${desc}\n`)
  out.write(`\nEXIT CODES\n`)
  for (const [n, d] of EXIT_SUMMARY) out.write(`  ${pad(String(n), 5)}${d}\n`)
  out.write(`\nSEE ALSO\n`)
  out.write(`  詳細仕様: dev-docs/specs/mojioko-cli.md\n`)
  out.write(`  設定 > CLI タブ（アプリ内）\n`)
  out.write(`  mojioko <command> -h  でコマンド別ヘルプ\n\n`)
  return EXIT_OK
}
