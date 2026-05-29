import type { SubtitleEntry, VideoInfo, BurninPosition, SubtitleBackground, IpcResult, EncoderSetting, AudioMode, OutputContainer } from '../../shared/types'
import type { BurninEvent } from '../../shared/ipc-contracts'

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
    outputContainer: opts.outputContainer
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
