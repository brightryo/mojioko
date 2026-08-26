import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * REQ-0319 §1 — settings writes in main must be serialised.
 *
 * Every settings write is a `loadSettings -> mutate -> saveSettings` cycle and
 * `saveSettings` is a bare `fs.writeFile`.  The call sites are independent async
 * IPC handlers, so two can interleave on the event loop:
 *
 *     A load -> B load -> A save -> B save        (A's write is lost)
 *
 * What is asserted here is the PROPERTY the lock provides — strict call-order
 * execution and no lost field — rather than a reproduction of the unlocked
 * failure.  A faithful unlocked reproduction was attempted and dropped: the
 * in-memory `readFile` mock returns the file contents at RESOLVE time, so it
 * cannot model a caller holding a pre-write snapshot without becoming a
 * different program from the one under test.  The real-world reachability of
 * the interleaving is argued from the call sites in RES-0318 §7.
 *
 * `electron` and `fs` are mocked because `settings-store` reaches for
 * `app.isPackaged` and the real settings.json path.
 */
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => 'C:/tmp/mojioko-test', getName: () => 'MOJIOKO' },
}))

/** In-memory settings.json with a controllable read delay. */
const disk = { content: '' }
let readDelayMs = 0

vi.mock('fs', () => ({
  promises: {
    readFile: async () => {
      if (readDelayMs > 0) await new Promise((r) => setTimeout(r, readDelayMs))
      return disk.content
    },
    writeFile: async (_p: string, data: string) => {
      disk.content = data
    },
    mkdir: async () => undefined,
    rename: async () => undefined,
    unlink: async () => undefined,
    /*
     * REQ-0545 — `saveSettings` now writes through `writeFileAtomic`
     * (temp -> fsync -> rename) instead of a bare `writeFile`, so the mock
     * needs the handle API too.
     *
     * This mock is deliberately PATH-AGNOSTIC — it models one settings file as
     * `disk.content` — so the temp write lands in the same slot and the
     * no-op `rename` is already correct. What this file asserts (call ordering
     * and that no update is lost) is unchanged by the write mechanism.
     */
    readdir: async () => [],
    open: async () => ({
      writeFile: async (data: string) => { disk.content = data },
      sync: async () => undefined,
      close: async () => undefined,
    }),
  },
}))

const BASE = {
  version: 1,
  language: 'ja',
  transcriptionDefaults: {
    fontSizePx: 100,
    textColorHex: '#ffffff',
    outlineColorHex: '#000000',
    outlineThicknessPx: 3,
    whisperModel: 'large-v3',
  },
  transcriptionAdvanced: {
    vadFilter: true,
    vadThreshold: 0.5,
    minSpeechDurationMs: 250,
    minSilenceDurationMs: 2000,
    beamSize: 5,
    language: 'auto',
  },
  autoLineBreak: true,
  encoder: 'auto',
  defaultAudioTrackIndex: 1,
  fadeDurationSec: 0,
  activeModelId: 'large-v3',
  lastInputDir: null,
  lastOutputDir: null,
}

describe('REQ-0319 §1 — concurrent settings writes do not lose updates', () => {
  beforeEach(() => {
    disk.content = JSON.stringify(BASE)
    readDelayMs = 0
  })

  it('two interleaved read-modify-writes both survive', async () => {
    const { mutateSettings } = await import('../../src/main/services/settings-store')

    // The delay guarantees B's read starts before A's write lands — the exact
    // interleaving that used to drop a field.
    readDelayMs = 20

    const a = mutateSettings((s) => {
      s.activeAccelerator = 'gpu'
      return { save: s, value: null }
    })
    const b = mutateSettings((s) => {
      s.fontSetInstalledVersion = 7
      return { save: s, value: null }
    })
    await Promise.all([a, b])

    const final = JSON.parse(disk.content)
    // Without serialisation whichever wrote second would have started from the
    // pre-A snapshot and erased the other's field.
    expect(final.activeAccelerator, 'A lost').toBe('gpu')
    expect(final.fontSetInstalledVersion, 'B lost').toBe(7)
  })

  it('runs strictly in call order', async () => {
    const { mutateSettings } = await import('../../src/main/services/settings-store')
    readDelayMs = 5
    const order: number[] = []
    await Promise.all(
      [1, 2, 3, 4].map((n) =>
        mutateSettings((s) => {
          order.push(n)
          s.language = String(n)
          return { save: s, value: null }
        }),
      ),
    )
    expect(order).toEqual([1, 2, 3, 4])
    expect(JSON.parse(disk.content).language).toBe('4')
  })

  it('a rejected mutation does not poison the queue', async () => {
    const { mutateSettings } = await import('../../src/main/services/settings-store')
    const boom = mutateSettings(() => {
      throw new Error('boom')
    })
    await expect(boom).rejects.toThrow('boom')

    // The very next write must still go through — a broken link that killed the
    // chain would silently stop ALL later settings writes.
    await mutateSettings((s) => {
      s.language = 'en'
      return { save: s, value: null }
    })
    expect(JSON.parse(disk.content).language).toBe('en')
  })

  it('returns the mutation value to the caller', async () => {
    const { mutateSettings } = await import('../../src/main/services/settings-store')
    const got = await mutateSettings((s) => ({ save: s, value: 'payload' as const }))
    expect(got).toBe('payload')
  })
})
