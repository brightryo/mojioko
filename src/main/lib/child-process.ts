import { execFile, spawn, type SpawnOptions, type ChildProcess } from 'child_process'
import { promisify } from 'util'
import log from './logger'

export const execFileAsync = promisify(execFile)

/**
 * Spawn a child process with the argv array passed to it directly (no shell).
 *
 * REQ-0103 — ``shell: false`` is Node's default, but making it explicit here
 * is intentional.  Every argv-based call site (ffmpeg burn-in / preview-mix /
 * frame-exporter, ffprobe via execFileAsync, transcription-sidecar) relies on
 * the child receiving each argument as-is.  A future caller that supplies
 * ``options`` must not be allowed to opt in to ``shell: true`` through this
 * helper: shell interpretation would let filename metacharacters (``|``, ``&``,
 * ``>``) split a user-provided path and corrupt the command.
 */
export function spawnProcess(
  command: string,
  args: string[],
  options?: SpawnOptions
): ChildProcess {
  log.info(`[spawn] ${command} ${args.join(' ')}`)
  return spawn(command, args, { ...options, shell: false })
}

/** Try a list of commands in order, returning the first that resolves. */
export async function tryCommands<T>(
  candidates: string[],
  fn: (cmd: string) => Promise<T>
): Promise<T> {
  let lastError: unknown
  for (const cmd of candidates) {
    try {
      return await fn(cmd)
    } catch (err) {
      lastError = err
    }
  }
  throw lastError
}
