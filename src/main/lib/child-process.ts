import { execFile, spawn, type SpawnOptions, type ChildProcess } from 'child_process'
import { promisify } from 'util'
import log from './logger'

export const execFileAsync = promisify(execFile)

export function spawnProcess(
  command: string,
  args: string[],
  options?: SpawnOptions
): ChildProcess {
  log.info(`[spawn] ${command} ${args.join(' ')}`)
  return spawn(command, args, { ...options })
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
