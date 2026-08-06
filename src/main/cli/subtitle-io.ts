/**
 * REQ-0447 — CLI subtitle I/O: build `SubtitleEntry[]` from Whisper segments
 * (reusing the exact style seeding the GUI uses) and (de)serialize `.mojioko` /
 * SRT.  Kept separate from the commands so transcribe / burn / translate share
 * one construction path.
 */
import { writeFileSync } from 'node:fs'
import { makeEntryLayoutDefaults } from '../../shared/burnin-defaults'
import { animationFieldsForNewCue } from '../../shared/cue-animation'
import { styleFieldsFromDefaults } from '../../renderer/lib/style-defaults-to-entry'
import { buildProjectFile, serializeProjectFile } from '../../shared/project-file'
import { formatSrtTime } from '../../shared/srt-time'
import type {
  SubtitleEntry,
  TranscriptionDefaults,
  VideoInfo,
  WhisperModelId,
  WordSpan,
} from '../../shared/types'

export type SubtitleFormat = 'mojioko' | 'srt'

/** Resolve the output/input format from an explicit `--format` or the extension. */
export function detectFormat(path: string, override?: string): SubtitleFormat | null {
  if (override === 'mojioko' || override === 'srt') return override
  if (override) return null // explicit but unknown
  const lower = path.toLowerCase()
  if (lower.endsWith('.mojioko')) return 'mojioko'
  if (lower.endsWith('.srt')) return 'srt'
  return null
}

export interface SegmentLike {
  startSec: number
  endSec: number
  text: string
  words?: WordSpan[]
}

/**
 * Build cues from Whisper segments, seeded with the app's default subtitle
 * style (`TranscriptionDefaults`) exactly like STEP1's transcription pipeline
 * (`step1.tsx`).  Font family is inherited from the default style (spec §11);
 * auto line-break is intentionally NOT applied here — `burn` recomputes `\N`
 * against the OUTPUT resolution (spec §3.2 / §3.4).
 */
export function entriesFromSegments(
  segments: SegmentLike[],
  defaults: TranscriptionDefaults,
  video: VideoInfo,
  fontId: string,
  fadeDurationSec: number,
): SubtitleEntry[] {
  const styleFields = styleFieldsFromDefaults(defaults, {
    videoWidthPx: video.widthPx,
    videoHeightPx: video.heightPx,
  })
  return segments.map((seg, i) => {
    const base = {
      startSec: seg.startSec,
      endSec: seg.endSec,
      text: seg.text,
      fadeDurationSec,
      ...animationFieldsForNewCue(defaults),
      fontId,
      words: seg.words,
      ...makeEntryLayoutDefaults(),
      ...styleFields,
    }
    return {
      id: `t-${i}`,
      ...base,
      isDeleted: false,
      isEdited: false,
      original: { ...base, subtitleBackground: { ...base.subtitleBackground } },
    } as SubtitleEntry
  })
}

export interface WriteMojikoArgs {
  outPath: string
  appVersion: string
  video: VideoInfo
  trackIndex: number
  entries: SubtitleEntry[]
  defaults: TranscriptionDefaults
  whisperModel: WhisperModelId | null
  device: 'cpu' | 'gpu'
}

/** Write a complete `.mojioko` project (throws on write failure). */
export function writeMojiokoFile(args: WriteMojikoArgs): void {
  const pf = buildProjectFile({
    appVersion: args.appVersion,
    video: args.video,
    transcribedTrackIndex: args.trackIndex,
    entries: args.entries,
    cuts: [],
    defaults: args.defaults,
    whisperModel: args.whisperModel,
    device: args.device,
  })
  writeFileSync(args.outPath, serializeProjectFile(pf), 'utf-8')
}

/** Serialize cues to SRT text (UTF-8 BOM; `\N` → newline; deleted/empty dropped). */
export function entriesToSrt(entries: SubtitleEntry[]): string {
  const visible = entries.filter((e) => !e.isDeleted && e.text.trim() !== '')
  const blocks = visible.map(
    (e, i) =>
      `${i + 1}\n${formatSrtTime(e.startSec)} --> ${formatSrtTime(e.endSec)}\n${e.text.replace(/\\N/g, '\n')}`,
  )
  return '﻿' + blocks.join('\n\n') + '\n'
}

/** Write cues as SRT (throws on write failure). */
export function writeSrtFile(outPath: string, entries: SubtitleEntry[]): void {
  writeFileSync(outPath, entriesToSrt(entries), 'utf-8')
}
