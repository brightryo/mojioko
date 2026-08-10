/**
 * REQ-0463 — resolve the absolute path to the MCP clean-stdout proxy
 * (`out/main/mcp-proxy.js`), correct for dev AND packaged builds.
 *
 * The proxy is launched as a PLAIN Node script (`ELECTRON_RUN_AS_NODE=1`,
 * REQ-0455).  A script that lives INSIDE `app.asar` cannot be executed that way
 * — the archive is not a real directory the OS/Node can hand to the runtime as
 * an entry point — so the packaging configs (electron-builder*.yml) `asarUnpack`
 * it (and the shared chunk it `require`s, under `out/main/chunks/`).  Unpacked
 * files land at `<app.asar>.unpacked/<same relative path>`, so in a packaged
 * build the launch spec must point THERE, not inside the archive.
 *
 * Kept as a pure, electron-free helper so a unit test can pin the derivation
 * (dev vs packaged) without an Electron runtime, and so the packaged path stays
 * locked to what `asarUnpack` produces (REQ-0463 §3).
 */
import { join } from 'node:path'

/**
 * The proxy's path RELATIVE to the app directory / unpacked root, as forward-
 * slash segments.  This is exactly the glob the `asarUnpack` entry uses, so the
 * launch spec and the packaging config cannot drift (asserted in the REQ-0463
 * test).
 */
export const MCP_PROXY_REL_PATH = 'out/main/mcp-proxy.js'

/** Segments of {@link MCP_PROXY_REL_PATH}, for `path.join`. */
const PROXY_REL_SEGMENTS = MCP_PROXY_REL_PATH.split('/')

/**
 * Given `app.getAppPath()` and `app.isPackaged`, return the absolute path to
 * `mcp-proxy.js`.
 *
 * - **dev** (`isPackaged=false`): `<repoRoot>/out/main/mcp-proxy.js` — the file
 *   sits directly in the build output, no asar involved.
 * - **packaged** (`isPackaged=true`, asar on): `app.getAppPath()` is
 *   `…/resources/app.asar`; the unpacked copy is a sibling
 *   `…/resources/app.asar.unpacked`, so swap in that base.
 * - **packaged, asar disabled** (defensive): `appDir` does not end in
 *   `app.asar`, so there is no `.unpacked` sibling — fall back to `appDir`,
 *   where the file ships directly.
 */
export function resolveMcpProxyPath(appDir: string, isPackaged: boolean): string {
  const baseDir = isPackaged && appDir.endsWith('app.asar') ? `${appDir}.unpacked` : appDir
  return join(baseDir, ...PROXY_REL_SEGMENTS)
}
