/**
 * REQ-0355 §2 — bundled-font WEIGHT gate.
 *
 *   npm run verify:font-weights
 *
 * Exits non-zero when two weights a user can select render identically.  This
 * is a gate, not a report: run it after any change to `fonts.css`, to a font's
 * `bundled` flag in `src/shared/fonts.ts`, or to `font-registry.ts`'s loading
 * path.
 *
 * ## The invariant
 *
 *   **Every selectable weight must be drawable as itself.**
 *
 * Not "is it offered in the picker" — that is what the REQ-0353 unit gates
 * already pin, and it is not the same property.
 *
 * ## Why `document.fonts.check()` cannot be the test (REQ-0355 §2-2)
 *
 * `check('900 16px "MOJIOKO Noto Sans JP"')` returns **true even when no 900
 * face exists**.  It answers "will some face of this family be used for this
 * request", and CSS font matching guarantees that answer is yes as long as the
 * family has any face at all — a missing weight falls back to a neighbour
 * rather than failing.  `document.fonts.load()` resolves for the same reason.
 * Both are captured below as diagnostics and neither is a pass/fail input.
 *
 * The only way to see the difference is to DRAW and measure. A face that fell
 * back produces its neighbour's advance width, exactly.
 *
 * ## The bug this was built from (REQ-0353 → found in REQ-0354)
 *
 * `font-registry.ts::loadOne` returns early for any `bundled` font, on the
 * assumption that `fonts.css` declares it.  REQ-0269 shipped six Noto weights
 * as DOWNLOADS (registered at runtime with an explicit `weight` descriptor, so
 * they were correct), and `fonts.css` only ever declared 400/500/600.  REQ-0353
 * then bundled those six to open weight selection in the free edition, which
 * moved them onto the early return with no `@font-face` behind it.  Nine
 * selectable weights collapsed to three distinct faces: 100/200/300 drew as
 * 400, and 700/800/900 as 600 — in the preview only, because the burn-in path
 * resolves a per-weight `assFontName` against the real TTF and stayed correct.
 * A preview that silently disagrees with the export is the failure mode here.
 *
 * ## Derived from the registry, never hardcoded (REQ-0355 §2-2)
 *
 * The weight list comes from `src/shared/fonts.ts` itself (bundled via esbuild,
 * already present as a Vite dependency — no new package).  Add a tenth weight,
 * or a second bundled family, and it is covered on the next run without
 * touching this file.  Fonts are grouped by `cssFontFamily` because that plus
 * the numeric weight is what CSS actually matches on.
 *
 * ## What is measured against what
 *
 * `fonts.css` is read from source and only its `url('/fonts/…')` roots are
 * rewritten to absolute file: URLs — the same mapping the shipped app gets from
 * Vite's `publicDir: resources`.  The declarations themselves are untouched, so
 * a weight missing from the real file is missing here.  Reading the source
 * rather than `out/` keeps the gate runnable without a build.
 *
 * ## Negative control (how to prove the gate still works)
 *
 *   FONT_WEIGHTS_BREAK=900             npm run verify:font-weights
 *   FONT_WEIGHTS_BREAK=100,200,300,700,800,900 npm run verify:font-weights
 *
 * Drops those `@font-face` blocks from the copy under test.  Both MUST fail.
 * The first is the minimal case (900 collapses onto its neighbour); the second
 * reproduces the REQ-0353 defect exactly as shipped — nine weights, three
 * faces.  If either passes, the gate has stopped testing anything: fix it
 * before trusting a green run.  Any declared weight works as an argument.
 */
import { spawnSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'fs'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '../..')
const ELECTRON = path.join(REPO, 'node_modules/electron/dist/electron.exe')
const FONTS_CSS = path.join(REPO, 'src/renderer/styles/fonts.css')
const PUBLIC_DIR = path.join(REPO, 'resources')
const WORK = path.join(HERE, '.work')

/** Sample text: CJK + Latin, so a family is exercised across both scripts. */
const SAMPLE = 'あア亜Ag永'
const SIZE_PX = 100

const BREAK = process.env.FONT_WEIGHTS_BREAK ?? ''

function fail(msg) {
  console.error(`\n✗ ${msg}`)
  process.exit(1)
}

/**
 * Splits out `@font-face { … }` blocks by counting braces.
 *
 * A `[^}]*` regex would be shorter but breaks the moment a comment inside a
 * block contains a brace, and one of these blocks already carries a long
 * explanatory comment.
 */
function fontFaceBlocks(css) {
  const blocks = []
  const re = /@font-face\s*\{/g
  let m
  while ((m = re.exec(css))) {
    let depth = 1
    let i = re.lastIndex
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth++
      else if (css[i] === '}') depth--
      i++
    }
    blocks.push({ start: m.index, end: i, text: css.slice(m.index, i) })
    re.lastIndex = i
  }
  return blocks
}

/** Loads the real font registry by bundling the TypeScript source. */
async function loadRegistry() {
  const esbuild = await import('esbuild')
  const outfile = path.join(WORK, 'fonts.bundle.mjs')
  const res = await esbuild.build({
    entryPoints: [path.join(REPO, 'src/shared/fonts.ts')],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    outfile,
    logLevel: 'silent'
  })
  if (res.errors?.length) fail(`could not bundle src/shared/fonts.ts:\n${JSON.stringify(res.errors)}`)
  return import(pathToFileURL(outfile).href)
}

if (!existsSync(ELECTRON)) fail(`electron binary not found at ${ELECTRON} — run npm install`)

rmSync(WORK, { recursive: true, force: true })
mkdirSync(WORK, { recursive: true })

const { FONT_REGISTRY } = await loadRegistry()
if (!Array.isArray(FONT_REGISTRY) || FONT_REGISTRY.length === 0) {
  fail('FONT_REGISTRY came back empty — the registry import is broken, not the fonts')
}

// Every bundled font is in scope: bundled is precisely the set `loadOne` skips
// on the assumption fonts.css covers it, so it is the set that assumption can
// be wrong about.  Downloaded fonts register their own weight explicitly.
const bundled = FONT_REGISTRY.filter((m) => m.bundled)
const byFamily = new Map()
for (const m of bundled) {
  const list = byFamily.get(m.cssFontFamily) ?? []
  list.push({ id: m.id, weight: m.weight })
  byFamily.set(m.cssFontFamily, list)
}
const families = [...byFamily.entries()]
  .map(([family, weights]) => ({ family, weights: weights.sort((a, b) => a.weight - b.weight) }))
  .filter((f) => f.weights.length > 1) // one weight is trivially distinct

if (families.length === 0) fail('no bundled family has more than one weight — nothing to check')

// --- stage the CSS -------------------------------------------------------
let css = readFileSync(FONTS_CSS, 'utf8')

if (BREAK) {
  const wanted = BREAK.split(',').map((s) => s.trim()).filter(Boolean)
  const target = fontFaceBlocks(css).filter((b) =>
    wanted.some((w) => new RegExp(`font-weight:\\s*${w}\\s*;`).test(b.text))
  )
  if (target.length === 0) {
    fail(`FONT_WEIGHTS_BREAK=${BREAK} matched no @font-face — nothing would be broken, so a pass would be meaningless`)
  }
  for (const b of [...target].reverse()) css = css.slice(0, b.start) + css.slice(b.end)
  console.log(`[negative control] removed ${target.length} @font-face block(s): weight ${wanted.join(', ')}`)
}

const declaredWeights = new Set(
  fontFaceBlocks(css)
    .map((b) => b.text.match(/font-weight:\s*(\d+)\s*;/)?.[1])
    .filter(Boolean)
    .map(Number)
)

// Rewrite the publicDir-rooted URLs to absolute file: URLs.  Declarations are
// otherwise untouched.
const publicUrl = pathToFileURL(PUBLIC_DIR).href
css = css.replace(/url\((['"]?)\/(?=[^)'"])/g, (_m, q) => `url(${q}${publicUrl}/`)

writeFileSync(path.join(WORK, 'fonts.css'), css, 'utf8')
copyFileSync(path.join(HERE, 'page.html'), path.join(WORK, 'page.html'))

// --- measure -------------------------------------------------------------
const job = { workDir: WORK, families, sample: SAMPLE, sizePx: SIZE_PX }
const jobPath = path.join(WORK, 'job.json')
const outJson = path.join(WORK, 'out.json')
writeFileSync(jobPath, JSON.stringify(job), 'utf8')

const run = spawnSync(ELECTRON, [path.join(HERE, 'electron-main.cjs'), jobPath, outJson], {
  cwd: REPO,
  encoding: 'utf8',
  timeout: 120_000
})
if (!existsSync(outJson)) {
  fail(`electron produced no result (status=${run.status})\n${run.stderr ?? ''}`)
}
const result = JSON.parse(readFileSync(outJson, 'utf8'))
if (result.error) fail(`electron error: ${result.error}`)

// --- verdict -------------------------------------------------------------
let failures = 0

for (const fam of result.families) {
  console.log(`\n${fam.family}`)
  console.log(`  faces registered: ${fam.faces.length} — ${fam.faces.map((f) => f.weight).join(', ') || '(none)'}`)
  console.log(`  sample "${SAMPLE}" at ${SIZE_PX}px\n`)
  console.log('    weight  advance    id                        declared  check')

  const byWidth = new Map()
  for (const r of fam.rows) {
    const dup = byWidth.get(r.width)
    if (dup === undefined) byWidth.set(r.width, r.weight)
    const declared = declaredWeights.has(r.weight)
    const note = dup !== undefined ? `  <-- IDENTICAL to ${dup}` : ''
    console.log(
      `    ${String(r.weight).padStart(6)}  ${String(r.width).padStart(7)}    ${r.id.padEnd(24)}  ${
        declared ? 'yes' : 'NO '
      }       ${String(r.check).padEnd(5)}${note}`
    )
  }

  const distinct = byWidth.size
  const expected = fam.rows.length
  console.log(`\n  distinct advance widths: ${distinct} / ${expected}`)

  if (distinct !== expected) {
    failures++
    const collapsed = fam.rows.filter((r) => !declaredWeights.has(r.weight)).map((r) => r.weight)
    console.error(
      `  ✗ ${expected - distinct} selectable weight(s) render identically to another.` +
        (collapsed.length
          ? `\n    Undeclared in fonts.css: ${collapsed.join(', ')} — add an @font-face for each.`
          : `\n    All weights ARE declared, so the cause is elsewhere (wrong file in a src url,\n    or two declarations pointing at the same TTF).`)
    )
  }

  // A weight whose face is missing can also be caught by ordering: heavier
  // must not draw narrower than lighter.  This is a second, independent
  // signal — it catches a declaration pointing at the WRONG file, which the
  // distinctness count alone would pass.
  const outOfOrder = []
  for (let i = 1; i < fam.rows.length; i++) {
    if (fam.rows[i].width < fam.rows[i - 1].width) {
      outOfOrder.push(`${fam.rows[i - 1].weight}(${fam.rows[i - 1].width}) > ${fam.rows[i].weight}(${fam.rows[i].width})`)
    }
  }
  if (outOfOrder.length) {
    failures++
    console.error(`  ✗ heavier weights draw narrower than lighter ones: ${outOfOrder.join(', ')}`)
    console.error('    Likely a src url pointing at the wrong TTF.')
  }
}

if (failures > 0) {
  console.error(`\n✗ verify:font-weights FAILED (${failures} problem(s))`)
  process.exit(1)
}

console.log('\n✓ every selectable weight renders distinctly')
process.exit(0)
