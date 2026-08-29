#!/usr/bin/env node
/**
 * scripts/verify-site-claims/index.mjs — wording gate for the public site.
 *
 * REQ-0580 §2-3 (promoted from the one-off audit in RES-0578 §3-2 /
 * RES-0569 §1-4 / RES-0567 §5).  CLAUDE.md §18 追記2: a check re-run every
 * release belongs in scripts/, not a scratchpad.
 *
 * ## What it enforces
 *
 * The privacy / download pages make broad "everything happens on your PC /
 * nothing is sent externally" claims.  Those became only PARTLY true once AI
 * integration (MCP) shipped in v1.4.0 — with AI integration on, the subtitle
 * TEXT is sent to the assistant's provider.  A broad claim is honest only if
 * the SAME SECTION carries the AI/MCP qualifier.  This gate fails (non-zero
 * exit) if any broad claim appears in a section that has no qualifier.
 *
 * ## Why "section", not "line window"
 *
 * The window is each `<h2>`-delimited section, not a fixed number of lines:
 * re-wrapping or editing a paragraph must not turn a correct page red.
 *
 * ## Modes
 *
 *   (default)   Read the LOCAL docs/ HTML — usable as a pre-push gate,
 *               before the change is published.
 *   --remote    Fetch the PUBLISHED pages over HTTPS — the post-publish
 *               re-verification (needs network).
 *
 * Exit 0 = every broad claim is qualified in its own section. Exit 1 = a
 * violation or (in --remote) a non-200 page.
 */
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const REMOTE = process.argv.includes('--remote')
const BASE = 'https://brightryo.github.io/mojioko'

// page route -> local file under docs/
const PAGES = [
  { route: '/', file: 'docs/index.html' },
  { route: '/en/', file: 'docs/en/index.html' },
  { route: '/privacy/', file: 'docs/privacy/index.html' },
  { route: '/en/privacy/', file: 'docs/en/privacy/index.html' },
]

// Broad "all local / nothing sent" claims that need a qualifier in-section.
//
// These target the LOCALITY claim (user content stays on the PC / is not sent),
// which AI integration qualifies.  A generic no-collection statement such as
// "does not collect personal information from children" is NOT such a claim and
// must not be caught (REQ-0580 §2-3): so the send/upload alternatives require an
// object that means data leaving the machine, not a bare verb.
const BROAD = [
  /すべての処理[^。<]*(この PC|ローカル|お使いの PC)/,
  /全ての処理[^。<]*(この PC|ローカル)/,
  /外部[^。<]*送信[^。<]*(しません|されません)/,
  /all processing[^.<]*(your own PC|locally|your PC)/i,
  /everything happens on your PC/i,
  /(does not|never) (send|upload)s?[^.<]{0,60}(external|server|leaves?|your (video|audio|data|subtitle|file|content))/i,
  /never leaves? (this|your) (PC|computer)/i,
  /none of it is sent externally/i,
  /entirely on your/i,
  /runs? locally/i,
]

// Qualifiers that make a broad claim honest.
const QUAL = [/AI 連携/, /MCP/i, /AI integration/i, /ai-mcp/, /2\.5/]

const stripTags = (s) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()

async function loadPage(page) {
  if (REMOTE) {
    const res = await fetch(BASE + page.route)
    if (!res.ok) return { ok: false, status: res.status }
    return { ok: true, html: await res.text() }
  }
  return { ok: true, html: readFileSync(resolve(REPO, page.file), 'utf8') }
}

let bad = 0
const rows = []

for (const page of PAGES) {
  const loaded = await loadPage(page)
  if (!loaded.ok) {
    console.error(`FETCH ${loaded.status} ${page.route}`)
    process.exit(1)
  }
  // Split into sections at every <h2>. Index 0 is everything before the first.
  const parts = loaded.html.split(/(?=<h2)/i)
  const notes = []
  for (const [i, part] of parts.entries()) {
    const text = stripTags(part)
    for (const re of BROAD) {
      const m = text.match(re)
      if (!m) continue
      const qualified = QUAL.some((q) => q.test(part) || q.test(text))
      const claim = m[0].slice(0, 60)
      if (qualified) {
        notes.push(`ok   §${i} "${claim}" — qualified in the same section`)
      } else {
        notes.push(`FAIL §${i} "${claim}" — NO AI/MCP qualifier in this section`)
        bad++
      }
      break // one report per section is enough
    }
  }
  rows.push({ label: REMOTE ? BASE + page.route : page.file, notes })
}

for (const { label, notes } of rows) {
  console.log(`${bad === 0 ? 'clean' : '     '}   ${label}`)
  for (const n of notes) console.log(`          ${n}`)
}
console.log()
if (bad === 0) {
  console.log(`site-claims: CLEAN — every broad claim is qualified in its own section (${REMOTE ? 'remote' : 'local'})`)
  process.exit(0)
}
console.log(`site-claims: FAILED — ${bad} unqualified broad claim(s)`)
process.exit(1)
