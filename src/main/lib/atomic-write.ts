import { promises as fsp } from 'fs'
import { basename, dirname, join } from 'path'
import log from './logger'

/**
 * REQ-0545 §1 (RES-0543 F1) — write a file so that a failure cannot destroy the
 * previous version.
 *
 * ## What was wrong
 *
 * Both writers were a bare `fs.writeFile` onto the destination path. That
 * TRUNCATES the target first, so a crash, a power loss or a full disk part-way
 * through leaves a half-written file and **no copy of what was there before**.
 * For `settings.json` that costs the user their preferences; for a `.mojioko`
 * overwrite — the ordinary "save over the file I opened" gesture — it costs
 * them the project.
 *
 * ## The shape
 *
 * Write a sibling temp file, flush it to the platter, then `rename` it over the
 * destination. `rename` within one directory is atomic on both NTFS and POSIX:
 * a reader sees either the whole old file or the whole new one, never a
 * fragment. The temp file is deliberately a SIBLING rather than in the OS temp
 * directory — `rename` is only atomic within a volume, and the user's project
 * may well live on a different drive from `%TEMP%`.
 *
 * ## Windows: the rename can fail even when nothing is wrong
 *
 * Antivirus and search indexers open files opportunistically, and a `rename`
 * onto a path someone is holding fails with EPERM/EBUSY. That window is short,
 * so one retry after a brief pause clears it in practice.
 *
 * ★ If the retry also fails the error is thrown to the caller. It deliberately
 * does NOT fall back to writing the destination directly: the direct write is
 * exactly the unsafe operation this function exists to avoid, and a "safe write
 * that silently becomes unsafe under load" is worse than no guarantee at all,
 * because nobody would know which one they got.
 */
const RENAME_RETRY_DELAY_MS = 60

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Marker that identifies our temp files, so cleanup cannot touch a real file. */
const TEMP_INFIX = '.tmp-'

function tempNameFor(filePath: string): string {
  return join(
    dirname(filePath),
    `${basename(filePath)}${TEMP_INFIX}${process.pid}-${Date.now()}`,
  )
}

/**
 * Remove leftovers from a previous failed write of THIS destination.
 *
 * REQ-0545 §1-2 asks for cleanup on the existing path rather than a new
 * startup sweep, so it happens here, scoped to siblings whose name begins with
 * the destination's own name plus the temp infix. A file the user happens to
 * have called `notes.txt` cannot match `notes.txt.tmp-…`.
 *
 * Best-effort by design: a leftover temp file is untidy, not dangerous, and
 * failing the save because we could not delete one would invert the priority.
 */
async function cleanStaleTemps(filePath: string, keep: string): Promise<void> {
  const dir = dirname(filePath)
  const prefix = `${basename(filePath)}${TEMP_INFIX}`
  try {
    const names = await fsp.readdir(dir)
    for (const name of names) {
      if (!name.startsWith(prefix)) continue
      const full = join(dir, name)
      if (full === keep) continue
      await fsp.unlink(full).catch(() => { /* someone else may have it */ })
    }
  } catch {
    // Directory unreadable — the write below will fail with a better message.
  }
}

async function renameWithOneRetry(from: string, to: string): Promise<void> {
  try {
    await fsp.rename(from, to)
    return
  } catch (first) {
    log.warn(`[atomic-write] rename failed, retrying once: ${to}`, first)
    await delay(RENAME_RETRY_DELAY_MS)
    try {
      await fsp.rename(from, to)
    } catch {
      // Report the FIRST failure: it is the one that describes the original
      // condition, and the retry's error is usually the same thing again.
      throw first
    }
  }
}

/**
 * Write `content` to `filePath`, leaving the previous contents intact if
 * anything goes wrong.
 *
 * The signature matches the `fs.writeFile` call it replaces, so callers do not
 * change — only the guarantee does.
 */
export async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const tmpPath = tempNameFor(filePath)
  await cleanStaleTemps(filePath, tmpPath)
  try {
    const handle = await fsp.open(tmpPath, 'w')
    try {
      await handle.writeFile(content, 'utf-8')
      // Flush to the device before the rename. Without this the rename can be
      // durable while the DATA is still in cache, which on a power loss gives
      // an intact-looking file full of zeros — the one outcome worse than the
      // bug being fixed.
      await handle.sync()
    } finally {
      await handle.close()
    }
    await renameWithOneRetry(tmpPath, filePath)
  } catch (err) {
    // The destination has not been touched at this point, so removing the temp
    // file restores the directory to exactly its previous state.
    await fsp.unlink(tmpPath).catch(() => { /* may not exist yet */ })
    throw err
  }
}
