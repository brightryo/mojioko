import { describe, it, expect } from 'vitest'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeMcpbBundle, buildMcpbManifest } from '../../src/main/mcp/mcpb'

/**
 * REQ-0451 — verify the hand-rolled `.mcpb` (ZIP) is well-formed and the
 * manifest matches the MCPB v0.3 schema. Parses the archive back per the ZIP
 * spec (EOCD → central directory → local headers) and checks CRC-32, so a
 * spec-compliant reader (Claude Desktop) will accept it.
 */

// Minimal CRC-32 (IEEE) to independently verify stored checksums.
const CRC = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

interface Extracted {
  name: string
  data: Buffer
  crcOk: boolean
}

/** Parse a stored ZIP into its entries (following the ZIP spec). */
function unzip(zip: Buffer): Extracted[] {
  // End of central directory: scan backwards for the signature.
  let eocd = -1
  for (let i = zip.length - 22; i >= 0; i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  expect(eocd, 'EOCD not found').toBeGreaterThanOrEqual(0)
  const count = zip.readUInt16LE(eocd + 10)
  let cd = zip.readUInt32LE(eocd + 16)

  const out: Extracted[] = []
  for (let e = 0; e < count; e++) {
    expect(zip.readUInt32LE(cd), 'central dir sig').toBe(0x02014b50)
    const storedCrc = zip.readUInt32LE(cd + 16)
    const compSize = zip.readUInt32LE(cd + 20)
    const nameLen = zip.readUInt16LE(cd + 28)
    const extraLen = zip.readUInt16LE(cd + 30)
    const commentLen = zip.readUInt16LE(cd + 32)
    const lho = zip.readUInt32LE(cd + 42)
    const name = zip.slice(cd + 46, cd + 46 + nameLen).toString('utf8')

    // Local file header at lho.
    expect(zip.readUInt32LE(lho), 'local header sig').toBe(0x04034b50)
    const lNameLen = zip.readUInt16LE(lho + 26)
    const lExtraLen = zip.readUInt16LE(lho + 28)
    const dataStart = lho + 30 + lNameLen + lExtraLen
    const data = zip.slice(dataStart, dataStart + compSize)
    out.push({ name, data, crcOk: crc32(data) === storedCrc })

    cd += 46 + nameLen + extraLen + commentLen
  }
  return out
}

describe('REQ-0451 — .mcpb bundle', () => {
  const EXE = 'C:\\Users\\me\\AppData\\Local\\Programs\\mojioko\\MOJIOKO.exe'
  const TOOLS = [
    { name: 'status', description: 's' },
    { name: 'transcribe', description: 't' },
  ]

  it('manifest is MCPB v0.3 with the exe baked into mcp_config.command', () => {
    const m = buildMcpbManifest(EXE, TOOLS) as {
      manifest_version: string
      name: string
      version: string
      author: { name: string }
      server: { type: string; entry_point: string; mcp_config: { command: string; args: string[] } }
      tools: { name: string }[]
    }
    expect(m.manifest_version).toBe('0.3')
    expect(m.name).toBe('mojioko')
    expect(typeof m.version).toBe('string')
    expect(m.author.name).toBe('brightryo')
    expect(m.server.type).toBe('binary')
    expect(m.server.entry_point).toBe('MOJIOKO.exe')
    expect(m.server.mcp_config.command).toBe(EXE)
    expect(m.server.mcp_config.args).toEqual(['mcp'])
    expect(m.tools.map((t) => t.name)).toEqual(['status', 'transcribe'])
  })

  it('writes a valid ZIP containing manifest.json (CRC verified, parses back)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpb-test-'))
    const path = join(dir, 'mojioko.mcpb')
    try {
      writeMcpbBundle(path, EXE, TOOLS)
      const entries = unzip(readFileSync(path))
      expect(entries.length).toBe(1)
      expect(entries[0].name).toBe('manifest.json')
      expect(entries[0].crcOk, 'CRC-32 mismatch').toBe(true)
      const manifest = JSON.parse(entries[0].data.toString('utf8'))
      expect(manifest.manifest_version).toBe('0.3')
      expect(manifest.server.mcp_config.command).toBe(EXE)

      // Optionally leave a sample for external-tool interop checks.
      if (process.env.MCPB_SAMPLE_OUT) writeMcpbBundle(process.env.MCPB_SAMPLE_OUT, EXE, TOOLS)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
