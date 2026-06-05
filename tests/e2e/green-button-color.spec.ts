/**
 * REQ-071 Phase 3.8 — guard the rendered colour of green (primary) buttons.
 *
 * **Backstory.**  Phase 3.6 and 3.7 both reasoned from source class strings
 * that `variant="primary"` Buttons rendered `text-zinc-950` on
 * `bg-green-500`.  Two visual reviews from the owner disagreed.  An
 * empirical Playwright probe revealed that `cn()` (via `tailwind-merge`)
 * was silently stripping `text-zinc-950` because tailwind-merge did not
 * recognise our custom font-size tokens (`text-body`, `text-body-sm`,
 * etc.) — it bucketed them with text-color classes and the later one
 * (`text-body`, appended by the size variant) won.  Fix in
 * `src/renderer/lib/utils.ts`: extend tailwind-merge with the custom
 * font-size class group.
 *
 * **This spec** locks the contract: any primary-variant Button in the
 * footer must render `rgb(9, 9, 11)` (zinc-950) text on
 * `rgb(34, 197, 94)` (green-500) bg.  If a future migration breaks
 * tailwind-merge config again, the spec fails immediately.
 */
import { _electron as electron, test, expect } from '@playwright/test'
import path from 'path'

const ZINC_950 = 'rgb(9, 9, 11)'
const GREEN_500 = 'rgb(34, 197, 94)'

test('footer primary CTA renders zinc-950 on green-500', async () => {
  const electronApp = await electron.launch({
    args: [path.resolve(__dirname, '../../out/main/index.js')],
    timeout: 30_000
  })

  const window = await electronApp.firstWindow()
  await window.waitForSelector('button')

  const result = await window.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'))
    // The Step 1 footer carries the primary "Start transcription" CTA.
    // Identify primary buttons by their bg-green-500 computed background.
    const primaries = buttons.filter((b) => {
      const bg = getComputedStyle(b).backgroundColor
      return bg === 'rgb(34, 197, 94)'
    })
    return primaries.map((b) => {
      const cs = getComputedStyle(b)
      return {
        text: (b.textContent ?? '').trim().slice(0, 40),
        color: cs.color,
        backgroundColor: cs.backgroundColor,
        className: b.className
      }
    })
  })

  // eslint-disable-next-line no-console
  console.log('\n[3.8 probe] primary buttons:', JSON.stringify(result, null, 2), '\n')

  expect(result.length).toBeGreaterThan(0)
  for (const button of result) {
    expect(button.backgroundColor, `bg of "${button.text}"`).toBe(GREEN_500)
    expect(button.color, `text of "${button.text}"`).toBe(ZINC_950)
  }

  await electronApp.close()
})
