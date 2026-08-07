import { describe, it, expect } from 'vitest'
import {
  evaluateLaunchStaleness,
  mcpManifestVersion,
  LAUNCH_SPEC_REVISION,
  MCP_REEXPORT_REMEDY,
} from '../../src/shared/mcp'

/**
 * REQ-0458 §2 — the stale-bundle verdict from the launch-spec-revision env value.
 */
describe('REQ-0458 — evaluateLaunchStaleness', () => {
  it('current revision ⇒ not stale, no remedy', () => {
    const r = evaluateLaunchStaleness(String(LAUNCH_SPEC_REVISION))
    expect(r.stale).toBe(false)
    expect(r.launchedRevision).toBe(LAUNCH_SPEC_REVISION)
    expect(r.expectedRevision).toBe(LAUNCH_SPEC_REVISION)
    expect(r.remedy).toBeNull()
  })

  it('an OLDER revision ⇒ stale + remedy', () => {
    const r = evaluateLaunchStaleness(String(LAUNCH_SPEC_REVISION - 1))
    expect(r.stale).toBe(true)
    expect(r.launchedRevision).toBe(LAUNCH_SPEC_REVISION - 1)
    expect(r.remedy).toBe(MCP_REEXPORT_REMEDY)
  })

  it('a NEWER revision ⇒ stale (bundle from a different app)', () => {
    const r = evaluateLaunchStaleness(String(LAUNCH_SPEC_REVISION + 5))
    expect(r.stale).toBe(true)
  })

  it('undefined (launched directly, not via a bundle) ⇒ not stale, launchedRevision null', () => {
    const r = evaluateLaunchStaleness(undefined)
    expect(r.stale).toBe(false)
    expect(r.launchedRevision).toBeNull()
    expect(r.remedy).toBeNull()
  })

  it('a non-numeric value ⇒ stale (cannot confirm it matches)', () => {
    const r = evaluateLaunchStaleness('garbage')
    expect(r.stale).toBe(true)
    expect(r.launchedRevision).toBeNull()
  })

  it('manifest version encodes app + launch-spec revision as SemVer build metadata', () => {
    expect(mcpManifestVersion('1.4.0')).toBe(`1.4.0+lsr.${LAUNCH_SPEC_REVISION}`)
  })
})
