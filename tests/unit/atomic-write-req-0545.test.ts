import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * REQ-0545 §1 (RES-0543 F1) — a write must not be able to destroy the previous
 * file.
 *
 * ## What was wrong
 *
 * `shell:writeTextFile` (project save, SRT/text export) and `saveSettings` were
 * both a bare `fs.writeFile` onto the destination. That truncates the target
 * first, so a failure part-way through leaves a fragment and no copy of what
 * was there. Overwriting the `.mojioko` you opened is the ordinary save
 * gesture, so this is reachable by doing the normal thing on a full disk.
 *
 * ## What is asserted
 *
 * The guarantee, not the implementation: after a failure at any stage the
 * destination is **byte-identical to what it was**. The negative control is the
 * old behaviour — a direct `writeFile` against the same in-memory disk — shown
 * to corrupt under the same fault, so the test cannot pass vacuously.
 */

/** In-memory disk with an injectable fault. */
const disk = new Map<string, string>()
let failOn: null | 'open' | 'write' | 'sync' | 'rename' = null
let renameFailures = 0        // how many rename calls should fail before succeeding
let renameCalls = 0
let syncCalls = 0

const err = (code: string) => Object.assign(new Error(code), { code })

vi.mock('fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('fs')>()),
  promises: {
    readdir: async (dir: string) => {
      const prefix = String(dir).replace(/\\/g, '/') + '/'
      return [...disk.keys()]
        .filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/'))
        .map((k) => k.slice(prefix.length))
    },
    open: async (p: string) => {
      if (failOn === 'open') throw err('EACCES')
      const path = String(p).replace(/\\/g, '/')
      return {
        writeFile: async (content: string) => {
          if (failOn === 'write') {
            // A partial write is the realistic ENOSPC shape: bytes land, then
            // the call fails. Modelling it as "nothing happened" would let a
            // broken implementation pass.
            disk.set(path, content.slice(0, Math.floor(content.length / 2)))
            throw err('ENOSPC')
          }
          disk.set(path, content)
        },
        sync: async () => { syncCalls++; if (failOn === 'sync') throw err('EIO') },
        close: async () => {},
      }
    },
    rename: async (from: string, to: string) => {
      renameCalls++
      if (failOn === 'rename' && renameCalls <= renameFailures) throw err('EPERM')
      const a = String(from).replace(/\\/g, '/')
      const b = String(to).replace(/\\/g, '/')
      const v = disk.get(a)
      if (v === undefined) throw err('ENOENT')
      disk.set(b, v)
      disk.delete(a)
    },
    unlink: async (p: string) => { disk.delete(String(p).replace(/\\/g, '/')) },
    writeFile: async (p: string, content: string) => {
      // The PRE-FIX behaviour, kept for the negative control below.
      const path = String(p).replace(/\\/g, '/')
      if (failOn === 'write') {
        disk.set(path, content.slice(0, Math.floor(content.length / 2)))
        throw err('ENOSPC')
      }
      disk.set(path, content)
    },
  },
}))

const TARGET = 'C:/work/project.mojioko'
const ORIGINAL = '{"version":1,"subtitles":["the user\'s existing work"]}'
const NEXT = '{"version":1,"subtitles":["a longer, newly edited version of the project"]}'

const tempsFor = (target: string) =>
  [...disk.keys()].filter((k) => k.startsWith(target + '.tmp-'))

beforeEach(() => {
  disk.clear()
  disk.set(TARGET, ORIGINAL)
  failOn = null
  renameFailures = 0
  renameCalls = 0
  syncCalls = 0
})

describe('REQ-0545 §1 — the happy path', () => {
  it('replaces the contents and leaves no temp file behind', async () => {
    const { writeFileAtomic } = await import('../../src/main/lib/atomic-write')
    await writeFileAtomic(TARGET, NEXT)
    expect(disk.get(TARGET)).toBe(NEXT)
    expect(tempsFor(TARGET)).toEqual([])
  })

  it('★ flushes before renaming', async () => {
    // Without the fsync the rename can be durable while the data is still in
    // cache — an intact-looking file full of zeros after a power loss.
    const { writeFileAtomic } = await import('../../src/main/lib/atomic-write')
    await writeFileAtomic(TARGET, NEXT)
    expect(syncCalls).toBe(1)
  })

  it('writes the temp file as a SIBLING (rename is only atomic within a volume)', async () => {
    const { writeFileAtomic } = await import('../../src/main/lib/atomic-write')
    let sawSibling = false
    const original = disk.set.bind(disk)
    // Observe the first key created that is not the target.
    const spy = vi.spyOn(disk, 'set').mockImplementation((k: string, v: string) => {
      if (k !== TARGET && k.startsWith('C:/work/')) sawSibling = true
      return original(k, v)
    })
    await writeFileAtomic(TARGET, NEXT)
    spy.mockRestore()
    expect(sawSibling).toBe(true)
  })
})

describe('REQ-0545 §1-2 — ★ the original survives every failure', () => {
  for (const stage of ['open', 'write', 'sync'] as const) {
    it(`fails at ${stage} → the destination is byte-identical and untouched`, async () => {
      const { writeFileAtomic } = await import('../../src/main/lib/atomic-write')
      failOn = stage
      await expect(writeFileAtomic(TARGET, NEXT)).rejects.toThrow()
      expect(disk.get(TARGET)).toBe(ORIGINAL)
      expect(tempsFor(TARGET)).toEqual([])
    })
  }

  it('fails at rename (both attempts) → the destination is untouched', async () => {
    const { writeFileAtomic } = await import('../../src/main/lib/atomic-write')
    failOn = 'rename'; renameFailures = 99
    await expect(writeFileAtomic(TARGET, NEXT)).rejects.toThrow()
    expect(disk.get(TARGET)).toBe(ORIGINAL)
    expect(tempsFor(TARGET)).toEqual([])
  })

  it('★ NEGATIVE CONTROL: the pre-fix direct write corrupts under the same fault', async () => {
    // Same disk, same injected ENOSPC. If this passed too, the test above would
    // be proving nothing about the change.
    const { promises: fsp } = await import('fs')
    failOn = 'write'
    await expect(fsp.writeFile(TARGET, NEXT, 'utf-8')).rejects.toThrow()
    expect(disk.get(TARGET)).not.toBe(ORIGINAL)
    expect(disk.get(TARGET)!.length).toBeLessThan(NEXT.length)
  })
})

describe('REQ-0545 §1-3 — the Windows rename retry', () => {
  it('one transient EPERM is retried and the write succeeds', async () => {
    const { writeFileAtomic } = await import('../../src/main/lib/atomic-write')
    failOn = 'rename'; renameFailures = 1
    await writeFileAtomic(TARGET, NEXT)
    expect(disk.get(TARGET)).toBe(NEXT)
    expect(renameCalls).toBe(2)
  })

  it('★ a persistent failure throws — it never falls back to a direct write', async () => {
    // The direct write is the unsafe operation this function exists to avoid. A
    // safe write that silently becomes unsafe under load is worse than none,
    // because the caller cannot tell which one they got.
    const { writeFileAtomic } = await import('../../src/main/lib/atomic-write')
    failOn = 'rename'; renameFailures = 99
    await expect(writeFileAtomic(TARGET, NEXT)).rejects.toThrow()
    expect(renameCalls).toBe(2)          // tried exactly twice, then gave up
    expect(disk.get(TARGET)).toBe(ORIGINAL)
  })
})

describe('REQ-0545 §1-2 — leftovers are cleaned on the next write of the same file', () => {
  it('removes stale temps for this destination, and touches nothing else', async () => {
    const { writeFileAtomic } = await import('../../src/main/lib/atomic-write')
    disk.set(TARGET + '.tmp-999-1', 'leftover from a crashed run')
    disk.set('C:/work/notes.txt', 'an unrelated file')
    disk.set('C:/work/other.mojioko', 'another project')
    await writeFileAtomic(TARGET, NEXT)
    expect(tempsFor(TARGET)).toEqual([])
    expect(disk.get('C:/work/notes.txt')).toBe('an unrelated file')
    expect(disk.get('C:/work/other.mojioko')).toBe('another project')
  })
})

/**
 * REQ-0545 §2 (RES-0543 A1) — a failed settings save must be visible, and must
 * not bury itself.
 *
 * The save is debounced off every store mutation, so a persistent cause would
 * otherwise raise a toast per keystroke. What is pinned here is the suppression
 * rule: report the first of each cause, stay quiet on repeats, and speak again
 * once the situation changes.
 */
describe('REQ-0545 §2 — reporting a failed settings save', () => {
  it('reports the first failure', async () => {
    const { createSettingsSaveReporter } = await import('../../src/renderer/lib/settings-save-failure')
    const seen: string[] = []
    const r = createSettingsSaveReporter((reason) => seen.push(reason))
    r.failed('ENOSPC')
    expect(seen).toEqual(['ENOSPC'])
  })

  it('★ stays quiet while the SAME cause repeats', async () => {
    const { createSettingsSaveReporter } = await import('../../src/renderer/lib/settings-save-failure')
    const seen: string[] = []
    const r = createSettingsSaveReporter((reason) => seen.push(reason))
    for (let i = 0; i < 50; i++) r.failed('ENOSPC')
    expect(seen).toEqual(['ENOSPC'])
  })

  it('a DIFFERENT cause is always reported', async () => {
    const { createSettingsSaveReporter } = await import('../../src/renderer/lib/settings-save-failure')
    const seen: string[] = []
    const r = createSettingsSaveReporter((reason) => seen.push(reason))
    r.failed('ENOSPC'); r.failed('ENOSPC'); r.failed('EPERM'); r.failed('EPERM')
    expect(seen).toEqual(['ENOSPC', 'EPERM'])
  })

  it('★ a success clears the suppression, so a recurrence is reported again', async () => {
    const { createSettingsSaveReporter } = await import('../../src/renderer/lib/settings-save-failure')
    const seen: string[] = []
    const r = createSettingsSaveReporter((reason) => seen.push(reason))
    r.failed('ENOSPC')
    r.succeeded()
    r.failed('ENOSPC')
    expect(seen).toEqual(['ENOSPC', 'ENOSPC'])
  })

  it('an empty reason is still reported — "we do not know why" is information', async () => {
    const { createSettingsSaveReporter } = await import('../../src/renderer/lib/settings-save-failure')
    const seen: string[] = []
    const r = createSettingsSaveReporter((reason) => seen.push(reason))
    r.failed('')
    expect(seen).toEqual(['unknown'])
  })

  it('App.tsx no longer swallows the failure', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const src = readFileSync(resolve(__dirname, '../../src/renderer/App.tsx'), 'utf-8')
    expect(src).not.toContain('saveSettings(settings).catch(() => { /* ignore IPC failures */ })')
    expect(src).toContain('settingsSaveReporter.failed')
    expect(src).toContain('settingsSaveReporter.succeeded')
  })
})
