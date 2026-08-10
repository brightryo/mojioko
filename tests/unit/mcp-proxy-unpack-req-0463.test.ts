import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { resolveMcpProxyPath, MCP_PROXY_REL_PATH } from '../../src/main/mcp/proxy-path'
import { LAUNCH_SPEC_REVISION } from '../../src/shared/mcp'

/**
 * REQ-0463 — the MCP clean-stdout proxy must be executable in a packaged build.
 * A script inside `app.asar` cannot be run as a plain Node entry point
 * (ELECTRON_RUN_AS_NODE), so the packaging configs `asarUnpack` it and the
 * launch spec must point at `app.asar.unpacked`.  These tests pin BOTH halves so
 * a config edit and the path derivation cannot silently drift back.
 */

const norm = (p: string) => p.replace(/\\/g, '/')

describe('REQ-0463 — resolveMcpProxyPath', () => {
  it('dev: points at the build output directly (no asar)', () => {
    const p = norm(resolveMcpProxyPath('/repo/mojioko', false))
    expect(p.endsWith('out/main/mcp-proxy.js')).toBe(true)
    expect(p).not.toContain('app.asar')
    expect(p.startsWith('/repo/mojioko')).toBe(true)
  })

  it('packaged (asar on): points at app.asar.unpacked, not inside the archive', () => {
    const p = norm(resolveMcpProxyPath('/app/resources/app.asar', true))
    expect(p).toBe('/app/resources/app.asar.unpacked/out/main/mcp-proxy.js')
    // Never the in-archive path (that is the bug this REQ fixes).
    expect(p).not.toMatch(/app\.asar\/out\/main\/mcp-proxy\.js$/)
  })

  it('packaged with a Windows-style app path resolves to .unpacked', () => {
    const p = norm(resolveMcpProxyPath('C:\\Program Files\\MOJIOKO\\resources\\app.asar', true))
    expect(p).toBe('C:/Program Files/MOJIOKO/resources/app.asar.unpacked/out/main/mcp-proxy.js')
  })

  it('packaged with asar DISABLED (no app.asar suffix): falls back to appDir, no .unpacked', () => {
    const p = norm(resolveMcpProxyPath('/app/resources/app', true))
    expect(p).toBe('/app/resources/app/out/main/mcp-proxy.js')
    expect(p).not.toContain('.unpacked')
  })

  it('the relative path constant is the canonical build-output location', () => {
    expect(MCP_PROXY_REL_PATH).toBe('out/main/mcp-proxy.js')
  })
})

describe('REQ-0463 — packaging configs unpack the proxy (config ↔ launch path alignment)', () => {
  // All three ship the same runtime layout, so all three must unpack the proxy.
  const CONFIGS = [
    'electron-builder.yml',
    'electron-builder-appx.yml',
    'electron-builder-appx-store.yml',
  ]

  for (const cfg of CONFIGS) {
    it(`${cfg} asarUnpacks the proxy AND its chunks dir`, () => {
      const text = readFileSync(resolve(process.cwd(), cfg), 'utf-8')
      // The block exists.
      expect(text).toMatch(/^asarUnpack:/m)
      // The proxy path the launch spec resolves to (minus the app.asar.unpacked
      // prefix) is exactly what gets unpacked — this is the drift guard.
      expect(text).toContain(`"${MCP_PROXY_REL_PATH}"`)
      // The shared chunk the proxy require()s (hash-named, so a glob) is unpacked
      // to the same relative tree.
      expect(text).toContain('"out/main/chunks/**"')
    })
  }
})

describe('REQ-0463 — launch-spec revision bumped so rev-1 bundles read as stale', () => {
  it('LAUNCH_SPEC_REVISION advanced past 1 (packaged args[0] path scheme changed)', () => {
    // The packaged proxy path moved from inside app.asar to app.asar.unpacked,
    // i.e. args[0] differs for every packaged bundle → REQ-0458 mandates a bump.
    expect(LAUNCH_SPEC_REVISION).toBeGreaterThanOrEqual(2)
  })
})
