/**
 * REQ-0447 / spec §3.3 — `mojioko translate <input> --to <lang> -o <out>`.
 *
 * Reuses the MADLAD sidecar (`translateBatch`). Default source = the cue's
 * CURRENT text; `--from-original` translates the transcription snapshot
 * (`original.text`, `.mojioko` only). `.mojioko` in preserves per-cue style
 * (only `text` changes); SRT in → SRT out.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { translateBatch } from '../../services/translation-sidecar'
import { isToolInstalled } from '../../services/translation-tool-store'
import { getEffectiveGpuToolDir } from '../../services/gpu-tool'
import { loadSettings } from '../../services/settings-store'
import { getTranslationToolsDir } from '../../lib/paths'
import { parseProjectFile, serializeProjectFile, type ProjectFile } from '../../../shared/project-file'
import { isTranslationTarget } from '../../../shared/translation'
import { formatSrtTime } from '../../../shared/srt-time'
import { parseSrt } from '../../../renderer/lib/srt-parse'
import type { TranslationToolId } from '../../../shared/translation-tools'
import type { TranslationTarget } from '../../../shared/translation'
import { optString, type ParsedArgs } from '../args'
import { CliError, emitSuccess, type CliContext, type CliWarning } from '../output'
import { assertWritable } from '../overwrite'
import { detectFormat, entriesToSrt } from '../subtitle-io'

function cuesToSrt(cues: { startSec: number; endSec: number; text: string }[]): string {
  const blocks = cues
    .filter((c) => c.text.trim() !== '')
    .map((c, i) => `${i + 1}\n${formatSrtTime(c.startSec)} --> ${formatSrtTime(c.endSec)}\n${c.text.replace(/\\N/g, '\n')}`)
  return '﻿' + blocks.join('\n\n') + '\n'
}

export async function runTranslateCommand(ctx: CliContext, args: ParsedArgs): Promise<number> {
  const input = args.positionals[0]
  if (!input) throw new CliError('USAGE', 'input file が必要です。', 'mojioko translate <input> --to <lang> -o <out>')
  if (!existsSync(input)) throw new CliError('INPUT_NOT_FOUND', `入力が見つかりません: ${input}`, '入力パスを確認してください。')

  const out = optString(args.opts, 'out')
  if (!out) throw new CliError('USAGE', '出力パス（-o <out>）が必要です。')
  assertWritable(out, args.opts) // REQ-0457 D13

  const to = optString(args.opts, 'to')
  if (!to || !isTranslationTarget(to)) {
    throw new CliError('USAGE', `--to <lang> が必要です（en|ja|es|fr|de|pt）。`, 'mojioko translate <in> --to en -o <out>')
  }
  const target = to as TranslationTarget

  const inFmt = detectFormat(input)
  const outFmt = detectFormat(out, optString(args.opts, 'format'))
  if (!inFmt) throw new CliError('UNSUPPORTED_FORMAT', `入力フォーマット不明: ${input}`, '.mojioko / .srt を指定してください。')
  if (!outFmt) throw new CliError('UNSUPPORTED_FORMAT', `出力フォーマット不明: ${out}`, '.mojioko / .srt または --format を指定してください。')

  const fromOriginal = args.opts['from-original'] === true
  if (fromOriginal && inFmt !== 'mojioko') {
    throw new CliError('UNSUPPORTED_FORMAT', '--from-original は .mojioko 入力が必要です（SRT に原文はありません）。', '.mojioko を入力にするか --from-original を外してください。')
  }
  if (inFmt === 'srt' && outFmt === 'mojioko') {
    throw new CliError('UNSUPPORTED_FORMAT', 'SRT → .mojioko は非対応（動画/プロジェクト情報が必要）。', 'SRT 入力は SRT 出力にしてください。')
  }

  // Resolve translation model + device (same gate the GUI/IPC uses).
  const settings = await loadSettings()
  const modelFlag = optString(args.opts, 'model')
  const toolId: TranslationToolId | null = modelFlag
    ? modelFlag === '7b' || modelFlag === 'madlad400-7b'
      ? 'madlad400-7b'
      : 'madlad400-3b'
    : (settings.translationToolActiveId ?? null)
  if (!toolId) {
    throw new CliError('TOOL_NOT_DOWNLOADED', '翻訳モデルが選択されていません。', 'mojioko tools download translation --model 3b（またはアプリで DL/選択）。')
  }
  const toolsDir = getTranslationToolsDir()
  if (!isToolInstalled(toolId, toolsDir)) {
    throw new CliError('TOOL_NOT_DOWNLOADED', `翻訳モデル "${toolId}" が導入されていません。`, `mojioko tools download translation --model ${toolId === 'madlad400-7b' ? '7b' : '3b'}`, { toolId })
  }
  // REQ-0499 §2-2 — `--device` / `--strict` used to be pure no-ops here: the
  // device was unconditionally `gpuDir ? 'cuda' : 'cpu'`, and the result then
  // ECHOED that, so `--device cpu` returned `device: "gpu"`.  The sidecar takes
  // the device from `config.device` (→ `MOJIOKO_TRANSLATION_DEVICE`), so honouring
  // the flag is a real selection, not just an honest report.
  const requestedDevice = optString(args.opts, 'device')
  if (requestedDevice && requestedDevice !== 'cpu' && requestedDevice !== 'gpu') {
    throw new CliError('USAGE', `unknown --device: ${requestedDevice}`, 'cpu|gpu')
  }
  const strict = args.opts.strict === true
  const gpuDir = await getEffectiveGpuToolDir()
  const warnings: CliWarning[] = []

  let useGpu = Boolean(gpuDir)
  if (requestedDevice === 'cpu') {
    useGpu = false
  } else if (requestedDevice === 'gpu' && !gpuDir) {
    // Mirrors `transcribe`: a missing CUDA runtime is a warning by default and
    // fatal under `--strict` (which previously could never fire here at all).
    if (strict) {
      throw new CliError(
        'GPU_INIT_FAILED',
        'GPU が要求されましたが CUDA ツールが導入されていません（--strict）。',
        'mojioko tools download gpu を実行するか、--device cpu で実行してください。',
      )
    }
    warnings.push({
      code: 'GPU_INIT_FAILED',
      message: 'GPU が要求されましたが CUDA ツールが無いため CPU で実行しました。',
      detail: { requestedDevice: 'gpu', usedDevice: 'cpu' },
    })
    useGpu = false
  }

  const config = {
    modelDir: join(toolsDir, toolId),
    device: (useGpu ? 'cuda' : 'cpu') as 'cpu' | 'cuda',
    gpuDir: useGpu ? gpuDir : null,
  }

  // Read input → source texts (+ keep the structure for output).
  const raw = readFileSync(input, 'utf-8')
  let sources: string[]
  let project: ProjectFile | null = null
  let srtCues: { startSec: number; endSec: number; text: string }[] = []

  if (inFmt === 'mojioko') {
    const parsed = parseProjectFile(raw)
    if (!parsed.ok) throw new CliError('UNSUPPORTED_FORMAT', `.mojioko を読み取れません（${parsed.reason}）。`, '対応バージョンの .mojioko ですか？')
    project = parsed.project
    sources = project.editing.subtitles.map((e) => (fromOriginal ? e.original.text : e.text).replace(/\\N/g, ' '))
  } else {
    const { cues, errors } = parseSrt(raw)
    if (errors.length > 0) throw new CliError('UNSUPPORTED_FORMAT', `SRT の解析に失敗: ${errors[0]}`, 'SRT の書式を確認してください。')
    srtCues = cues.map((c) => ({ startSec: c.startSec, endSec: c.endSec, text: c.text }))
    sources = srtCues.map((c) => c.text.replace(/\\N/g, ' '))
  }

  let translated: string[]
  try {
    const res = await translateBatch(sources, target, config)
    translated = res.texts
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('PYTHON_MISSING') || msg.toLowerCase().includes('no module named')) {
      throw new CliError('DEPS_MISSING', `翻訳の実行環境が不足しています: ${msg}`, '翻訳は現状 Python 環境（.venv + 依存）が必要です（spec §8.3 / 既知の制限）。', { error: msg })
    }
    throw new CliError('TRANSLATION_FAILED', msg, '入力・モデル・実行環境を確認してください。', { error: msg })
  }

  // Write output.
  try {
    if (outFmt === 'mojioko' && project) {
      project.editing.subtitles = project.editing.subtitles.map((e, i) => {
        const text = translated[i] ?? e.text
        return { ...e, text, isEdited: text !== e.original.text }
      })
      writeFileSync(out, serializeProjectFile(project), 'utf-8')
    } else if (outFmt === 'srt' && project) {
      const entries = project.editing.subtitles.map((e, i) => ({ ...e, text: translated[i] ?? e.text }))
      writeFileSync(out, entriesToSrt(entries), 'utf-8')
    } else {
      const outCues = srtCues.map((c, i) => ({ ...c, text: translated[i] ?? c.text }))
      writeFileSync(out, cuesToSrt(outCues), 'utf-8')
    }
  } catch (e) {
    throw new CliError('OUTPUT_WRITE_FAILED', `出力を書き込めません: ${out}`, '出力先の権限・空き容量・パスを確認してください。', { error: e instanceof Error ? e.message : String(e) })
  }

  return emitSuccess(
    ctx,
    'translate',
    {
      outputPath: out,
      format: outFmt,
      count: sources.length,
      to: target,
      source: fromOriginal ? 'original' : 'current-text',
      model: toolId,
      // The device ACTUALLY used (REQ-0499 §2-2), plus what was asked for, so a
      // caller can tell a satisfied request from a silent fallback.
      device: useGpu ? 'gpu' : 'cpu',
      requestedDevice: requestedDevice || null,
    },
    warnings,
  )
}
