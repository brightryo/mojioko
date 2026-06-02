import { promises as fsp } from 'fs'
import { getBinPath } from '../lib/paths'
import { execFileAsync } from '../lib/child-process'
import { FFPROBE_TIMEOUT_MS } from '../../shared/constants'
import type { VideoInfo, AudioTrack } from '../../shared/types'
import { InvalidVideoError } from '../../shared/errors'
import log from '../lib/logger'

interface FfprobeStream {
  codec_type: 'video' | 'audio' | string
  codec_name: string
  width?: number
  height?: number
  r_frame_rate?: string
  avg_frame_rate?: string
  channels?: number
  sample_rate?: string
  index: number
  tags?: { language?: string; title?: string }
}

interface FfprobeFormat {
  format_name: string
  duration: string
}

interface FfprobeOutput {
  streams: FfprobeStream[]
  format: FfprobeFormat
}

export async function probeVideo(filePath: string): Promise<VideoInfo> {
  const ffprobe = getBinPath('ffprobe')
  const args = [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_streams',
    '-show_format',
    filePath
  ]

  log.info(`[ffprobe] probing: ${filePath}`)

  const { stdout } = await execFileAsync(ffprobe, args, {
    timeout: FFPROBE_TIMEOUT_MS
  })

  const base = parseProbeOutput(JSON.parse(stdout) as FfprobeOutput, filePath)
  let fileSizeBytes = 0
  try {
    const stat = await fsp.stat(filePath)
    fileSizeBytes = stat.size
  } catch { /* ignore */ }
  return { ...base, fileSizeBytes }
}

function normalizeContainer(formatName: string): string {
  const first = formatName.split(',')[0] ?? 'unknown'
  // ffprobe reports 'matroska' for .mkv files; normalise to match VideoInfo type
  if (first === 'matroska') return 'mkv'
  return first
}

function parseProbeOutput(data: FfprobeOutput, filePath: string): VideoInfo {
  const videoStream = data.streams.find((s) => s.codec_type === 'video')
  const audioStreams = data.streams.filter((s) => s.codec_type === 'audio')

  // Only reject inputs that have NEITHER video nor audio.  REQ-028:
  // audio-only files (no video stream) are now first-class inputs.
  if (!videoStream && audioStreams.length === 0) {
    throw new InvalidVideoError('No audio or video stream found in file', { filePath })
  }

  const audioTracks: AudioTrack[] = audioStreams.map((s, i) => ({
    index: i + 1,
    channels: s.channels === 1 ? 'mono' : s.channels === 2 ? 'stereo' : `${s.channels ?? 0}ch`,
    sampleRateHz: parseInt(s.sample_rate ?? '48000', 10),
    codec: s.codec_name,
    language: s.tags?.language
  }))

  const fps = videoStream
    ? parseFps(videoStream.r_frame_rate ?? videoStream.avg_frame_rate)
    : 0
  const durationSec = parseFloat(data.format.duration)

  return {
    path: filePath,
    hasVideoStream: videoStream !== undefined,
    // When no video stream is present, width/height/codec carry no
    // meaning.  Existing video-mode callers always check via
    // hasVideoStream (or via the route gate `useIsAudioOnly`); audio
    // mode reads these fields nowhere.
    widthPx: videoStream?.width ?? 0,
    heightPx: videoStream?.height ?? 0,
    durationSec: isNaN(durationSec) ? 0 : durationSec,
    fps,
    container: normalizeContainer(data.format.format_name),
    videoCodec: videoStream?.codec_name ?? '',
    audioTracks,
    fileSizeBytes: 0
  }
}

function parseFps(rational: string | undefined): number {
  if (!rational) return 30
  const [num, den] = rational.split('/').map(Number)
  if (!den) return num || 30
  return Math.round((num / den) * 100) / 100
}

export async function extractThumbnail(filePath: string, atSec: number): Promise<string> {
  const ffmpeg = getBinPath('ffmpeg')
  const args = [
    '-y',
    '-ss', String(atSec),
    '-i', filePath,
    '-frames:v', '1',
    '-f', 'image2pipe',
    '-vcodec', 'png',
    'pipe:1'
  ]

  const { stdout } = await execFileAsync(ffmpeg, args, {
    timeout: FFPROBE_TIMEOUT_MS,
    encoding: 'buffer',
    maxBuffer: 10 * 1024 * 1024
  })

  return `data:image/png;base64,${(stdout as unknown as Buffer).toString('base64')}`
}
