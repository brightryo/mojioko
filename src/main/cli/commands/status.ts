/**
 * REQ-0449 §2 — `mojioko status`.
 *
 * One JSON payload that gives an agent everything it needs to decide what to do:
 * version, command list, tool/model/GPU/ffmpeg state, current settings (active
 * model, device, subtitle-style summary), and — crucially — `ready` +
 * `blockers[]`, where each blocker carries the exact command string to run to
 * clear it (consistent with the failure `remedy` fields).
 */
import { existsSync } from 'node:fs'
import { buildModelsState } from '../../ipc/transcription'
import { buildTranslationToolsState } from '../../services/translation-tool-store'
import { buildGpuToolState } from '../../services/gpu-tool'
import { loadSettings } from '../../services/settings-store'
import { getBinPath, getModelsDir, getTranscriberExePath } from '../../lib/paths'
import { APP_VERSION } from '../../../shared/app-info'
import { commandSummaries } from '../help'
import { resolveDefaultSubtitleStyle } from '../subtitle-style'
import { emitSuccess, type CliContext } from '../output'

interface Blocker {
  what: string
  message: string
  command: string
}

export async function runStatusCommand(ctx: CliContext): Promise<number> {
  const settings = await loadSettings()
  const [whisper, gpu] = await Promise.all([buildModelsState(), buildGpuToolState()])
  const translation = buildTranslationToolsState(settings.translationToolActiveId ?? null)
  const ffmpegAvailable = existsSync(getBinPath('ffmpeg')) && existsSync(getBinPath('ffprobe'))

  // `ready` = the minimum for the core transcribe/burn flow. Translation is
  // optional (only `translate`/`run --translate` need it), so it is surfaced as
  // an advisory, not a hard blocker.
  const blockers: Blocker[] = []
  if (!ffmpegAvailable) {
    blockers.push({ what: 'ffmpeg', message: '同梱 ffmpeg/ffprobe が見つかりません。', command: '(MOJIOKO を再インストール)' })
  }
  if (whisper.activeModelId == null) {
    blockers.push({
      what: 'whisper-model',
      message: 'アクティブな Whisper モデルがありません（transcribe に必須）。',
      command: 'mojioko tools download whisper --model large-v3-turbo && mojioko tools use whisper --model large-v3-turbo',
    })
  }
  const ready = blockers.length === 0

  const advisories: Blocker[] = []
  if (translation.activeId == null) {
    advisories.push({
      what: 'translation-model',
      message: '翻訳モデル未選択（translate を使うときのみ必要）。',
      command: 'mojioko tools download translation --model 3b && mojioko tools use translation --model 3b',
    })
  }

  return emitSuccess(ctx, 'status', {
    version: APP_VERSION,
    ready,
    blockers,
    advisories,
    commands: commandSummaries(),
    tools: {
      whisper: {
        activeModelId: whisper.activeModelId,
        installed: whisper.models.filter((m) => m.status !== 'not-installed').map((m) => m.id),
        modelsDir: getModelsDir(),
      },
      translation: {
        activeId: translation.activeId,
        installed: translation.tools.filter((t) => t.status !== 'not-downloaded').map((t) => t.id),
      },
      gpu: { installStatus: gpu.installStatus, detection: gpu.detection.category, nvidiaName: gpu.detection.nvidiaName },
      ffmpeg: { available: ffmpegAvailable },
      transcriber: getTranscriberExePath() ? 'bundled-exe' : 'venv-required',
    },
    settings: {
      activeModelId: whisper.activeModelId,
      device: settings.activeAccelerator ?? 'cpu',
      // REQ-0457 A1 — the FULL resolved subtitle style (karaoke / emphasis /
      // animation / shadow / rotation / alpha / line-spacing / offset), so an
      // agent can confirm every burn condition before spending a burn.
      subtitleStyle: resolveDefaultSubtitleStyle(settings),
    },
  })
}
