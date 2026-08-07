/**
 * REQ-0457 C7 — `mojioko probe <video>`.
 *
 * ffprobe-equivalent metadata (duration / resolution / fps / audio tracks) so an
 * agent can size a job and pick an audio track before transcribing.  Reuses the
 * bundled ffprobe via `probeVideo` (the same path burn/transcribe use).
 */
import { existsSync } from 'node:fs'
import { probeVideo } from '../../services/ffprobe'
import type { VideoInfo } from '../../../shared/types'
import { optString, type ParsedArgs } from '../args'
import { CliError, emitSuccess, type CliContext } from '../output'

export async function runProbeCommand(ctx: CliContext, args: ParsedArgs): Promise<number> {
  const input = args.positionals[0] ?? optString(args.opts, 'input')
  if (!input) throw new CliError('USAGE', 'video/音声ファイルが必要です。', 'mojioko probe <video>')
  if (!existsSync(input)) throw new CliError('INPUT_NOT_FOUND', `ファイルが見つかりません: ${input}`, 'パスを確認してください。')

  let video: VideoInfo
  try {
    video = await probeVideo(input)
  } catch (e) {
    throw new CliError('UNSUPPORTED_FORMAT', `メディアを読み取れません: ${input}`, 'サポートされた動画/音声ですか？', { error: e instanceof Error ? e.message : String(e) })
  }

  return emitSuccess(ctx, 'probe', {
    path: input,
    durationSec: video.durationSec,
    hasVideoStream: video.hasVideoStream,
    width: video.widthPx,
    height: video.heightPx,
    fps: video.fps,
    videoCodec: video.videoCodec,
    container: video.container,
    fileSizeBytes: video.fileSizeBytes,
    audioTrackCount: video.audioTracks.length,
    hasAudio: video.audioTracks.length > 0,
    audioTracks: video.audioTracks,
  })
}
