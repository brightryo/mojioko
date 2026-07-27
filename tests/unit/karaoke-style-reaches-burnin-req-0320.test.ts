import { describe, it, expect, vi, beforeEach } from 'vitest'
import { generateAss } from '../../src/main/services/ass-generator'
import { sampleEntries } from '../../src/renderer/lib/fixtures'
import type { SubtitleEntry, VideoInfo } from '../../src/shared/types'

/**
 * REQ-0320 §1 — `karaokeStyle` must reach the ASS writer, not just the preview.
 *
 * The bug: `services/burnin.ts` rebuilds the IPC payload field-by-field, and
 * `karaokeStyle` was not enumerated, so the value the drawer set was silently
 * dropped on the way to main.  The preview kept working because it reads the
 * settings store directly — so the two disagreed and only the export was wrong.
 *
 * The field is optional in the IPC contract, which is why TypeScript never
 * complained.  Same shape as the settings-merge bug class: an optional field
 * plus an explicit re-construction equals a silent drop.
 *
 * These tests pin BOTH ends of the wire: that the writer honours the flag, and
 * that the renderer service actually forwards it.
 */
const VIDEO: VideoInfo = {
  widthPx: 1920, heightPx: 1080, durationSec: 10, fps: 30,
  path: 'C:/x.mp4', audioTracks: [],
} as unknown as VideoInfo

function karaokeCue(): SubtitleEntry {
  return {
    ...sampleEntries[0],
    text: 'hello world',
    startSec: 0,
    endSec: 2,
    karaokeEnabled: true,
    words: [
      { startSec: 0, endSec: 1, text: 'hello' },
      { startSec: 1, endSec: 2, text: ' world' },
    ],
  } as unknown as SubtitleEntry
}

describe('REQ-0320 §1 — the ASS writer honours karaokeStyle', () => {
  it('sweep emits \kf', () => {
    const ass = generateAss([karaokeCue()], VIDEO, undefined as never, undefined, undefined, false, 'sweep')
    expect(ass).toContain('\kf')
  })

  it('switch emits \k and never \kf', () => {
    const ass = generateAss([karaokeCue()], VIDEO, undefined as never, undefined, undefined, false, 'switch')
    expect(ass).toContain('\k')
    expect(ass).not.toContain('\kf')
  })

  it('the two styles produce DIFFERENT output — the flag is not inert', () => {
    const sweep = generateAss([karaokeCue()], VIDEO, undefined as never, undefined, undefined, false, 'sweep')
    const flip = generateAss([karaokeCue()], VIDEO, undefined as never, undefined, undefined, false, 'switch')
    expect(sweep).not.toBe(flip)
  })
})

describe('REQ-0320 §1 — the renderer service forwards karaokeStyle over IPC', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('includes karaokeStyle in the burninStart payload', async () => {
    const sent: Record<string, unknown>[] = []
    ;(globalThis as unknown as { window: unknown }).window = {
      electronAPI: {
        burninStart: async (req: Record<string, unknown>) => {
          sent.push(req)
          return { ok: false, error: { code: 'STOP', message: 'test stops here' } }
        },
      },
    }
    const { startBurnin } = await import('../../src/renderer/services/burnin')
    await startBurnin(
      {
        inputPath: 'in.mp4',
        outputPath: 'out.mp4',
        entries: [],
        video: VIDEO,
        burnin: {} as never,
        encoderSetting: 'auto',
        audioMode: 'original',
        subtitleBackground: { enabled: false, color: 'black', opacityPercent: 50 },
        outputContainer: 'mp4',
        fontId: 'noto-sans-jp-semibold',
        karaokeStyle: 'sweep',
      } as never,
      () => {},
    ).catch(() => { /* the stub rejects on purpose; we only inspect the payload */ })

    expect(sent.length).toBe(1)
    // The exact regression: this key used to be absent from the rebuilt payload.
    expect('karaokeStyle' in sent[0]).toBe(true)
    expect(sent[0].karaokeStyle).toBe('sweep')
  })
})
