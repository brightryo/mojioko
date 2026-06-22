#!/usr/bin/env node
/**
 * scripts/pii-scan.mjs — local PII tripwire (REQ-20260615-047 Phase 3).
 *
 * Three layers of defence, evaluated in order:
 *
 *   1. INTERNAL_DOC_PATHS — `CLAUDE.md` / `dev-docs/` must never appear
 *      among tracked-or-staged files.  Path check; no content read.
 *
 *   2. GENERIC_PATTERNS — regexes that catch common PII shapes
 *      (email addresses, `C:\Users\<name>\`, `D:\dev`, `D:/dev`)
 *      so the tripwire works on a fresh clone with no dictionary yet.
 *
 *   3. LOCAL DICTIONARY (`.pii-blocklist`) — owner-managed file with
 *      the actual blocklist words (real name, kana, personal account,
 *      contact strings).  Gitignored.  Plain `String.includes`,
 *      case-insensitive.  When the file is absent the layer is
 *      silently skipped — never a hard requirement.
 *
 * Modes (mutually exclusive):
 *
 *   --staged    Scan only the additions in the current Git staging area
 *               (`git diff --cached --name-only --diff-filter=AM`).
 *               Used by the pre-commit hook.
 *   --history   Scan every blob reachable from any ref via `git log -S`
 *               for each dictionary / generic-pattern token.  Slow,
 *               intended for manual audits / Phase 1-style verification.
 *   (default)   Scan every tracked file in the working tree
 *               (`git ls-files`).  Used by the pre-push hook and the
 *               `npm run scan:pii` developer command.
 *
 * Exit codes:
 *   0  no hits — caller proceeds.
 *   1  one or more hits — caller aborts.  Hit list written to stderr
 *      in `file:line  <-  matched-token` format so the reader can
 *      jump straight to the offending edit.
 *
 * Exclusions (paths NEVER scanned, even when the tracker lists them):
 *   - `node_modules/`, `resources/bin/`, `installer/licenses/`
 *     (bundled third-party content with verbatim author metadata).
 *   - `src/renderer/locales/`, `docs/`, `build/license_*` (deliberate
 *     brand mentions / UI strings).
 *   - `scripts/` itself (the scanner and hooks reference the patterns
 *     literally; running the rules against the rules creates infinite
 *     false-positives).
 *   - `package-lock.json` (npm metadata pollutes with author emails).
 *   - `.pii-blocklist`, `.git/` (the dictionary file and git internals).
 *
 * Brand allowlist:
 *   - `BrightRyo` — public brand mark per REQ-20260615-045.  Matches in
 *     dictionary scans are dropped before the hit list is emitted.
 *
 * No PII inside this file.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'

const ROOT = process.cwd()
const DICT_PATH = resolve(ROOT, '.pii-blocklist')

const args = new Set(process.argv.slice(2))
const MODE =
  args.has('--staged') ? 'staged'
  : args.has('--history') ? 'history'
  : 'working'

// ---------------------------------------------------------------------------
// Layer 1: paths that must never be tracked.
// ---------------------------------------------------------------------------
const INTERNAL_DOC_PATHS = [
  /^CLAUDE\.md$/,
  /^dev-docs\//,
]

// ---------------------------------------------------------------------------
// Layer 2: generic patterns (work without a local dictionary).
// `exemptions` are regexes that, if they match the same substring,
// downgrade the hit to "not PII".  Kept narrow.
// ---------------------------------------------------------------------------
const GENERIC_PATTERNS = [
  {
    name: 'email',
    regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    exemptions: [
      /noreply@(?:users\.)?github\.com$/i,
      /noreply@anthropic\.com$/i,
    ],
  },
  {
    name: 'C:\\Users\\<name>',
    regex: /C:[\\/]Users[\\/]\w+/g,
    exemptions: [
      /^C:[\\/]Users[\\/](?:user|Public|Default|All Users|All)$/i,
    ],
  },
  {
    name: 'D:\\dev personal path',
    regex: /D:[\\/]dev/g,
    exemptions: [],
  },
]

// ---------------------------------------------------------------------------
// Exclusions: paths that are deliberately allowed to contain PII-shaped
// content (verbatim third-party assets, deliberate brand mentions, the
// scanner / hooks themselves).  Tested before any other layer fires.
// ---------------------------------------------------------------------------
const EXCLUDED_PATH_PATTERNS = [
  /^node_modules\//,
  /^resources\/bin\//,
  /^installer\/licenses\//,
  /^src\/renderer\/locales\//,
  /^docs\//,
  /^build\/license_/,
  /^scripts\//,
  /^package-lock\.json$/,
  /^\.pii-blocklist$/,
  /^\.git\//,
  /^test-results\//,
  /^out\//,
  /^dist\//,
]

// ---------------------------------------------------------------------------
// Brand allowlist (case-insensitive token match).
// ---------------------------------------------------------------------------
const ALLOWED_TOKENS = new Set([
  'brightryo',
])

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isPathExcluded(path) {
  for (const re of EXCLUDED_PATH_PATTERNS) {
    if (re.test(path)) return true
  }
  return false
}

function loadDictionary() {
  if (!existsSync(DICT_PATH)) return []
  try {
    return readFileSync(DICT_PATH, 'utf8')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !s.startsWith('#'))
  } catch {
    return []
  }
}

function listFilesStaged() {
  try {
    const out = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=AM'], {
      encoding: 'utf8',
    })
    return out.split(/\r?\n/).filter(Boolean)
  } catch {
    return []
  }
}

function listFilesWorking() {
  try {
    const out = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
    return out.split(/\r?\n/).filter(Boolean)
  } catch {
    return []
  }
}

function readStagedContent(path) {
  try {
    return execFileSync('git', ['show', `:${path}`], { encoding: 'utf8' })
  } catch {
    return null
  }
}

function readWorkingContent(path) {
  try {
    const stat = statSync(path)
    if (!stat.isFile()) return null
    if (stat.size > 5 * 1024 * 1024) return null
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

// History mode is intentionally minimal: do not iterate all blobs (slow,
// and the rewrite is the proper response anyway).  Use `git log -S` per
// token across all refs; reports the commits that introduced/removed
// the token.  Caller is expected to be running an audit, not a hook.
function scanHistory(dict, generics) {
  const hits = []
  const tokens = [
    ...dict,
    ...generics.flatMap((g) => g.literal ? [g.literal] : []),
  ]
  // Always include the literal forms of generic patterns for pickaxe.
  const histLiterals = [
    'D:\\dev',
    'D:/dev',
    'C:\\Users\\',
  ]
  const all = Array.from(new Set([...tokens, ...histLiterals]))
  for (const token of all) {
    if (ALLOWED_TOKENS.has(token.toLowerCase())) continue
    try {
      const out = execFileSync(
        'git',
        ['log', '--all', '--oneline', `-S${token}`],
        { encoding: 'utf8' },
      )
      const lines = out.split(/\r?\n/).filter(Boolean)
      for (const line of lines) {
        hits.push({ file: `<history>`, line: 0, token, ref: line })
      }
    } catch {
      /* token not found is a non-zero exit on some setups — fine */
    }
  }
  return hits
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const dict = loadDictionary()
const hits = []

if (MODE === 'history') {
  hits.push(...scanHistory(dict, GENERIC_PATTERNS))
} else {
  const files = MODE === 'staged' ? listFilesStaged() : listFilesWorking()

  for (const rawPath of files) {
    const path = rawPath.replace(/\\/g, '/')

    // Layer 1: internal-doc paths are an instant block.
    for (const re of INTERNAL_DOC_PATHS) {
      if (re.test(path)) {
        hits.push({ file: path, line: 0, token: '[internal-doc-path]' })
      }
    }

    if (isPathExcluded(path)) continue

    const content =
      MODE === 'staged' ? readStagedContent(rawPath) : readWorkingContent(rawPath)
    if (content === null) continue

    const lines = content.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]

      // Layer 2: generic patterns with exemption check.
      for (const { name, regex, exemptions } of GENERIC_PATTERNS) {
        regex.lastIndex = 0
        let m
        while ((m = regex.exec(line)) !== null) {
          const match = m[0]
          let exempt = false
          for (const ex of exemptions) {
            if (ex.test(match)) {
              exempt = true
              break
            }
          }
          if (exempt) continue
          if (ALLOWED_TOKENS.has(match.toLowerCase())) continue
          hits.push({ file: path, line: i + 1, token: `${name}: ${match}` })
        }
      }

      // Layer 3: local dictionary.  Plain case-insensitive includes.
      const lower = line.toLowerCase()
      for (const word of dict) {
        if (!word) continue
        if (ALLOWED_TOKENS.has(word.toLowerCase())) continue
        if (lower.includes(word.toLowerCase())) {
          hits.push({ file: path, line: i + 1, token: word })
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

if (hits.length === 0) {
  const dictNote = dict.length === 0
    ? ' (dictionary absent — generic + path layers only)'
    : ` (${dict.length} dictionary words active)`
  process.stdout.write(`pii-scan: clean${dictNote}\n`)
  process.exit(0)
}

process.stderr.write(`pii-scan: ${hits.length} hit(s)\n`)
for (const h of hits) {
  if (h.ref) {
    process.stderr.write(`  ${h.ref}  <-  ${h.token}\n`)
  } else {
    process.stderr.write(`  ${h.file}:${h.line}  <-  ${h.token}\n`)
  }
}
process.stderr.write(
  '\nIf this is a false positive, add the path to EXCLUDED_PATH_PATTERNS\n' +
  'in scripts/pii-scan.mjs (no PII in the commit message).\n',
)
process.exit(1)
