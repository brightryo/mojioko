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
import { resolveTranslationRuntime } from '../translation-runtime'
import { resolveTier } from '../../lib/tier'
import { APP_VERSION } from '../../../shared/app-info'
import { commandSummaries } from '../help'
import { resolveDefaultSubtitleStyle } from '../subtitle-style'
import { getLaunchStaleness } from '../../mcp/launch'
import { emitSuccess, type CliContext, type CliWarning } from '../output'

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

  // REQ-0458 §2 — when this server was launched via an MCP bundle, report
  // whether that bundle is stale (its launch-spec revision differs from the
  // current app's), so the agent can advise a re-export/re-install.
  const staleness = getLaunchStaleness()
  const warnings: CliWarning[] = []
  if (staleness.stale) {
    warnings.push({
      code: 'STALE_MCP_BUNDLE',
      message: '古い MCP バンドルで起動されています（起動仕様が更新されています）。',
      detail: { launchedRevision: staleness.launchedRevision, expectedRevision: staleness.expectedRevision, remedy: staleness.remedy },
    })
  }

  // REQ-0507 §2-4 — tier, with the reason it was decided.  Until now the only
  // way to tell a free build from a paid one was to read the font list and
  // infer, which is a workaround, not an answer.
  const tier = resolveTier()

  return emitSuccess(ctx, 'status', {
    version: APP_VERSION,
    ready,
    blockers,
    advisories,
    tier: {
      tier: tier.tier,
      isPaid: tier.isPaid,
      source: tier.source,
      /**
       * REQ-0508 §2-4 — was `'renderer-only'`, which was the honest answer
       * while the tier was reported but not enforced (RES-0507 §1). The render
       * path now applies the policy for every caller, so the value changes with
       * the behaviour: leaving it stale would recreate, in the field that
       * exists to prevent it, the report-versus-reality gap REQ-0507 measured.
       *
       * `'render-path'` names WHERE it is enforced, because that is the part
       * an agent can act on: choosing a paid font still succeeds everywhere
       * (settings, presets, project files, `font:download`) and is substituted
       * at draw time with a `FONT_TIER_SUBSTITUTED` warning.
       */
      fontEnforcement: 'render-path',
    },
    // REQ-0458 §2 — MCP launch-spec revision + stale-bundle verdict.
    mcpBundle: {
      launchSpecRevision: staleness.expectedRevision,
      launchedRevision: staleness.launchedRevision,
      stale: staleness.stale,
      remedy: staleness.remedy,
    },
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
        // REQ-0500 §3-2 — a model being INSTALLED says nothing about whether the
        // translator can actually run.  REQ-0493 shipped a build where the model
        // was present and every translate failed with PYTHON_MISSING, and
        // `status` looked completely healthy throughout.  Report how the runtime
        // resolves, in the same vocabulary as `transcriber` below.
        runtime: resolveTranslationRuntime(),
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
      // REQ-0457 D12 — names of GUI-saved style presets usable via `burn --style`.
      stylePresets: (settings.stylePresets ?? []).map((p) => p.name),
    },
  }, warnings)
}
