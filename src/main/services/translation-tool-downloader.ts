import { mkdirSync, rmSync, renameSync, existsSync, statSync, createReadStream } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'
import type { DownloadModelEvent } from '../../shared/ipc-contracts'
import { downloadFile } from './model-downloader'
import { writeModelMeta } from './model-meta'
import {
  getTranslationTool,
  translationToolFileUrl,
  type TranslationToolId,
} from '../../shared/translation-tools'
import log from '../lib/logger'

/**
 * REQ-0407 — real streaming download for a translation tool (MADLAD-400 CT2),
 * reusing the Whisper downloader's `downloadFile` (HTTP Range resume + bounded
 * retry).  Files are fetched from the PINNED `repo@revision` HuggingFace resolve
 * URLs into a temp dir, verified (size via `downloadFile`'s content-length gate
 * + `model.bin` sha256 against the pinned hash), and then ATOMICALLY renamed
 * into place, so a partial/aborted download never leaves a half-installed tool
 * that `isToolInstalled` would accept.
 *
 * Progress is byte-weighted across the whole tool (model.bin is ~99 % of the
 * bytes, so per-file-equal weighting would make the bar jump); it emits the same
 * `DownloadModelEvent` shape the Whisper model download uses.
 */
export async function downloadTranslationTool(
  toolId: TranslationToolId,
  toolsDir: string,
  onEvent: (evt: DownloadModelEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const def = getTranslationTool(toolId)
  if (def.repo === null || def.revision === null) {
    throw new Error(`Translation tool ${toolId} has no download source`)
  }

  const finalDir = join(toolsDir, toolId)
  const tmpDir = join(toolsDir, `.${toolId}.download-tmp`)

  // Clean slate for the temp dir (a prior aborted run may have left one).
  try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
  mkdirSync(tmpDir, { recursive: true })

  const totalBytes = def.expectedSizeBytes
  let completedBytes = 0

  try {
    for (let i = 0; i < def.files.length; i++) {
      const filename = def.files[i]
      const url = translationToolFileUrl(def, filename)
      const destPath = join(tmpDir, filename)

      log.info(`[translation-dl] ${toolId}: ${filename} (${i + 1}/${def.files.length})`)
      onEvent({ event: 'progress', file: filename, fileIndex: i, totalFiles: def.files.length, percent: Math.floor((completedBytes / totalBytes) * 100) })

      let lastFileBytes = 0
      await downloadFile(
        url,
        destPath,
        (received) => {
          lastFileBytes = received
          const pct = totalBytes > 0 ? Math.min(100, Math.floor(((completedBytes + received) / totalBytes) * 100)) : 0
          onEvent({ event: 'progress', file: filename, fileIndex: i, totalFiles: def.files.length, percent: pct })
        },
        signal,
      )
      completedBytes += lastFileBytes || (existsSync(destPath) ? statSync(destPath).size : 0)
    }

    // Integrity: verify model.bin against the pinned sha256.
    if (def.modelBinSha256) {
      const actual = await sha256File(join(tmpDir, 'model.bin'))
      if (actual !== def.modelBinSha256) {
        throw new Error(`model.bin sha256 mismatch for ${toolId}: got ${actual}`)
      }
    }

    // Completion marker (same convention as Whisper models).
    writeModelMeta(tmpDir, toolId)

    // Atomic move into place (same volume → rename is atomic).
    try { rmSync(finalDir, { recursive: true, force: true }) } catch { /* ignore */ }
    renameSync(tmpDir, finalDir)

    onEvent({ event: 'completed' })
  } catch (err) {
    try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
    throw err
  }
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}
