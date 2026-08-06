import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * REQ-0437 — regression guard for the transcription setup drawer's tab layout.
 *
 * タブ2 (文字スタイル) / タブ3 (Whisper設定) have regressed to "bottom-aligned +
 * horizontal scroll" THREE times (RES-0424 / RES-0425, then again). The durable
 * fix (REQ-0437) is a PER-TAB scroll layout: each `<TabsContent>` is its own
 * `flex-1 min-h-0 overflow-y-auto overflow-x-hidden` scroll box, so a tab's
 * content lays out from the top inside its own box and can never be
 * bottom-weighted by another tab, and horizontal scroll is clipped.
 *
 * This test greps the SOURCE (not a render) to pin that shape.  If a future
 * edit reintroduces the fragile patterns, CI fails here instead of the UI
 * silently regressing a fourth time.  If you deliberately change the layout,
 * update this test in the SAME commit and say why.
 */
/** Strip block + line comments so "do NOT use X" checks match real code, not
 *  a comment that names the retired pattern.  Good enough for these TSX files
 *  (className strings never contain `/*`, and their `/` never doubles up). */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

const DRAWER = readFileSync(
  resolve(__dirname, '../../src/renderer/components/step1/transcription-drawer.tsx'),
  'utf-8',
)
const DRAWER_CODE = stripComments(DRAWER)
const WHISPER_CODE = stripComments(
  readFileSync(
    resolve(__dirname, '../../src/renderer/components/whisper-advanced-controls/whisper-advanced-controls.tsx'),
    'utf-8',
  ),
)

describe('REQ-0437 — transcription drawer tab layout guard', () => {
  it('renders exactly three setup tabs', () => {
    const tabs = DRAWER.match(/<TabsContent\b/g) ?? []
    expect(tabs.length).toBe(3)
  })

  it('every tab is its own vertical scroll box (per-tab scroll)', () => {
    // One `flex-1 min-h-0 overflow-y-auto` per tab so each fills + scrolls on
    // its own; a shared wrapper is what let one tab bottom-weight another.
    const perTab = DRAWER.match(/flex-1 min-h-0 overflow-y-auto/g) ?? []
    expect(perTab.length).toBeGreaterThanOrEqual(3)
  })

  it('every tab clips horizontal overflow (no h-scrollbar)', () => {
    const clipX = DRAWER.match(/overflow-x-hidden/g) ?? []
    expect(clipX.length).toBeGreaterThanOrEqual(3)
  })

  it('does NOT use min-h-full (the fragile percentage trick that regressed)', () => {
    expect(DRAWER_CODE).not.toContain('min-h-full')
  })

  it('does NOT reintroduce a shared scroll container with a scroll-reset ref', () => {
    expect(DRAWER_CODE).not.toContain('scrollRef')
  })

  it('the Whisper controls do NOT reintroduce the -mx-2 bleed (h-scroll source)', () => {
    expect(WHISPER_CODE).not.toContain('-mx-2')
  })
})
