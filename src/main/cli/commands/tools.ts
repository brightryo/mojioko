/**
 * REQ-0447 / spec §3.1 — `mojioko tools`.
 *
 * `tools list` (default): aggregates the SAME state builders the GUI uses
 * (`buildModelsState` / `buildTranslationToolsState` / `buildGpuToolState`) plus
 * ffmpeg availability and a `missing[]` list (what's absent + which
 * `tools download …` fixes it), so an agent can pre-check prerequisites.
 *
 * `tools download` / `tools use`: Phase 1b (not implemented yet) — return a
 * clean NOT_IMPLEMENTED with a phased-rollout pointer.
 */
import { existsSync } from 'node:fs'
import { app } from 'electron'
import { buildModelsState } from '../../ipc/transcription'
import { buildTranslationToolsState, isToolInstalled } from '../../services/translation-tool-store'
import { buildGpuToolState, setActiveAccelerator } from '../../services/gpu-tool'
import { downloadModel } from '../../services/model-downloader'
import { downloadTranslationTool } from '../../services/translation-tool-downloader'
import { downloadGpuTool } from '../../services/gpu-tool'
import { checkModelInstalled } from '../../services/check-model-installed'
import { loadSettings, mutateSettings } from '../../services/settings-store'
import { getBinPath, getModelsDir, getTranslationToolsDir } from '../../lib/paths'
import { getTranscriberExePath } from '../../lib/paths'
import { resolveTranslationRuntime } from '../translation-runtime'
import type { WhisperModelId } from '../../../shared/types'
import type { TranslationToolId } from '../../../shared/translation-tools'
import { optString, type ParsedArgs } from '../args'
import { CliError, emitFailure, emitProgress, emitSuccess, type CliContext } from '../output'

const WHISPER_IDS = new Set(['large-v3', 'large-v3-turbo'])

/** Map a `--model 3b|7b` (or full id) to a translation tool id. */
function toTranslationToolId(v: string | undefined): TranslationToolId | null {
  if (!v) return null
  if (v === '7b' || v === 'madlad400-7b') return 'madlad400-7b'
  if (v === '3b' || v === 'madlad400-3b') return 'madlad400-3b'
  return null
}

interface MissingItem {
  what: string
  detail: string
  remedy: string
}

async function runList(ctx: CliContext): Promise<number> {
  const settings = await loadSettings()
  const [whisper, gpu] = await Promise.all([buildModelsState(), buildGpuToolState()])
  const translation = buildTranslationToolsState(settings.translationToolActiveId ?? null)

  const ffmpegAvailable = existsSync(getBinPath('ffmpeg')) && existsSync(getBinPath('ffprobe'))
  const transcriberExe = getTranscriberExePath()

  const missing: MissingItem[] = []
  if (whisper.activeModelId == null) {
    missing.push({
      what: 'whisper-model',
      detail: 'no active Whisper model',
      remedy: 'mojioko tools download whisper --model large-v3-turbo',
    })
  }
  if (translation.activeId == null) {
    missing.push({
      what: 'translation-model',
      detail: 'no active translation model (only needed for `translate`)',
      remedy: 'mojioko tools download translation --model 3b',
    })
  }
  if (!ffmpegAvailable) {
    missing.push({
      what: 'ffmpeg',
      detail: 'bundled ffmpeg/ffprobe not found',
      remedy: 'reinstall MOJIOKO (ffmpeg ships with the app)',
    })
  }

  const data = {
    whisperModels: {
      activeModelId: whisper.activeModelId,
      models: whisper.models.map((m) => ({
        id: m.id,
        status: m.status,
        sizeBytes: m.sizeBytes,
        expectedSizeBytes: m.expectedSizeBytes,
      })),
      modelsDir: getModelsDir(),
    },
    translationTools: {
      activeId: translation.activeId,
      tools: translation.tools.map((t) => ({
        id: t.id,
        status: t.status,
        sizeBytes: t.sizeBytes,
        expectedSizeBytes: t.expectedSizeBytes,
      })),
      toolsDir: getTranslationToolsDir(),
    },
    gpu: {
      installStatus: gpu.installStatus,
      activeAccelerator: gpu.activeAccelerator,
      detection: gpu.detection,
    },
    ffmpeg: { available: ffmpegAvailable },
    pythonSidecar: {
      transcriber: transcriberExe ? 'bundled-exe' : 'venv-required',
      // REQ-0500 §3-2 — was hard-coded `'venv-required'`, which became WRONG at
      // REQ-0494 (translation now ships inside the same PyInstaller bundle).
      // A constant cannot track a resolution rule, so ask the real resolver.
      translator: resolveTranslationRuntime().mode,
    },
    fonts: { bundledFamily: 'Noto Sans JP', weights: 9, note: 'CLI はアプリ既定スタイルのフォントを継承（§11）' },
    missing,
  }

  return emitSuccess(ctx, 'tools', data)
}

export async function runToolsCommand(ctx: CliContext, args: ParsedArgs): Promise<number> {
  const sub = args.positionals[0] ?? 'list'

  if (sub === 'list') {
    return runList(ctx)
  }

  if (sub === 'use') return runUse(ctx, args)
  if (sub === 'download') return runDownload(ctx, args)

  return emitFailure(
    ctx,
    'tools',
    new CliError('USAGE', `unknown tools subcommand: "${sub}"`, 'mojioko tools -h でサブコマンド一覧を表示。'),
  )
}

/**
 * Guard against a last-write-wins race with a running MOJIOKO app. The GUI
 * holds the single-instance lock (see main/index.ts); if the CLI cannot acquire
 * it, the app is running. The lock is released on process exit.
 *
 * ## Why there is no `--force` escape (REQ-0506 §2-2)
 *
 * There used to be one. It could not work: the keys this command writes are
 * clobbered by the GUI's next settings save regardless.
 *   - `transcriptionDefaults` (carrying `whisperModel`) is `'incoming-wins'`
 *     and merged as ONE object, so the renderer's copy replaces it wholesale.
 *   - `activeModelId` / `translationToolActiveId` / `activeAccelerator` are
 *     `'incoming-else-existing'` = `incoming ?? existing`, so any non-null
 *     value from the renderer wins.
 * So `--force` reported success and the setting reverted — the "succeeds but
 * does not take effect" class REQ-0499 onwards has been deleting. `preset`
 * dropped its copy of this flag in REQ-0505; keeping this one would have been
 * the same defect, differing only in which key it silently discards.
 */
function acquireWriteLock(): boolean {
  return app.requestSingleInstanceLock()
}

async function runUse(ctx: CliContext, args: ParsedArgs): Promise<number> {
  const what = args.positionals[1]
  const value = args.positionals[2] ?? optString(args.opts, 'model') ?? optString(args.opts, 'device')

  if (!acquireWriteLock()) {
    throw new CliError(
      'USAGE',
      'MOJIOKO アプリ起動中は CLI から設定を書き込めません（競合回避）。',
      'MOJIOKO を終了してから再実行するか、アプリ内で設定してください。アプリ起動中の書き込みはアプリ側の保存で失われるため、強制する手段は用意していません。',
    )
  }

  if (what === 'whisper') {
    const model = optString(args.opts, 'model') || value
    if (!model || !WHISPER_IDS.has(model)) throw new CliError('USAGE', 'tools use whisper --model large-v3|large-v3-turbo')
    if (!checkModelInstalled(model, getModelsDir()).installed) {
      throw new CliError('MODEL_NOT_FOUND', `Whisper モデル "${model}" が未導入です。`, `mojioko tools download whisper --model ${model}`, { model })
    }
    await mutateSettings((s) => {
      s.activeModelId = model as WhisperModelId
      s.transcriptionDefaults = { ...s.transcriptionDefaults, whisperModel: model as WhisperModelId }
      return { save: s, value: null }
    })
    return emitSuccess(ctx, 'tools', { used: 'whisper', activeModelId: model })
  }

  if (what === 'translation') {
    const toolId = toTranslationToolId(optString(args.opts, 'model') || value)
    if (!toolId) throw new CliError('USAGE', 'tools use translation --model 3b|7b')
    if (!isToolInstalled(toolId, getTranslationToolsDir())) {
      throw new CliError('TOOL_NOT_DOWNLOADED', `翻訳モデル "${toolId}" が未導入です。`, `mojioko tools download translation --model ${toolId === 'madlad400-7b' ? '7b' : '3b'}`, { toolId })
    }
    await mutateSettings((s) => {
      s.translationToolActiveId = toolId
      return { save: s, value: null }
    })
    return emitSuccess(ctx, 'tools', { used: 'translation', activeTranslationId: toolId })
  }

  if (what === 'device') {
    const device = (optString(args.opts, 'device') || value) as 'cpu' | 'gpu'
    if (device !== 'cpu' && device !== 'gpu') throw new CliError('USAGE', 'tools use device cpu|gpu')
    const state = await setActiveAccelerator(device)
    const warnings = state.activeAccelerator !== device
      ? [{ code: 'GPU_INIT_FAILED', message: `GPU を選択できないため ${state.activeAccelerator} になりました（GPU ツール未導入 or 非 NVIDIA）。`, detail: { requested: device, effective: state.activeAccelerator } }]
      : []
    return emitSuccess(ctx, 'tools', { used: 'device', activeAccelerator: state.activeAccelerator }, warnings)
  }

  throw new CliError('USAGE', `tools use <whisper|translation|device> ...`, 'mojioko tools -h を参照。')
}

async function runDownload(ctx: CliContext, args: ParsedArgs): Promise<number> {
  const what = args.positionals[1]
  const controller = new AbortController()
  const onProgress = (evt: { event: string; percent?: number; file?: string }): void => {
    if (evt.event === 'progress') emitProgress(ctx, { event: 'progress', target: what, file: evt.file, percent: evt.percent })
  }

  if (what === 'whisper') {
    const model = (optString(args.opts, 'model') || 'large-v3-turbo') as WhisperModelId
    if (!WHISPER_IDS.has(model)) throw new CliError('USAGE', 'tools download whisper --model large-v3|large-v3-turbo')
    const modelsDir = getModelsDir()
    if (checkModelInstalled(model, modelsDir).installed) {
      return emitSuccess(ctx, 'tools', { downloaded: 'whisper', model, alreadyInstalled: true })
    }
    try {
      await downloadModel(model, modelsDir, onProgress, controller.signal)
    } catch (e) {
      throw new CliError('OUTPUT_WRITE_FAILED', `Whisper モデルの DL に失敗: ${e instanceof Error ? e.message : String(e)}`, 'ネットワーク・空き容量を確認して再実行してください（resume 対応）。')
    }
    return emitSuccess(ctx, 'tools', { downloaded: 'whisper', model, alreadyInstalled: false })
  }

  if (what === 'translation') {
    const toolId = toTranslationToolId(optString(args.opts, 'model') || '3b')
    if (!toolId) throw new CliError('USAGE', 'tools download translation --model 3b|7b')
    const toolsDir = getTranslationToolsDir()
    if (isToolInstalled(toolId, toolsDir)) {
      return emitSuccess(ctx, 'tools', { downloaded: 'translation', model: toolId, alreadyInstalled: true })
    }
    try {
      await downloadTranslationTool(toolId, toolsDir, onProgress, controller.signal)
    } catch (e) {
      throw new CliError('OUTPUT_WRITE_FAILED', `翻訳モデルの DL に失敗: ${e instanceof Error ? e.message : String(e)}`, 'ネットワーク・空き容量を確認して再実行してください（resume 対応）。')
    }
    return emitSuccess(ctx, 'tools', { downloaded: 'translation', model: toolId, alreadyInstalled: false })
  }

  if (what === 'gpu') {
    const gpu = await buildGpuToolState()
    if (gpu.installStatus === 'installed') {
      return emitSuccess(ctx, 'tools', { downloaded: 'gpu', alreadyInstalled: true })
    }
    try {
      await downloadGpuTool((evt) => {
        if (evt.event === 'progress') emitProgress(ctx, { event: 'progress', target: 'gpu', percent: evt.percent })
      }, controller.signal)
    } catch (e) {
      throw new CliError('OUTPUT_WRITE_FAILED', `GPU ツールの DL に失敗: ${e instanceof Error ? e.message : String(e)}`, 'ネットワーク・空き容量を確認して再実行してください。')
    }
    return emitSuccess(ctx, 'tools', { downloaded: 'gpu', alreadyInstalled: false })
  }

  throw new CliError('USAGE', `tools download <whisper|translation|gpu> [--model <id>]`, 'mojioko tools -h を参照。')
}
