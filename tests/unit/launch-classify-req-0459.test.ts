import { describe, it, expect } from 'vitest'
import { classifyProjectOpen, CLI_COMMANDS } from '../../src/main/cli/launch-classify'

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
