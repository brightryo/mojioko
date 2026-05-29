import log from 'electron-log/main'
import { join, basename } from 'path'
import { readdirSync, statSync, unlinkSync } from 'fs'
import { getLogsDir } from './paths'
import { LOG_MAX_SIZE, LOG_MAX_FILES } from '../../shared/constants'

log.initialize()
log.transports.file.resolvePathFn = () => join(getLogsDir(), 'mojioko.log')
log.transports.file.maxSize = LOG_MAX_SIZE

/**
 * Called by electron-log when the live log file reaches LOG_MAX_SIZE.  We
 * rename the old file with a timestamp suffix, then prune the oldest archives
 * down to LOG_MAX_FILES so disk usage stays bounded.
 */
log.transports.file.archiveLog = (oldLog) => {
  const oldPath = oldLog.toString()
  const parts = oldPath.split('.')
  parts[parts.length - 1] = `${Date.now()}.log`
  const archivedPath = parts.join('.')

  // Defer pruning to the next tick so the rename triggered by returning
  // archivedPath has settled on disk before we list the directory.
  setImmediate(() => pruneArchivedLogs())

  return archivedPath
}

log.transports.file.level = 'info'
log.transports.console.level = process.env.NODE_ENV === 'development' ? 'debug' : false

/**
 * Keep at most LOG_MAX_FILES archived log files in the logs directory.  Files
 * are sorted by modification time (oldest first) and the surplus is deleted.
 * Errors are swallowed — logging must never crash the app.
 */
function pruneArchivedLogs(): void {
  try {
    const dir = getLogsDir()
    // Archived names follow the pattern produced by archiveLog above:
    //   mojioko.<timestamp>.log
    // Skip the live file (mojioko.log) and anything that doesn't match.
    const archivePattern = /^mojioko\.\d+\.log$/
    const archives = readdirSync(dir)
      .filter((name) => archivePattern.test(name))
      .map((name) => {
        const full = join(dir, name)
        let mtimeMs = 0
        try {
          mtimeMs = statSync(full).mtimeMs
        } catch { /* ignore */ }
        return { full, name: basename(name), mtimeMs }
      })
      .sort((a, b) => a.mtimeMs - b.mtimeMs)

    const surplus = archives.length - LOG_MAX_FILES
    for (let i = 0; i < surplus; i++) {
      try {
        unlinkSync(archives[i].full)
      } catch { /* ignore */ }
    }
  } catch {
    // logs directory may not exist yet at very first run; ignore.
  }
}

export default log
export { LOG_MAX_FILES }
