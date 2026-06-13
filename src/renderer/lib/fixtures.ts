import type { VideoInfo, SubtitleEntry, TranscriptionDefaults } from '../../shared/types'
import { BURNIN_DEFAULTS, makeEntryLayoutDefaults } from '../../shared/burnin-defaults'

export const sampleVideoInfo: VideoInfo = {
  path: 'C:\\Users\\user\\Videos\\stream_2024-01-15.mkv',
  hasVideoStream: true,
  widthPx: 1920,
  heightPx: 1080,
  durationSec: 872,
  fps: 30,
  container: 'mkv',
  videoCodec: 'h264',
  audioTracks: [
    { index: 1, channels: 'stereo', sampleRateHz: 48000, codec: 'aac', language: 'und' },
    { index: 2, channels: 'mono', sampleRateHz: 48000, codec: 'aac', language: 'jpn' }
  ],
  fileSizeBytes: 1_234_567_890
}

export const sampleDefaults: TranscriptionDefaults = {
  fontSizePx: BURNIN_DEFAULTS.fontSizePx,
  textColorHex: BURNIN_DEFAULTS.textColorHex,
  outlineColorHex: BURNIN_DEFAULTS.outlineColorHex,
  outlineThicknessPx: BURNIN_DEFAULTS.outlineThicknessPx,
  fadeEnabled: BURNIN_DEFAULTS.fadeEnabled,
  whisperModel: BURNIN_DEFAULTS.whisperModel
}

function makeEntry(
  id: string,
  startSec: number,
  endSec: number,
  text: string,
  overrides?: Partial<SubtitleEntry>
): SubtitleEntry {
  const base = {
    startSec,
    endSec,
    text,
    fontSizePx: sampleDefaults.fontSizePx,
    textColorHex: sampleDefaults.textColorHex,
    outlineColorHex: sampleDefaults.outlineColorHex,
    outlineThicknessPx: sampleDefaults.outlineThicknessPx,
    fadeEnabled: sampleDefaults.fadeEnabled,
    ...makeEntryLayoutDefaults()
  }
  return {
    id,
    ...base,
    isDeleted: false,
    isEdited: false,
    original: { ...base, subtitleBackground: { ...base.subtitleBackground } },
    ...overrides
  }
}

export const sampleEntries: SubtitleEntry[] = [
  makeEntry('e-001', 2.5, 5.1, 'ゲームを開始します。'),
  makeEntry('e-002', 6.3, 9.8, 'このステージはかなり難しいですね。'),
  makeEntry('e-003', 11.0, 14.2, 'アイテムを取得しました。'),
  makeEntry('e-004', 15.5, 18.9, '敵が多いので注意してください。', {
    isEdited: true,
    text: '敵がたくさんいるので気をつけてください。',
    original: {
      startSec: 15.5,
      endSec: 18.9,
      text: '敵が多いので注意してください。',
      fontSizePx: 100,
      textColorHex: '#ffffff',
      outlineColorHex: '#000000',
      outlineThicknessPx: 3,
      fadeEnabled: true,
      ...makeEntryLayoutDefaults()
    }
  }),
  makeEntry('e-005', 20.1, 23.4, 'ボスが登場しました。'),
  makeEntry('e-006', 24.8, 27.5, 'ここはHPが少なくなったときに使えるアイテムが隠れています。'),
  makeEntry('e-007', 29.0, 32.1, 'スキルのクールダウンが明けました。', {
    isEdited: true,
    fontSizePx: 80,
    original: {
      startSec: 29.0,
      endSec: 32.1,
      text: 'スキルのクールダウンが明けました。',
      fontSizePx: 100,
      textColorHex: '#ffffff',
      outlineColorHex: '#000000',
      outlineThicknessPx: 3,
      fadeEnabled: true,
      ...makeEntryLayoutDefaults()
    }
  }),
  makeEntry('e-008', 33.5, 36.0, 'なんとか生き残ることができました。'),
  makeEntry('e-009', 37.2, 40.8, '次のエリアに進みます。', {
    isDeleted: true
  }),
  makeEntry(
    'e-010',
    42.0,
    46.5,
    'このボスのパターンを覚えたら結構簡単に倒せるようになると思います。この台詞は横幅を超えてしまうので赤くハイライトされます。'
  ),
  makeEntry('e-011', 47.8, 50.9, 'レベルアップしました。'),
  makeEntry('e-012', 52.0, 55.3, '今日の配信はここまでにします。ご視聴ありがとうございました。')
]

