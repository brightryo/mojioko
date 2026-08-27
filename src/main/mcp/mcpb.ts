/**
 * REQ-0451 — export a `.mcpb` MCP bundle for drag-and-drop install into Claude
 * Desktop (Settings ▸ Extensions).
 *
 * A `.mcpb` is a ZIP archive with `manifest.json` at its root (manifest schema
 * v0.3, verified against anthropics/dxt MANIFEST.md). MOJIOKO's MCP server IS
 * the app's own executable (`MOJIOKO.exe mcp`), whose absolute path is known at
 * export time — so `server.mcp_config.command` is baked to that absolute exe
 * path (type `binary`, args `["mcp"]`). No files need to be bundled beyond the
 * manifest.
 *
 * NOTE (owner-verify): if Claude Desktop restricts the command to
 * `${__dirname}` (bundle-relative) instead of an external absolute path, the
 * follow-up is to also bundle a tiny launcher with the path baked in and point
 * `mcp_config.command` at `${__dirname}/launcher.cmd`. Documented in
 * dev-docs/specs/mojioko-mcp.md.
 *
 * ZIP is hand-rolled (store method) — `archiver` is only a transitive dev
 * dependency and would not ship in the packaged app.
 */
import { writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { APP_VERSION } from '../../shared/app-info'
import { mcpManifestVersion } from '../../shared/mcp'

/** Minimal capability descriptor for the manifest `tools` array. */
export interface McpbToolInfo {
  name: string
  description: string
}

// ── CRC-32 (IEEE) ───────────────────────────────────────────────────────────
const CRC_TABLE: Uint32Array = (() => {
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
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

interface ZipEntry {
  name: string
  data: Buffer
}

/** Minimal ZIP (store / no compression) — sufficient for small text entries. */
function zipStore(entries: ZipEntry[]): Buffer {
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8')
    const crc = crc32(e.data)
    const size = e.data.length

    const lfh = Buffer.alloc(30)
    lfh.writeUInt32LE(0x04034b50, 0) // local file header sig
    lfh.writeUInt16LE(20, 4) // version needed
    lfh.writeUInt16LE(0, 6) // flags
    lfh.writeUInt16LE(0, 8) // method: store
    lfh.writeUInt16LE(0, 10) // mod time
    lfh.writeUInt16LE(0x21, 12) // mod date (1980-01-01)
    lfh.writeUInt32LE(crc, 14)
    lfh.writeUInt32LE(size, 18) // compressed size
    lfh.writeUInt32LE(size, 22) // uncompressed size
    lfh.writeUInt16LE(nameBuf.length, 26)
    lfh.writeUInt16LE(0, 28) // extra len
    local.push(lfh, nameBuf, e.data)

    const cdh = Buffer.alloc(46)
    cdh.writeUInt32LE(0x02014b50, 0) // central dir sig
    cdh.writeUInt16LE(20, 4) // version made by
    cdh.writeUInt16LE(20, 6) // version needed
    cdh.writeUInt16LE(0, 8)
    cdh.writeUInt16LE(0, 10)
    cdh.writeUInt16LE(0, 12)
    cdh.writeUInt16LE(0x21, 14)
    cdh.writeUInt32LE(crc, 16)
    cdh.writeUInt32LE(size, 20)
    cdh.writeUInt32LE(size, 24)
    cdh.writeUInt16LE(nameBuf.length, 28)
    cdh.writeUInt16LE(0, 30) // extra
    cdh.writeUInt16LE(0, 32) // comment
    cdh.writeUInt16LE(0, 34) // disk
    cdh.writeUInt16LE(0, 36) // internal attrs
    cdh.writeUInt32LE(0, 38) // external attrs
    cdh.writeUInt32LE(offset, 42) // local header offset
    central.push(cdh, nameBuf)

    offset += lfh.length + nameBuf.length + e.data.length
  }

  const cdBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0) // EOCD sig
  eocd.writeUInt16LE(0, 4) // this disk
  eocd.writeUInt16LE(0, 6) // cd start disk
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cdBuf.length, 12)
  eocd.writeUInt32LE(offset, 16) // cd offset
  eocd.writeUInt16LE(0, 20) // comment len

  return Buffer.concat([...local, cdBuf, eocd])
}

/**
 * Build the `.mcpb` manifest.json object (schema v0.3).
 *
 * REQ-0452 — `command`/`args` are supplied by the caller so dev vs packaged is
 * correct. REQ-0455 — the launch now goes through the clean-stdout proxy, so
 * `args` targets `out/main/mcp-proxy.js` and `env` carries
 * `ELECTRON_RUN_AS_NODE=1` (both provided by `getMcpLaunchSpec`). `env` is
 * baked into `mcp_config.env` so the client sets it when spawning.
 */
export function buildMcpbManifest(
  command: string,
  args: string[],
  env: Record<string, string>,
  tools: McpbToolInfo[],
): Record<string, unknown> {
  return {
    manifest_version: '0.3',
    name: 'mojioko',
    display_name: 'MOJIOKO',
    // REQ-0458 §1 — version encodes app + launch-spec revision (`1.4.0+lsr.1`).
    version: mcpManifestVersion(APP_VERSION),
    /*
     * ★ REQ-0559 §1-3 — this used to end 「処理はすべてこの PC 内で完結します。」
     *
     * Claude Desktop shows this description on its install screen, which makes
     * it the single worst place in the product for that sentence: the user is
     * reading it at the exact moment they connect MOJIOKO to a remote
     * assistant, and it tells them nothing will leave. The subtitle text, file
     * paths and video metadata will.
     *
     * Kept to the same boundary the consent dialog draws, in the same terms.
     */
    description:
      'ローカル動画字幕ツール MOJIOKO を AI から操作します（文字起こし・翻訳・字幕焼き込み）。'
      + '動画・音声ファイルと処理はこの PC から出ませんが、AI がツールで読み書きする情報'
      + '（字幕テキスト・ファイルのパス・動画の情報）は AI 提供者に送信されます。',
    // REQ-0483 — display-only author name.  Correct casing is `BrightRyo`
    // (Claude Desktop shows "作成者 <name>").  This is NOT the MSIX package
    // identifier `brightryo.MOJIOKO` (store-registered, must stay lowercase).
    author: { name: 'BrightRyo' },
    // REQ-0469 — the REQ-0458 top-level `mojioko` key (appVersion /
    // launchSpecRevision) was REMOVED: it is NOT in the MCPB v0.3 manifest schema,
    // and Claude Desktop rejects the whole bundle with "Invalid manifest:
    // Unrecognized key(s) in object: 'mojioko'".  The launch-spec revision still
    // rides in TWO schema-legal places — the `version` field (`<app>+lsr.<rev>`,
    // above) and `server.mcp_config.env.MOJIOKO_LAUNCH_SPEC_REV` (below) — and the
    // running server reads ONLY the env var (`evaluateLaunchStaleness`), so stale
    // detection is unaffected.  A schema-validation gate now blocks any re-add
    // (tests/unit/mcpb-schema-validate-req-0469.test.ts).
    server: {
      type: 'binary',
      entry_point: basename(command),
      mcp_config: {
        command,
        args,
        env,
      },
    },
    tools: tools.map((t) => ({ name: t.name, description: t.description })),
    compatibility: { platforms: ['win32'] },
  }
}

/** Write a `.mcpb` bundle (ZIP with manifest.json) to `targetPath`. */
export function writeMcpbBundle(
  targetPath: string,
  command: string,
  args: string[],
  env: Record<string, string>,
  tools: McpbToolInfo[],
): void {
  const manifest = Buffer.from(JSON.stringify(buildMcpbManifest(command, args, env, tools), null, 2), 'utf8')
  const zip = zipStore([{ name: 'manifest.json', data: manifest }])
  writeFileSync(targetPath, zip)
}
