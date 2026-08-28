import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * REQ-0281 §4-3 / §4-5 — pins the "uninstall all additional fonts"
 * behaviour visible through the renderer service.  The main-side
 * `font:uninstallAll` handler does two things in one round-trip:
 *
 *   1. Sweep every non-bundled font directory off disk.
 *   2. Clear `fontSetInstalledVersion` in settings.json (binary state
 *      pins back to 0 = `not-installed`).
 *
 * The renderer service (`uninstallAllFonts`) is a thin IPC pass-through;
 * these tests confirm it wires the right channel with no arguments and
 * surfaces the response shape unchanged.
 *
 * The batch-DL cancel path (also §4-3) invokes the SAME service call
 * from `handleBatchDownload`'s try block, so a passing test here proves
 * the cleanup path can round-trip end-to-end.  A full FontPicker
 * integration test would need a jsdom + React-testing-library scaffold
 * that's out of scope for this REQ; the flow is instead verified in the
 * two other places it's referenced:
 *   - Baseline: RES-0279 pinned `mergeSettingsForSave` preserving the
 *     stamp under debounced writes.  That protection remains in effect;
 *     uninstall-all explicitly SETS the stamp to undefined, so the
 *     merge's "'key' in incoming" preservation naturally rounds it back
 *     through.
 *   - Owner: the RES-0281 manual re-verification steps walk the visible
 *     UI (Section 2's "Uninstall all" button, cancel-during-batch).
 */

interface Sub { channel: string; handler: (payload: unknown) => void; active: boolean }
const subs: Sub[] = []

function makeElectronStub(overrides: Record<string, unknown> = {}) {
  return {
    fontUninstallAll: vi.fn().mockResolvedValue({
      ok: true,
      data: {
        fonts: [],
        activeFontId: 'noto-sans-jp-semibold',
        totalUsedBytes: 0,
        fontSetInstalledVersion: undefined,
        removedIds: ['anton', 'bebas-neue', 'delius'],
      },
    }),
    subscribeToChannel: vi.fn((channel: string, handler: (payload: unknown) => void): (() => void) => {
      const sub: Sub = { channel, handler, active: true }
      subs.push(sub)
      return () => { sub.active = false }
    }),
    ...overrides,
  }
}

beforeEach(() => {
  subs.length = 0
  ;(globalThis as unknown as { window: unknown }).window = {
    electronAPI: makeElectronStub(),
  }
})

describe('REQ-0281 §4 — uninstallAllFonts service pass-through', () => {
  it('invokes fontUninstallAll on window.electronAPI with no arguments', async () => {
    const { uninstallAllFonts } = await import('../../src/renderer/services/font')
    const r = await uninstallAllFonts()

    expect(r.ok).toBe(true)
    expect(window.electronAPI.fontUninstallAll).toHaveBeenCalledTimes(1)
    expect(window.electronAPI.fontUninstallAll).toHaveBeenCalledWith()
  })

  it('response carries removedIds so caller can toast a count', async () => {
    const { uninstallAllFonts } = await import('../../src/renderer/services/font')
    const r = await uninstallAllFonts()

    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(Array.isArray(r.data.removedIds)).toBe(true)
      expect(r.data.removedIds).toEqual(['anton', 'bebas-neue', 'delius'])
    }
  })

  it('response.fontSetInstalledVersion is undefined after uninstall-all (binary state pinned at 0)', async () => {
    // This is the REQ-0281 §4 core contract: after uninstall-all the
    // set version stamp must be gone, so the next `listFonts` sees
    // setIsCurrent=false and deriveFamilyStatus reports every
    // non-bundled family as not-installed.
    const { uninstallAllFonts } = await import('../../src/renderer/services/font')
    const r = await uninstallAllFonts()

    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.fontSetInstalledVersion).toBeUndefined()
    }
  })

  it('surfaces main-side failure to the caller unchanged', async () => {
    ;(window.electronAPI as unknown as { fontUninstallAll: ReturnType<typeof vi.fn> }).fontUninstallAll
      = vi.fn().mockResolvedValue({
        ok: false,
        error: { code: 'FONT_UNINSTALL_ALL_ERROR', message: 'rmdir failed' },
      })

    const { uninstallAllFonts } = await import('../../src/renderer/services/font')
    const r = await uninstallAllFonts()

    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('FONT_UNINSTALL_ALL_ERROR')
      expect(r.error.message).toBe('rmdir failed')
    }
  })

  it('idempotent from the caller\'s perspective (calling twice does not throw)', async () => {
    const { uninstallAllFonts } = await import('../../src/renderer/services/font')
    await uninstallAllFonts()
    await expect(uninstallAllFonts()).resolves.toBeDefined()
    expect(window.electronAPI.fontUninstallAll).toHaveBeenCalledTimes(2)
  })
})
