/**
 * REQ-0450 §1 — MCP tool registry.
 *
 * Each tool is a THIN wrapper over a CLI command (`runStatusCommand`,
 * `runTranscribeCommand`, …): the MCP argument object is mapped to the CLI's
 * `ParsedArgs`, the command runs with a capturing `sink` context, and its
 * structured `CliResult` (incl. the stable error `code` + `remedy`) is returned.
 * CLI and MCP therefore cannot drift — the command layer is the single source.
 *
 * Long-running tools (transcribe/translate/burn/run/tools_download) return a
 * `job_id` immediately (async, §2); the client polls `get_job_status`.
 */
import type { CliContext, CliResult } from '../cli/output'
import { CliError } from '../cli/output'
import type { ParsedArgs } from '../cli/args'
import { runStatusCommand } from '../cli/commands/status'
import { runTranscribeCommand } from '../cli/commands/transcribe'
import { runTranslateCommand } from '../cli/commands/translate'
import { runBurnCommand } from '../cli/commands/burn'
import { runRunCommand } from '../cli/commands/run'
import { runExportFrameCommand } from '../cli/commands/export-frame'
import { runToolsCommand } from '../cli/commands/tools'
import { createJob, finishJob, getJob, jobSnapshot, updateJobStage, setJobCancel, listJobs, cancelJob } from './jobs'

type CommandFn = (ctx: CliContext, args: ParsedArgs) => Promise<number>

const LANGS = ['auto', 'ja', 'en', 'zh', 'ko', 'es', 'fr', 'de', 'pt', 'ru', 'ar']
const TARGETS = ['en', 'ja', 'es', 'fr', 'de', 'pt']
const PRESETS = ['shorts', 'vertical', 'reels', 'tiktok', 'square', '1080p', '720p']

/** Build ParsedArgs, dropping undefined/empty option values. */
function toArgs(positionals: (string | undefined)[], opts: Record<string, string | boolean | undefined>): ParsedArgs {
  const cleaned: Record<string, string | boolean> = {}
  for (const [k, v] of Object.entries(opts)) {
    if (v !== undefined && v !== '') cleaned[k] = v
  }
  return { positionals: positionals.filter((p): p is string => typeof p === 'string' && p.length > 0), opts: cleaned }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
const numStr = (v: unknown): string | undefined => (typeof v === 'number' ? String(v) : str(v))
const boolTrue = (v: unknown): true | undefined => (v === true ? true : undefined)

interface ToolSpec {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  async: boolean
  build: (input: Record<string, unknown>) => { fn: CommandFn; args: ParsedArgs }
}

const DEVICE_PROP = { type: 'string', enum: ['cpu', 'gpu'], description: '実行デバイス（既定: 設定）' }
const FORMAT_PROP = { type: 'string', enum: ['mojioko', 'srt'], description: '出力フォーマット（既定: 拡張子）' }

export const TOOLS: ToolSpec[] = [
  {
    name: 'status',
    description: 'セットアップ状況を返す（ready / blockers[]・各blockerに修正コマンド）。まず最初に呼ぶ。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async: false,
    build: () => ({ fn: (ctx) => runStatusCommand(ctx), args: toArgs([], {}) }),
  },
  {
    name: 'transcribe',
    description: '動画/音声ファイルを文字起こしして字幕(.mojioko/SRT)を書き出す。job_id を返す（get_job_status で完了確認）。',
    inputSchema: {
      type: 'object',
      required: ['input', 'out'],
      properties: {
        input: { type: 'string', description: '入力の動画/音声ファイルの絶対パス' },
        out: { type: 'string', description: '出力パス（.mojioko または .srt）' },
        model: { type: 'string', enum: ['large-v3', 'large-v3-turbo'], description: '既定: 設定のアクティブモデル' },
        lang: { type: 'string', enum: LANGS, description: '言語（既定 auto）' },
        track: { type: 'integer', description: '音声トラック(1-based, 既定1)' },
        vad: { type: 'string', enum: ['on', 'off'], description: 'VAD（既定 on）' },
        device: DEVICE_PROP,
        format: FORMAT_PROP,
      },
      additionalProperties: false,
    },
    async: true,
    build: (i) => ({
      fn: runTranscribeCommand,
      args: toArgs([str(i.input)], { out: str(i.out), model: str(i.model), lang: str(i.lang), track: numStr(i.track), vad: str(i.vad), device: str(i.device), format: str(i.format) }),
    }),
  },
  {
    name: 'translate',
    description: '字幕(.mojioko/SRT)を別言語へ翻訳する。job_id を返す。',
    inputSchema: {
      type: 'object',
      required: ['input', 'out', 'to'],
      properties: {
        input: { type: 'string', description: '.mojioko または .srt の絶対パス' },
        out: { type: 'string', description: '出力パス' },
        to: { type: 'string', enum: TARGETS, description: '翻訳先言語' },
        model: { type: 'string', enum: ['3b', '7b'], description: '既定: 設定のアクティブ翻訳モデル' },
        from_original: { type: 'boolean', description: '文字起こし原文から訳す（.mojioko 必須）' },
        device: DEVICE_PROP,
        format: FORMAT_PROP,
      },
      additionalProperties: false,
    },
    async: true,
    build: (i) => ({
      fn: runTranslateCommand,
      args: toArgs([str(i.input)], { out: str(i.out), to: str(i.to), model: str(i.model), 'from-original': boolTrue(i.from_original), device: str(i.device), format: str(i.format) }),
    }),
  },
  {
    name: 'burn',
    description: '字幕を動画へ焼き込む（解像度/プリセット対応）。job_id を返す。',
    inputSchema: {
      type: 'object',
      required: ['video', 'subtitle', 'out'],
      properties: {
        video: { type: 'string', description: '入力動画の絶対パス' },
        subtitle: { type: 'string', description: '.mojioko または .srt の絶対パス' },
        out: { type: 'string', description: '出力 .mp4 パス' },
        preset: { type: 'string', enum: PRESETS, description: '出力プリセット（縦ショート等）' },
        resolution: { type: 'string', description: 'WxH（例 1080x1920）。preset と排他' },
        overflow: { type: 'string', enum: ['shrink', 'warn', 'error'], description: '縦はみ出し（既定 warn）' },
        encoder: { type: 'string', enum: ['auto', 'h264_nvenc', 'h264_amf', 'h264_qsv', 'h264_mf'], description: '既定 auto' },
        audio: { type: 'string', enum: ['preserve', 'simple', 'none'], description: '既定 simple' },
        weight: { type: 'string', description: 'フォントウェイト（既定: 設定）' },
        margin_v: { type: 'integer', description: '縦マージン(px)' },
        position: { type: 'string', enum: ['top', 'center', 'bottom'], description: '縦位置' },
        device: DEVICE_PROP,
      },
      additionalProperties: false,
    },
    async: true,
    build: (i) => ({
      fn: runBurnCommand,
      args: toArgs([str(i.video), str(i.subtitle)], { out: str(i.out), preset: str(i.preset), resolution: str(i.resolution), overflow: str(i.overflow), encoder: str(i.encoder), audio: str(i.audio), weight: str(i.weight), 'margin-v': numStr(i.margin_v), position: str(i.position), device: str(i.device) }),
    }),
  },
  {
    name: 'run',
    description: 'ワンショット: 文字起こし→(翻訳)→(焼き込み)。job_id を返す。',
    inputSchema: {
      type: 'object',
      required: ['video', 'out'],
      properties: {
        video: { type: 'string', description: '入力動画の絶対パス' },
        out: { type: 'string', description: '出力パス（--burn 時は .mp4）' },
        translate: { type: 'string', enum: TARGETS, description: '指定時に翻訳を挟む' },
        burn: { type: 'boolean', description: '焼き込みまで実行' },
        preset: { type: 'string', enum: PRESETS, description: 'burn 用プリセット' },
        device: DEVICE_PROP,
      },
      additionalProperties: false,
    },
    async: true,
    build: (i) => ({
      fn: runRunCommand,
      args: toArgs([str(i.video)], { out: str(i.out), translate: str(i.translate), burn: boolTrue(i.burn), preset: str(i.preset), device: str(i.device) }),
    }),
  },
  {
    name: 'export_frame',
    description: '動画＋字幕の1フレームを指定時刻で PNG/JPG 出力（焼き上がりを画像で検証）。job_id を返す（get_job_status で outputPath 確認）。',
    inputSchema: {
      type: 'object',
      required: ['video', 'subtitle', 'out', 'time'],
      properties: {
        video: { type: 'string', description: '入力動画の絶対パス' },
        subtitle: { type: 'string', description: '.mojioko または .srt の絶対パス' },
        out: { type: 'string', description: '出力画像パス（.png または .jpg）' },
        time: { type: 'number', description: '抽出する時刻（秒）' },
      },
      additionalProperties: false,
    },
    async: true,
    build: (i) => ({
      fn: runExportFrameCommand,
      args: toArgs([str(i.video), str(i.subtitle)], { out: str(i.out), time: numStr(i.time) }),
    }),
  },
  {
    name: 'tools_download',
    description: 'モデル/ランタイムを DL（%APPDATA% にアプリと共用）。job_id を返す。',
    inputSchema: {
      type: 'object',
      required: ['target'],
      properties: {
        target: { type: 'string', enum: ['whisper', 'translation', 'gpu'], description: 'DL 対象' },
        model: { type: 'string', description: 'whisper: large-v3|large-v3-turbo / translation: 3b|7b' },
      },
      additionalProperties: false,
    },
    async: true,
    build: (i) => ({ fn: runToolsCommand, args: toArgs(['download', str(i.target)], { model: str(i.model) }) }),
  },
  {
    name: 'tools_use',
    description: 'アクティブなモデル/デバイスを選択（AppSettings に書込・GUI と同一）。',
    inputSchema: {
      type: 'object',
      required: ['target', 'value'],
      properties: {
        target: { type: 'string', enum: ['whisper', 'translation', 'device'], description: '対象' },
        value: { type: 'string', description: 'モデル id もしくは cpu|gpu' },
        force: { type: 'boolean', description: 'アプリ起動中でも上書き' },
      },
      additionalProperties: false,
    },
    async: false,
    build: (i) => ({ fn: runToolsCommand, args: toArgs(['use', str(i.target), str(i.value)], { force: boolTrue(i.force) }) }),
  },
]

/** Run a CLI command with a capturing sink; returns its structured result. */
async function runCaptured(
  fn: CommandFn,
  args: ParsedArgs,
  opts: {
    defaultStage: string
    onStage?: (stage: string, stageProgress: number, overallProgress: number) => void
    signal?: AbortSignal
  },
): Promise<CliResult> {
  let captured: CliResult | null = null
  const ctx: CliContext = {
    json: true, quiet: true, verbose: false,
    sink: (r) => { captured = r },
    // Single-stage commands report a plain percent; band it as its own stage.
    onProgress: opts.onStage ? (p) => opts.onStage!(opts.defaultStage, p, p) : undefined,
    onStageProgress: opts.onStage,
    signal: opts.signal,
  }
  try {
    await fn(ctx, args)
  } catch (e) {
    const err = e instanceof CliError ? e : new CliError('UNEXPECTED', e instanceof Error ? e.message : String(e))
    return { ok: false, command: 'mcp', code: err.code, message: err.message, remedy: err.remedy ?? null, detail: err.detail ?? null }
  }
  return captured ?? { ok: false, command: 'mcp', code: 'UNEXPECTED', message: 'no result captured', remedy: null, detail: null }
}

/** The `tools/list` payload. */
export function toolList(): { name: string; description: string; inputSchema: Record<string, unknown> }[] {
  return TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))
}

/** Dispatch a `tools/call`. Returns the structured content + isError flag. */
export async function callTool(name: string, input: Record<string, unknown>): Promise<{ structured: unknown; isError: boolean }> {
  if (name === 'get_job_status') {
    const id = str(input.job_id) ?? ''
    const job = getJob(id)
    if (!job) return { structured: { ok: false, code: 'USAGE', message: `unknown job_id: ${id}` }, isError: true }
    return { structured: jobSnapshot(job), isError: job.status === 'failed' }
  }
  // REQ-0457 B6 — enumerate jobs so an agent that lost a job_id can recover.
  if (name === 'list_jobs') {
    return { structured: { ok: true, jobs: listJobs().map(jobSnapshot) }, isError: false }
  }
  // REQ-0457 B6 — cancel a running job (aborts ffmpeg / sidecar).
  if (name === 'cancel_job') {
    const id = str(input.job_id) ?? ''
    const ok = cancelJob(id)
    return { structured: { ok, job_id: id, message: ok ? 'canceled' : 'not running / unknown job_id' }, isError: !ok }
  }

  const spec = TOOLS.find((t) => t.name === name)
  if (!spec) return { structured: { ok: false, code: 'USAGE', message: `unknown tool: ${name}` }, isError: true }

  const { fn, args } = spec.build(input ?? {})

  if (spec.async) {
    const job = createJob(name)
    const controller = new AbortController()
    setJobCancel(job.id, () => controller.abort())
    void runCaptured(fn, args, {
      defaultStage: name,
      onStage: (stage, sp, op) => updateJobStage(job.id, stage, sp, op),
      signal: controller.signal,
    }).then((r) => finishJob(job.id, r))
    return { structured: { ...jobSnapshot(job), hint: 'get_job_status で完了を確認してください。' }, isError: false }
  }

  const result = await runCaptured(fn, args, { defaultStage: name })
  return { structured: result, isError: !result.ok }
}

/** The `get_job_status` tool definition (added to the advertised list). */
export const GET_JOB_STATUS_TOOL = {
  name: 'get_job_status',
  description: '非同期ジョブの状態と結果を取得。{ stage, stageProgress, overallProgress(単調増加), status, result }。',
  inputSchema: {
    type: 'object',
    required: ['job_id'],
    properties: { job_id: { type: 'string', description: 'tools_call が返した job_id' } },
    additionalProperties: false,
  },
}

/** REQ-0457 B6 — enumerate all jobs (recover a lost job_id). */
export const LIST_JOBS_TOOL = {
  name: 'list_jobs',
  description: '全ジョブ一覧（新しい順）。job_id を失っても状態を引ける。',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
}

/** REQ-0457 B6 — cancel a running job (aborts ffmpeg / sidecar). */
export const CANCEL_JOB_TOOL = {
  name: 'cancel_job',
  description: '実行中の非同期ジョブを中止する。',
  inputSchema: {
    type: 'object',
    required: ['job_id'],
    properties: { job_id: { type: 'string', description: '中止する job_id' } },
    additionalProperties: false,
  },
}

/** All job-management tool defs advertised alongside the command tools. */
export const JOB_TOOLS = [GET_JOB_STATUS_TOOL, LIST_JOBS_TOOL, CANCEL_JOB_TOOL]
