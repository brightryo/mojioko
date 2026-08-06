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
import { buildModelsState } from '../../ipc/transcription'
import { buildTranslationToolsState } from '../../services/translation-tool-store'
import { buildGpuToolState } from '../../services/gpu-tool'
import { loadSettings } from '../../services/settings-store'
import { getBinPath, getModelsDir, getTranslationToolsDir } from '../../lib/paths'
import { getTranscriberExePath } from '../../lib/paths'
import type { ParsedArgs } from '../args'
import { CliError, emitFailure, emitSuccess, type CliContext } from '../output'

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
      translator: 'venv-required',
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

  if (sub === 'download' || sub === 'use') {
    return emitFailure(
      ctx,
      'tools',
      new CliError(
        'NOT_IMPLEMENTED',
        `\`tools ${sub}\` はまだ実装されていません（Phase 1b）。`,
        '現時点ではアプリ（GUI）でモデル/デバイスを設定してください。状態は `mojioko tools` で確認できます。',
        { subcommand: sub, phase: '1b' },
      ),
    )
  }

  return emitFailure(
    ctx,
    'tools',
    new CliError('USAGE', `unknown tools subcommand: "${sub}"`, 'mojioko tools -h でサブコマンド一覧を表示。'),
  )
}
