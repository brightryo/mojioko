#!/usr/bin/env node
/**
 * scripts/audit-public/index.mjs — public-history leak gate.
 *
 * REQ-0580 §2-3 (promoted from the one-off audit in RES-0579).  Answers one
 * question deterministically and fails (non-zero exit) if the answer is wrong:
 *
 *   "Does any internal development doc reach a PUBLISHED ref?"
 *
 * ## Scope — PUBLISHED refs only, resolved from the remote
 *
 * The audit set is what `git ls-remote origin` reports (heads + tags), NOT the
 * local branches.  RES-0579 §1-1: `git log --all` would report never-pushed
 * local branches as if they were public.  Objects are enumerated with
 * `git rev-list --objects` over those refs — that lists every tree/blob with
 * its path, which `git log --name-only` silently under-reports across merges.
 * If the network is unavailable we fall back to the local `refs/remotes/origin`
 * + `refs/tags` mirror and say so (a fetched clone still reflects the remote).
 *
 * ## What is forbidden
 *
 * Internal development resources (CLAUDE.md, dev-docs/, .claude/, the PII
 * dictionary, REQ-/RES- reports) that CLAUDE.md §13 / §17 keep out of the
 * public repo.  These are PATH checks — the strong signal RES-0579 relied on.
 * Deep per-blob CONTENT scanning of the full history (5,616 blobs) is a heavier
 * manual audit, not this routine gate; `npm run scan:pii -- --history` covers
 * the working-tree/pickaxe angle.
 *
 * ## Owner-accepted history (REQ-0580 A = option b)
 *
 * A stray root `report.md` DOES linger in published history (RES-0579 §2-3 A).
 * The owner chose to NEUTRALISE it via the CHANGELOG font-license note rather
 * than rewrite published history.  So it is on the ACCEPTED allowlist below and
 * does NOT fail the gate — but ANY OTHER internal-doc path (a NEW leak) does.
 * `test-results/.last-run.json` is accepted too (RES-0579 judged it zero-info).
 */
import { execFileSync } from 'node:child_process'
import process from 'node:process'

// Paths that are forbidden in published history (internal dev resources).
const FORBIDDEN = [
  /(^|\/)CLAUDE\.md$/,
  /(^|\/)dev-docs\//,
  /(^|\/)\.claude\//,
  /(^|\/)\.pii-blocklist$/,
  /(^|\/)(REQ|RES)-[0-9A-Za-z-]+\.md$/,
]

// Root-level *.md allowlist — same policy as scripts/pii-scan.mjs.  A root
// `.md` that is not a known public doc is the shape a stray internal report
// takes (RES-0579 §2-3 A was exactly `report.md`).
const ROOT_MD_ALLOWLIST = new Set([
  'README.md', 'README_JA.md',
  'CHANGELOG.md', 'CHANGELOG_JA.md',
  'PRIVACY.md', 'PRIVACY_JA.md',
  'LICENSE.md', 'SECURITY.md', 'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md',
])

function isForbidden(path) {
  if (FORBIDDEN.some((re) => re.test(path))) return true
  // A non-allowlisted root-level .md (no slash in the path).
  if (!path.includes('/') && /\.md$/i.test(path) && !ROOT_MD_ALLOWLIST.has(path)) return true
  return false
}

// Known historical paths the owner has explicitly accepted (REQ-0580 A = b).
// A forbidden-looking path that is ALSO here does not fail the gate.
const ACCEPTED = new Set([
  'report.md',
  'test-results/.last-run.json',
])

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
}

/** Published ref target SHAs, from the remote when reachable. */
function publishedShas() {
  try {
    const out = git(['ls-remote', 'origin'])
    const shas = new Set()
    for (const line of out.split(/\r?\n/).filter(Boolean)) {
      const [sha, ref] = line.split('\t')
      if (!sha || !ref) continue
      if (ref === 'HEAD') continue
      // peel annotated-tag `^{}` rows collapse to the same commit; keep both,
      // rev-list dedupes objects anyway.
      shas.add(sha)
    }
    return { shas: [...shas], source: 'git ls-remote origin' }
  } catch {
    // Offline fallback: local mirror of the remote.
    const out = git(['for-each-ref', '--format=%(objectname)', 'refs/remotes/origin', 'refs/tags'])
    return {
      shas: out.split(/\r?\n/).filter(Boolean),
      source: 'local refs/remotes/origin + refs/tags (OFFLINE fallback)',
    }
  }
}

const { shas, source } = publishedShas()
if (shas.length === 0) {
  console.error('audit:public: could not resolve any published refs')
  process.exit(1)
}

// Enumerate every object reachable from the published refs.  `--objects`
// prints `<sha>` for commits and `<sha> <path>` for trees/blobs — the path
// column is exactly what we check, so do NOT pass --no-object-names.
const objectsOut = git(['rev-list', '--objects', ...shas])

const seenPaths = new Set()
for (const line of objectsOut.split(/\r?\n/)) {
  const sp = line.indexOf(' ')
  const path = sp === -1 ? '' : line.slice(sp + 1).trim()
  if (path) seenPaths.add(path)
}

const hits = []
for (const path of seenPaths) {
  if (ACCEPTED.has(path)) continue
  if (isForbidden(path)) hits.push(path)
}

console.log(`audit:public: ${seenPaths.size} distinct published paths via ${source}`)
console.log(`audit:public: ${shas.length} published ref targets scanned`)

if (hits.length === 0) {
  console.log('audit:public: CLEAN — no internal development docs reach any published ref')
  console.log(`  (accepted historical paths, by owner decision REQ-0580 A=b: ${[...ACCEPTED].join(', ')})`)
  process.exit(0)
}

console.error(`audit:public: FAILED — ${hits.length} internal-doc path(s) in published history:`)
for (const h of hits.sort()) console.error(`  ${h}`)
console.error('\nAn internal development resource reached a published ref. If this is a')
console.error('deliberate, owner-accepted exception, add it to ACCEPTED in this file with a')
console.error('reference to the decision; otherwise it must be removed from the pushed refs.')
process.exit(1)
