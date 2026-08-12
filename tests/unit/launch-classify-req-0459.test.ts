import { describe, it, expect } from 'vitest'
import { classifyProjectOpen, secondInstanceProjectFile, CLI_COMMANDS } from '../../src/main/cli/launch-classify'

/**
 * REQ-0459 §1 — the dispatcher must NOT mistake a `.mojioko` double-click for a
 * CLI command (which would exit USAGE and never open the GUI), while keeping
 * every real CLI command + the unknown-token USAGE path intact.
 */
const existsAll = () => true
const existsNone = () => false

describe('REQ-0459 — classifyProjectOpen', () => {
  it('an existing .mojioko path ⇒ open it (GUI launch)', () => {
    expect(classifyProjectOpen(['C:/videos/my project.mojioko'], existsAll)).toBe('C:/videos/my project.mojioko')
    expect(classifyProjectOpen(['out.mojioko'], existsAll)).toBe('out.mojioko')
    // Case-insensitive extension (Windows).
    expect(classifyProjectOpen(['OUT.MOJIOKO'], existsAll)).toBe('OUT.MOJIOKO')
  })

  it('a .mojioko path that does NOT exist ⇒ not a project-open (falls through to CLI/USAGE)', () => {
    expect(classifyProjectOpen(['ghost.mojioko'], existsNone)).toBeNull()
  })

  it('every known CLI command ⇒ CLI (never a project-open), even if a same-named file exists', () => {
    for (const cmd of CLI_COMMANDS) {
      expect(classifyProjectOpen([cmd], existsAll)).toBeNull()
    }
  })

  it('help tokens / --version / flags ⇒ CLI', () => {
    for (const t of ['help', '-h', '--help', '--version', '--json', '-o']) {
      expect(classifyProjectOpen([t], existsAll)).toBeNull()
    }
  })

  it('an unknown non-file token ⇒ CLI (preserves the USAGE error path)', () => {
    expect(classifyProjectOpen(['frobnicate'], existsAll)).toBeNull()
    expect(classifyProjectOpen(['input.mp4'], existsAll)).toBeNull() // not a .mojioko
  })

  it('no tokens ⇒ plain GUI launch (null)', () => {
    expect(classifyProjectOpen([], existsAll)).toBeNull()
  })

  it('the .mojioko must be the FIRST token (a command with a trailing path stays CLI)', () => {
    expect(classifyProjectOpen(['burn', 'in.mojioko'], existsAll)).toBeNull()
  })
})

/**
 * REQ-0484 (C3) — a warm-start double-click (app already running) forwards its
 * argv through Electron's `second-instance` event, but Electron PREPENDS its own
 * Chromium switches (observed live: `--allow-file-access-from-files`) and, in dev,
 * the entry-script token, BEFORE the `.mojioko` path.  `classifyProjectOpen` only
 * inspects tokens[0], so it saw the leading `-`switch and returned null — the
 * open silently no-opped (window only got focus).  `secondInstanceProjectFile`
 * must scan past the launcher noise.  These argv shapes are the REAL ones logged
 * by the isolated two-process harness (see RES-0484 §1).
 */
describe('REQ-0484 — secondInstanceProjectFile (warm-start double-click)', () => {
  // The exact argv the primary received in the harness, minus argv[0] (exe).
  const DEV_ARGV = ['--allow-file-access-from-files', 'C:/dev/out/main/index.js', 'C:/videos/warm.mojioko']
  const PACKAGED_ARGV = ['--allow-file-access-from-files', 'C:/videos/warm.mojioko']

  it('finds the .mojioko even when Chromium switches + the dev script precede it (the C3 fix)', () => {
    expect(secondInstanceProjectFile(DEV_ARGV, existsAll)).toBe('C:/videos/warm.mojioko')
    expect(secondInstanceProjectFile(PACKAGED_ARGV, existsAll)).toBe('C:/videos/warm.mojioko')
  })

  it('negative control: the OLD head-only classifier misses the path in that same argv', () => {
    // Proves the bug — classifyProjectOpen returns null because tokens[0] is a
    // `-`switch, which is exactly why the warm-start open used to no-op.
    expect(classifyProjectOpen(DEV_ARGV, existsAll)).toBeNull()
    expect(classifyProjectOpen(PACKAGED_ARGV, existsAll)).toBeNull()
  })

  it('a non-existent .mojioko in the argv ⇒ null (do not open a ghost path)', () => {
    expect(secondInstanceProjectFile(DEV_ARGV, existsNone)).toBeNull()
  })

  it('no .mojioko among the switches ⇒ null (plain second launch, just focus)', () => {
    expect(secondInstanceProjectFile(['--allow-file-access-from-files', 'C:/dev/out/main/index.js'], existsAll)).toBeNull()
    expect(secondInstanceProjectFile([], existsAll)).toBeNull()
  })

  it('case-insensitive extension is still matched past the switches', () => {
    expect(secondInstanceProjectFile(['--some-switch', 'C:/videos/WARM.MOJIOKO'], existsAll)).toBe('C:/videos/WARM.MOJIOKO')
  })
})
