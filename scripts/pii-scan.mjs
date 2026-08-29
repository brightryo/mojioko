#!/usr/bin/env node
/**
 * scripts/pii-scan.mjs — local PII tripwire (REQ-20260615-047 Phase 3).
 *
 * Three layers of defence, evaluated in order:
 *
 *   1. INTERNAL_DOC_PATHS — `CLAUDE.md` / `dev-docs/` must never appear
 *      among tracked-or-staged files.  Path check; no content read.
 *      Also a ROOT-LEVEL `*.md` ALLOWLIST: only the public docs
 *      (README / CHANGELOG / PRIVACY / LICENSE, with `_JA` variants) may
 *      be tracked at the repo root — any *other* new root `.md` is an
 *      instant block, because that is the shape a stray internal report
 *      (`report.md`, RES-0579 §2-3 A) takes.  Allow-listing names is the
 *      point: we cannot enumerate every bad name, so we enumerate the
 *      good ones and block the rest.
 *
 *   2. GENERIC_PATTERNS — regexes that catch common PII shapes
 *      (email addresses, `C:\Users\<name>\`, `D:\dev`, credential
 *      assignments such as `password:`/`certificatePassword:`) so the
 *      tripwire works on a fresh clone with no dictionary yet.  The path
 *      regexes match the ESCAPED source form (`C:\\Users\\x`) as well as
 *      the raw form — TS/JS/YAML on disk carry doubled backslashes, and
 *      matching only the raw form (RES-0579 §3-4 hole 2) is why real
 *      usernames slipped through a green gate.  Well-known placeholder
 *      usernames (`user`/`test`/`me`/`x`/`someone`/…) and the bare
 *      project path `D:\dev\mojioko` (owner-accepted, RES-0579 F) are
 *      exempted so fixtures stay green; a *real* username is not.
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
 *   - `src/renderer/locales/`, `build/license_*` (deliberate brand
 *     mentions / UI strings).
 *   - `scripts/pii-scan.mjs` and `scripts/hooks/` ONLY (this scanner and
 *     the hooks reference the patterns literally; running the rules
 *     against the rules is a self-hit).  The REST of `scripts/` and all
 *     of `docs/` are NOT excluded any more (RES-0579 §3-4 hole 1): they
 *     are shipped code / the public site, exactly where a leak matters,
 *     and blanket-excluding them is how `scripts/shots/index.mjs`'s dev
 *     paths reached origin.  Brand false-positives are absorbed by
 *     ALLOWED_TOKENS, not by excluding the directory.
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

// Root-level *.md allowlist (Layer 1, second half).  Only these public
// documents may be tracked at the repo root.  Any *other* root `.md`
// (e.g. a stray `report.md`) is an instant block — we enumerate the
// allowed names and reject the rest, rather than trying to name every
// bad file.  `_JA` variants included.  Nested `.md` (under src/, docs/,
// python-sidecar/, …) is out of scope here — this is about the root,
// which is where internal reports have historically landed.
const ROOT_MD_ALLOWLIST = new Set([
  'README.md',
  'README_JA.md',
  'CHANGELOG.md',
  'CHANGELOG_JA.md',
  'PRIVACY.md',
  'PRIVACY_JA.md',
  'LICENSE.md',
  'SECURITY.md',
  'CONTRIBUTING.md',
  'CODE_OF_CONDUCT.md',
])

function isDisallowedRootMd(path) {
  // Root level == no slash in the (already forward-slashed) path.
  if (path.includes('/')) return false
  if (!/\.md$/i.test(path)) return false
  return !ROOT_MD_ALLOWLIST.has(path)
}

// ---------------------------------------------------------------------------
// Layer 2: generic patterns (work without a local dictionary).
// `exemptions` are regexes that, if they match the same substring,
// downgrade the hit to "not PII".  Kept narrow.
// ---------------------------------------------------------------------------
// Conventional placeholder usernames.  A `C:\Users\<name>` whose name is
// one of these is a fixture, not a person, and is exempted.  A real
// username (`MyPC`, `brightryo`) is NOT here, so it is caught.  New test
// fixtures must use one of these names (or add one here deliberately) —
// that is the gate, spelled as an allowlist.
const PLACEHOLDER_USERS =
  '(?:user|users|public|default|all|test|testuser|me|you|someone|somebody|example|sample|demo|x|foo|bar|baz|name|username|admin|runneradmin)'

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
    // `[\\/]+` matches the escaped source form `C:\\Users\\x` (two literal
    // backslashes on disk) as well as the raw `C:\Users\x` and POSIX-y
    // `C:/Users/x`.  Matching only the raw form was RES-0579 hole 2.
    name: 'C:\\Users\\<name>',
    regex: /C:[\\/]+Users[\\/]+\w+/g,
    exemptions: [
      new RegExp(`^C:[\\\\/]+Users[\\\\/]+${PLACEHOLDER_USERS}$`, 'i'),
    ],
  },
  {
    name: 'D:\\dev personal path',
    regex: /D:[\\/]+dev(?:[\\/]+\w+)?/g,
    // `D:\dev\mojioko` (drive + project name, no username) is owner-accepted
    // as non-identifying — RES-0579 F.  It stays in test fixtures by owner
    // decision (REQ-0580 §1-4), so the gate exempts exactly that path and
    // still catches any other `D:\dev\<something>`.
    exemptions: [
      /^D:[\\/]+dev[\\/]+mojioko$/i,
      /^D:[\\/]+dev$/i,
    ],
  },
  {
    // Credential assignments — `password: x`, `certificatePassword: x`,
    // `api_key = "x"`.  Quotes optional (YAML routinely omits them); this
    // is why `certificatePassword: mojioko-dev` (RES-0579 B) went undetected
    // for months — there was no credential pattern at all (hole 3).
    name: 'credential assignment',
    regex:
      /\b(?:password|passphrase|secret|api[_-]?key|access[_-]?token|client[_-]?secret|certificate[_-]?password)\b\s*[:=]\s*['"]?[^\s'"#,;)]{3,}/gi,
    exemptions: [
      // Type annotations / literals that are not secrets.
      /[:=]\s*['"]?(?:string|number|boolean|bool|null|undefined|any|unknown|true|false|void|Record|Array|Promise|object)\b/i,
      // References / expressions rather than an inline literal value.
      /[:=]\s*['"]?(?:process\.env|import\b|require\(|config\b|opts\b|options\b|this\.|env\b|args\b|argv\b|\$\{|\{)/i,
    ],
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
  /^build\/license_/,
  // Only the scanner itself and the hooks — NOT all of scripts/ or docs/
  // (RES-0579 §3-4 hole 1).  These reference the patterns literally.
  /^scripts\/pii-scan\.mjs$/,
  /^scripts\/hooks\//,
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

    // Layer 1 (second half): a root-level *.md that is not on the public
    // allowlist is an instant block — the shape a stray internal report takes.
    if (isDisallowedRootMd(path)) {
      hits.push({ file: path, line: 0, token: '[non-allowlisted root .md]' })
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
