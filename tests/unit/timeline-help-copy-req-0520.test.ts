/**
 * REQ-0520 — the timeline "how to use" copy must describe the implementation.
 *
 * This is not a prose test. It pins the couplings that made the OLD copy lie,
 * every one of which was found by reading the implementation in REQ-0520 §1:
 *
 *   - It told the user to press 「トリミング」 to commit a trim. The button has
 *     been labelled 「実行」 / "Run" since REQ-20260614-001 補遺⑩; 「トリミング」
 *     is the group label next to it.
 *   - It told the user to press 「クリア」 / "Clear" to drop pending points. No
 *     such button exists — the control is icon-only (`<X/>`) and its accessible
 *     name is 「始点・終点を一括解除」 / "Clear In and Out".
 *   - It said rows appear when subtitles overlap IN TIME, and that the preview
 *     shows only the first row while the burn-in stacks them. That described the
 *     pre-REQ-0394 model; rows became the stored z-order `layer` in
 *     REQ-0394/0396/0402, and depend on `layer` alone, not on time.
 *
 * So the assertions below are: (a) both locales define every rendered key,
 * (b) the component renders exactly the keys that exist, and (c) the copy names
 * the buttons using the SAME i18n strings the buttons themselves use — so
 * renaming a button fails this test instead of silently making the help lie.
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
/** The four sections REQ-0520 settled on, in render order. */
const SECTIONS = ['scope', 'trim', 'snap', 'layers'] as const

const SOURCE = readFileSync(
  path.resolve(__dirname, '../../src/renderer/components/timeline-view/timeline-view.tsx'),
  'utf-8',
)

describe('REQ-0520 §2 — the four help sections exist in both locales', () => {
  for (const name of Object.keys(LOCALES) as Array<keyof typeof LOCALES>) {
    it.each(SECTIONS)(`${name} defines timeline.help.%s title + body`, (section) => {
      for (const field of ['title', 'body']) {
        const v = read(LOCALES[name], `timeline.help.${section}.${field}`)
        expect(typeof v, `${name} ${section}.${field}`).toBe('string')
        expect(String(v).trim().length, `${name} ${section}.${field} is empty`).toBeGreaterThan(0)
      }
    })
  }

  it('the component renders exactly these four sections', () => {
    for (const section of SECTIONS) {
      expect(SOURCE, `timeline.help.${section} is defined but never rendered`)
        .toContain(`timeline.help.${section}.title`)
      expect(SOURCE).toContain(`timeline.help.${section}.body`)
    }
    // Zoom lost its cell in REQ-0520 (the [−][slider][+] cluster needs no
    // prose), and the scissor text folded into `trim`. Their keys are retained
    // as orphan-removal candidates for the owner, so assert the COMPONENT
    // stopped rendering them rather than that the keys are gone.
    for (const dropped of ['zoom', 'scissor', 'singleRow']) {
      expect(SOURCE, `timeline.help.${dropped} should no longer be rendered`)
        .not.toContain(`timeline.help.${dropped}.`)
    }
  })
})

describe('REQ-0520 §1-1/§1-2 — the copy names the real buttons', () => {
  // If someone renames a button, these fail — which is the point. The help text
  // must not be the last place still using an old label.
  it.each(['ja', 'en'] as const)('%s trim copy uses the actual In / Out / Run labels', (name) => {
    const body = String(read(LOCALES[name], 'timeline.help.trim.body'))
    for (const labelKey of ['setIn', 'setOut', 'confirmCutRun']) {
      const label = String(read(LOCALES[name], `timeline.trim.${labelKey}`))
      expect(body, `${name} trim body does not mention the ${labelKey} button ("${label}")`)
        .toContain(label)
    }
  })

  it.each(['ja', 'en'] as const)('%s trim copy does not resurrect the stale labels', (name) => {
    const body = String(read(LOCALES[name], 'timeline.help.trim.body'))
    // The pre-REQ-0520 copy told the user to press a "Clear" button that has
    // never existed, and named the group label as the commit button.
    const stale = name === 'ja' ? ['「クリア」', '「トリミング」を押す'] : ['press Clear', 'press Trim']
    for (const s of stale) {
      expect(body.includes(s), `${name} trim body reintroduces the stale "${s}"`).toBe(false)
    }
  })
})

describe('REQ-0520 §1-3/§1-4 — the layer copy matches the model, and claims no parity', () => {
  it.each(['ja', 'en'] as const)('%s does not claim rows come from time overlap', (name) => {
    const body = String(read(LOCALES[name], 'timeline.help.layers.body'))
    // Rows are the stored z-order `layer` (REQ-0402); `layoutEntries` derives a
    // row from `layer` alone. Copy asserting time-driven stacking would be false.
    const wrong = name === 'ja'
      ? ['時間的に重なるとタイムラインで二行目']
      : ['the timeline stacks them into a second row']
    for (const w of wrong) {
      expect(body.includes(w), `${name} layers body claims time-driven stacking`).toBe(false)
    }
  })

  it.each(['ja', 'en'] as const)('%s help never promises preview == exported video', (name) => {
    // REQ-0520 §1-4: `dev-docs/specs/positioning-redesign.md` is status:draft and
    // explicitly un-implemented — vertical position still has two authorities
    // (libass `fix_collisions` for plain cues vs MOJIOKO's own `\pos`), and the
    // preview MIMICS libass via `computeFixedStackOffsets`. The app itself shows
    // 「※ 近似表示です」/ "Approximate preview" above this very timeline, so a
    // parity promise here would contradict the same screen.
    const help = read(LOCALES[name], 'timeline.help') as Dict
    const all = JSON.stringify(help)
    const promises = name === 'ja'
      ? ['プレビューと同じ', '書き出しても同じ', 'プレビューどおり', '見え方が一致します']
      : ['matches the exported', 'identical to the export', 'exactly as previewed']
    for (const p of promises) {
      expect(all.includes(p), `${name} help promises preview/export parity ("${p}")`).toBe(false)
    }
  })
})
