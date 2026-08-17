/**
 * REQ-0521 §2-4 — the subtitle-list "how to use" copy must describe the
 * implementation, in the same spirit as `timeline-help-copy-req-0520`.
 *
 * The valuable assertion here is the SECOND describe block. The list's
 * "what is not shown" claim is not free prose: `RowStylePreview` drops those
 * fields through a **typed** `PreviewOverride`, so the set of dropped fields is
 * declared in one place in the source. This test reads that type back out of the
 * source file and requires the copy to mention every field in it.
 *
 * That means adding a field to `PreviewOverride` — i.e. deciding the list should
 * stop reflecting something — fails this test until the help text is updated.
 * It is the coupling that stops the list's help from going stale the way the
 * timeline's had (REQ-0520 found two invented button labels there).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'
import ja from '../../src/renderer/locales/ja/step2.json'
import en from '../../src/renderer/locales/en/step2.json'

type Dict = Record<string, unknown>
const read = (obj: unknown, dotted: string): unknown =>
  dotted.split('.').reduce<unknown>((o, k) => (o as Dict | undefined)?.[k], obj)

const LOCALES = { ja, en } as const
const SECTIONS = ['bulk', 'preview'] as const

const src = (rel: string) => readFileSync(path.resolve(__dirname, '../../', rel), 'utf-8')
const TABLE_SRC = src('src/renderer/components/subtitle-table/subtitle-table.tsx')
const PREVIEW_SRC = src('src/renderer/components/subtitle-table/row-style-preview.tsx')

describe('REQ-0521 §1/§2 — the list help exists, is rendered, and replaced the labels', () => {
  for (const name of Object.keys(LOCALES) as Array<keyof typeof LOCALES>) {
    it.each(SECTIONS)(`${name} defines table.help.%s title + body`, (section) => {
      for (const field of ['title', 'body']) {
        const v = read(LOCALES[name], `table.help.${section}.${field}`)
        expect(typeof v, `${name} ${section}.${field}`).toBe('string')
        expect(String(v).trim().length).toBeGreaterThan(0)
      }
    })
  }

  it('the header renders the help popover and no longer renders the two labels', () => {
    expect(TABLE_SRC).toContain('table.help.button')
    for (const section of SECTIONS) {
      expect(TABLE_SRC, `table.help.${section} is defined but not rendered`)
        .toContain(`table.help.${section}.title`)
    }
    // §1-1 — 「時間」/「テキスト」 are gone from the header.
    expect(TABLE_SRC, 'the header still renders colTime').not.toContain('table.colTime')
    expect(TABLE_SRC, 'the header still renders colText').not.toContain('table.colText')
    // §1-5 — the select-all checkbox is why the header ROW survives at all.
    expect(TABLE_SRC, 'the select-all checkbox was lost with the labels')
      .toContain('table.selectAllAria')
  })

  it('§1-3 — both help popovers are the SAME component, not two implementations', () => {
    const timeline = src('src/renderer/components/timeline-view/timeline-view.tsx')
    for (const [label, source] of [['table', TABLE_SRC], ['timeline', timeline]] as const) {
      expect(source, `${label} does not use the shared HelpPopover`).toContain('<HelpPopover')
      // A second Radix popover assembled locally is exactly what §1-3 forbids.
      expect(source, `${label} builds its own PopoverContent again`)
        .not.toContain('<PopoverContent')
    }
  })
})

describe('REQ-0521 §2-2 — the "not reflected" copy is tied to PreviewOverride', () => {
  /**
   * The fields `RowStylePreview` overrides away, read from the `PreviewOverride`
   * type in the source rather than restated here — so this test tracks the
   * implementation instead of a copy of it that someone forgets to update.
   */
  const overriddenFields = (): string[] => {
    const m = /type PreviewOverride = Pick<\s*SubtitleEntry,\s*([\s\S]*?)>/.exec(PREVIEW_SRC)
    if (!m) throw new Error('PreviewOverride not found — update this reader or the type name')
    return [...m[1].matchAll(/'([A-Za-z]+)'/g)].map((x) => x[1])
  }

  /**
   * Which human-readable phrase must be present for each dropped field. Grouped
   * because the copy names concepts ("position and margins"), not field names.
   */
  const PHRASE: Record<string, { ja: string; en: string }> = {
    verticalPosition: { ja: '位置', en: 'position' },
    verticalMarginPx: { ja: '余白', en: 'margin' },
    posX: { ja: '位置', en: 'position' },
    posY: { ja: '位置', en: 'position' },
    karaokeEnabled: { ja: 'カラオケ', en: 'karaoke' },
    emphasisScalePercent: { ja: '強調の拡大', en: 'emphasis scale' },
    rotation: { ja: '回転', en: 'rotation' },
  }

  it('every field PreviewOverride drops is named in the copy (both locales)', () => {
    const fields = overriddenFields()
    // Guard the reader itself: if the regex silently matched nothing, the loop
    // below would pass vacuously.
    expect(fields.length, 'PreviewOverride parsed as empty').toBeGreaterThanOrEqual(7)
    for (const f of fields) {
      const phrase = PHRASE[f]
      expect(phrase, `PreviewOverride gained "${f}" — add it to PHRASE and to the help copy`).toBeDefined()
      for (const name of ['ja', 'en'] as const) {
        const body = String(read(LOCALES[name], 'table.help.preview.body')).toLowerCase()
        expect(body.includes(phrase[name].toLowerCase()), `${name} copy never mentions ${f} ("${phrase[name]}")`).toBe(true)
      }
    }
  })

  it('the two things dropped OUTSIDE PreviewOverride are named too', () => {
    // Font size is not in `PreviewOverride`: the preview replaces it via
    // shrink-to-fit (a 16px ceiling down to an 8px floor, then an ellipsis), so
    // the authored size is not reflected either. Animation is settled because
    // the row never passes `initialAnimTransform` and no rAF loop drives it.
    for (const name of ['ja', 'en'] as const) {
      const body = String(read(LOCALES[name], 'table.help.preview.body')).toLowerCase()
      const size = name === 'ja' ? '文字サイズ' : 'font size'
      const anim = name === 'ja' ? 'アニメーション' : 'animation'
      expect(body).toContain(size)
      expect(body).toContain(anim)
    }
  })

  it('the copy does not claim the list preview is faithful in every respect', () => {
    for (const name of ['ja', 'en'] as const) {
      const body = String(read(LOCALES[name], 'table.help.preview.body'))
      const wrong = name === 'ja'
        ? ['見た目はすべて反映', 'そのまま再現されます']
        : ['shows every', 'exactly as it will look']
      for (const w of wrong) expect(body.includes(w), `${name} overclaims: "${w}"`).toBe(false)
    }
  })
})

describe('REQ-0521 §2-1 — the bulk-edit copy matches the history model', () => {
  it('bulk edits really are one history op per control', () => {
    const bulk = src('src/renderer/components/subtitle-table/bulk-edit-bar.tsx')
    // One `push` per applied control, snapshotting every selected row — which is
    // what makes "one undo, however many rows" true.
    expect(bulk).toContain('useHistoryStore.getState().push({')
    // The copy claims "Ctrl+Z does not clear your selection". The bar DOES have
    // a clear-selection button, so the identifier's mere presence proves
    // nothing — what matters is that clearing is only ever a click handler and
    // never wired into the apply/undo path. Every reference must therefore be
    // either the store binding or an `onClick`; anything else (a call inside
    // `apply` / `revert`) makes the copy false and fails here.
    const refs = bulk
      .split('\n')
      .filter((l) => l.includes('clearRowSelection'))
      .map((l) => l.trim())
    expect(refs.length, 'clearRowSelection vanished — re-check what clears the selection now')
      .toBeGreaterThan(0)
    for (const line of refs) {
      const isStoreBinding = /const clearRowSelection = useUiStore\(/.test(line)
      const isClickHandler = /^onClick=\{clearRowSelection\}$/.test(line)
      expect(
        isStoreBinding || isClickHandler,
        `clearRowSelection is used somewhere other than a click handler ("${line}") — if apply or undo now clears the selection, table.help.bulk.body is wrong`,
      ).toBe(true)
    }
  })

  it('both locales mention Ctrl+Z explicitly', () => {
    for (const name of ['ja', 'en'] as const) {
      expect(String(read(LOCALES[name], 'table.help.bulk.body'))).toContain('Ctrl+Z')
    }
  })
})

describe('REQ-0521 §3-2 — the orphaned keys are gone', () => {
  it.each(['ja', 'en'] as const)('%s no longer defines the retired keys', (name) => {
    for (const dotted of [
      'timeline.toolbar.tools',
      'timeline.toolbar.toolsTooltipExpand',
      'timeline.toolbar.toolsTooltipCollapse',
      'timeline.help.zoom',
      'timeline.help.scissor',
      'timeline.help.singleRow',
    ]) {
      expect(read(LOCALES[name], dotted), `${name} still defines ${dotted}`).toBeUndefined()
    }
  })
})
