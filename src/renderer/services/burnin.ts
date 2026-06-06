import type { SubtitleEntry, VideoInfo, BurninPosition, SubtitleBackground, IpcResult, EncoderSetting, AudioMode, OutputContainer } from '../../shared/types'
import type { BurninEvent } from '../../shared/ipc-contracts'
import type { FontId } from '../../shared/fonts'
import type { Cut } from '../../shared/cuts'

export interface BurninOptions {
  inputPath: string
  outputPath: string
  entries: SubtitleEntry[]
  video: VideoInfo
  burnin: BurninPosition
  encoderSetting: EncoderSetting
  audioMode: AudioMode
  fadeDurationSec: number
  subtitleBackground: SubtitleBackground
  outputContainer: OutputContainer
  /** Currently selected subtitle font.  Forwarded to libass via the ASS Style. */
  fontId: FontId
  /**
   * Trim/cut list (Original axis).  Omit or pass empty array for the
   * legacy no-cut behaviour; when non-empty the main side rebuilds the
   * ffmpeg command around filter_complex trim+concat.
   */
  cuts?: Cut[]
}

export interface BurninHandle {
  cancel: () => void
}

export async function startBurnin(
  opts: BurninOptions,
  onEvent: (event: BurninEvent) => void
): Promise<BurninHandle> {
  const result = await window.electronAPI.burninStart({
    inputPath: opts.inputPath,
    outputPath: opts.outputPath,
    entries: opts.entries,
    video: opts.video,
    burnin: opts.burnin,
    encoderSetting: opts.encoderSetting,
    audioMode: opts.audioMode,
    fadeDurationSec: opts.fadeDurationSec,
    subtitleBackground: opts.subtitleBackground,
    outputContainer: opts.outputContainer,
    fontId: opts.fontId,
    cuts: opts.cuts
  })

  if (!result.ok) {
    throw new Error(result.error.message)
  }

  const { channelId } = result.data
  const unsub = window.electronAPI.subscribeToChannel(channelId, (payload) => {
    onEvent(payload as BurninEvent)
  })

  return {
    cancel: () => {
      unsub()
      window.electronAPI.burninCancel(channelId)
    }
  }
}

// Legacy sync-style stub kept for compatibility; not used in Phase 5+
export async function startBurninLegacy(_options: { inputPath: string; outputPath: string; assPath: string }): Promise<IpcResult<void>> {
  return { ok: false, error: { code: 'USE_START_BURNIN', message: 'Use startBurnin instead' } }
}
