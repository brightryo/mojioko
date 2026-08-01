/**
 * REQ-0360 — landing-page layout gate.
 *
 * Renders `docs/index.html` and `docs/en/index.html` at phone / tablet /
 * desktop widths and FAILS (non-zero exit) if either page scrolls
 * horizontally, has an element poking outside the viewport, or throws a
 * JS error.  This is a gate, not a report.
 *
 * Why this is tracked rather than deleted with the rest of the REQ-0360
 * scratch work (CLAUDE.md §18 "残す対象（追記2）"): the test is "next time
 * we add a section to the landing page, would we write this again?"  We
 * would — the top page has been restructured repeatedly (REQ-0111 /
 * REQ-0113 / REQ-0254 / REQ-0267 / REQ-0348 / REQ-0357 / REQ-0358 /
 * REQ-0360) and a phone-width overflow is invisible on the developer's
 * 1440px monitor.  The two prior incidents recorded in §18 were both
 * "the artefact survived but the tool that produced/protected it was
 * deleted"; this avoids repeating that.
 *
 * Usage:  npm run verify:docs-layout
 *         npm run verify:docs-layout -- <dir>   (also writes screenshots)
 *
 * Note: the pages are opened over file:// so the placeholder <img>s 404
 * and their onerror handlers swap in `.screenshot-placeholder` boxes —
 * which is exactly the state we want to measure, since a missing asset
 * is the layout's worst case.
 */
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const shotDir = process.argv[2]

const PAGES = [
  ['ja', path.join(REPO, 'docs', 'index.html')],
  ['en', path.join(REPO, 'docs', 'en', 'index.html')],
]

/** 320 is the narrowest phone still worth supporting (iPhone SE 1st gen). */
const VIEWPORTS = [
  ['phone-320', 320, 720],
  ['phone-375', 375, 812],
  ['phone-414', 414, 896],
  ['tablet-768', 768, 1024],
  ['desktop-1280', 1280, 900],
]

const browser = await chromium.launch()
let failures = 0

for (const [lang, file] of PAGES) {
  const url = pathToFileURL(file).href
  for (const [label, width, height] of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: { width, height } })
    const page = await ctx.newPage()
    const jsErrors = []
    page.on('pageerror', (e) => jsErrors.push(String(e)))

    await page.goto(url, { waitUntil: 'load' })
    // Give the onerror placeholder swaps a beat to settle.
    await page.waitForTimeout(600)

    const result = await page.evaluate(() => {
      const de = document.documentElement
      const vw = de.clientWidth
      const overflowers = []
      for (const el of document.querySelectorAll('body *')) {
        const r = el.getBoundingClientRect()
        if (r.width === 0 && r.height === 0) continue
        // 1px tolerance absorbs sub-pixel rounding.
        if (r.right > vw + 1 || r.left < -1) {
          const cls =
            typeof el.className === 'string' ? el.className.split(' ')[0] : ''
          overflowers.push(
            `${el.tagName.toLowerCase()}${cls ? '.' + cls : ''} ` +
              `left=${Math.round(r.left)} right=${Math.round(r.right)} (vw=${vw})`,
          )
        }
      }
      return {
        scrollWidth: de.scrollWidth,
        clientWidth: de.clientWidth,
        overflowers: overflowers.slice(0, 8),
      }
    })

    const scrolls = result.scrollWidth > result.clientWidth + 1
    const ok = !scrolls && result.overflowers.length === 0 && jsErrors.length === 0
    if (!ok) failures++

    console.log(
      `${ok ? 'OK  ' : 'FAIL'} ${lang} ${label.padEnd(13)}` +
        ` scrollW=${result.scrollWidth} clientW=${result.clientWidth}` +
        (result.overflowers.length
          ? `\n       OVERFLOW: ${result.overflowers.join('\n                 ')}`
          : '') +
        (jsErrors.length ? `\n       JS ERROR: ${jsErrors.join('; ')}` : ''),
    )

    if (shotDir && (label === 'phone-375' || label === 'desktop-1280')) {
      await page.screenshot({
        path: path.join(shotDir, `${lang}-${label}.png`),
        fullPage: true,
      })
    }
    await ctx.close()
  }
}

await browser.close()

if (failures > 0) {
  console.error(`\n${failures} viewport(s) FAILED`)
  process.exit(1)
}
console.log('\nAll viewports clean.')
