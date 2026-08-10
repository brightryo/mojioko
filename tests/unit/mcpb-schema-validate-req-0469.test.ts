import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeMcpbBundle, buildMcpbManifest } from '../../src/main/mcp/mcpb'

/**
 * REQ-0469 §2 — schema-validation GATE against the OFFICIAL mcpb CLI
 * (`@anthropic-ai/mcpb`, the same validator Claude Desktop uses), run over the
 * bundle the RUNTIME code actually produces — not a hand-written golden.
 *
 * REQ-0458 shipped a top-level `mojioko` key that is not in the MCPB v0.3
 * manifest schema, so Claude Desktop rejected the whole bundle ("Unrecognized
 * key(s) in object: 'mojioko'").  This gate fails the moment any non-schema key
 * reappears, wherever in the manifest builder it is added.
 */

// Minimal stored-ZIP reader (the bundle uses no compression) — pull manifest.json
// out of the REAL .mcpb so we validate the artifact end to end.
function extractManifest(zip: Buffer): string {
  let eocd = -1
  for (let i = zip.length - 22; i >= 0; i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('EOCD not found')
  const count = zip.readUInt16LE(eocd + 10)
  let cd = zip.readUInt32LE(eocd + 16)
  for (let e = 0; e < count; e++) {
    const compSize = zip.readUInt32LE(cd + 20)
    const nameLen = zip.readUInt16LE(cd + 28)
    const extraLen = zip.readUInt16LE(cd + 30)
    const commentLen = zip.readUInt16LE(cd + 32)
    const lho = zip.readUInt32LE(cd + 42)
    const name = zip.slice(cd + 46, cd + 46 + nameLen).toString('utf8')
    const lNameLen = zip.readUInt16LE(lho + 26)
    const lExtraLen = zip.readUInt16LE(lho + 28)
    const dataStart = lho + 30 + lNameLen + lExtraLen
    const data = zip.slice(dataStart, dataStart + compSize)
    if (name === 'manifest.json') return data.toString('utf8')
    cd += 46 + nameLen + extraLen + commentLen
  }
  throw new Error('manifest.json not found in bundle')
}

/** Run the official `mcpb validate <manifest>` and return {status, output}. */
function mcpbValidate(manifestPath: string): { status: number | null; out: string } {
  // `shell: true` so the local `mcpb` bin (.cmd on Windows) is found via npx,
  // mirroring `tests/unit/undo-restores-optional-fields-req-0352.test.ts`.
  const r = spawnSync(`npx mcpb validate "${manifestPath}"`, {
    cwd: join(__dirname, '..', '..'),
    encoding: 'utf8',
    shell: true,
  })
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

const EXE = 'C:\\Users\\me\\AppData\\Local\\Programs\\mojioko\\MOJIOKO.exe'
const PROXY = 'C:\\Users\\me\\AppData\\Local\\Programs\\mojioko\\resources\\app.asar.unpacked\\out\\main\\mcp-proxy.js'
const ENV = { ELECTRON_RUN_AS_NODE: '1', MOJIOKO_LAUNCH_SPEC_REV: '2' }
const TOOLS = [
  { name: 'status', description: 'status' },
  { name: 'burn', description: 'burn subtitles' },
]

describe('REQ-0469 §2 — .mcpb manifest passes the official mcpb schema validator', () => {
  it('the RUNTIME-generated bundle validates clean (no unrecognized keys)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpb-validate-'))
    try {
      const bundle = join(dir, 'mojioko.mcpb')
      writeMcpbBundle(bundle, EXE, [PROXY, 'mcp'], ENV, TOOLS)
      const manifestPath = join(dir, 'manifest.json')
      writeFileSync(manifestPath, extractManifest(readFileSync(bundle)), 'utf8')

      const { status, out } = mcpbValidate(manifestPath)
      expect(status, `mcpb validate should exit 0.\n${out}`).toBe(0)
      expect(out).not.toMatch(/Unrecognized key/i)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 120_000)

  it('NEGATIVE CONTROL — re-adding a non-schema key makes the validator fail', () => {
    // Prove the gate has teeth: inject the removed `mojioko` key back and confirm
    // the validator rejects it, so a future re-add cannot slip past this test.
    const dir = mkdtempSync(join(tmpdir(), 'mcpb-validate-neg-'))
    try {
      const m = buildMcpbManifest(EXE, [PROXY, 'mcp'], ENV, TOOLS) as Record<string, unknown>
      m.mojioko = { appVersion: '1.4.0', launchSpecRevision: 2 }
      const manifestPath = join(dir, 'manifest.json')
      writeFileSync(manifestPath, JSON.stringify(m, null, 2), 'utf8')

      const { status, out } = mcpbValidate(manifestPath)
      expect(status, `expected a NON-zero exit for a manifest with an extra key.\n${out}`).not.toBe(0)
      expect(out).toMatch(/Unrecognized key|mojioko/i)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 120_000)
})
