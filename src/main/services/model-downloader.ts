import { existsSync, readdirSync, statSync, mkdirSync, createWriteStream, unlinkSync } from 'fs'
import { join } from 'path'
import type { DownloadModelEvent } from '../../shared/ipc-contracts'
import log from '../lib/logger'

export interface ModelInfo {
  installed: boolean
  sizeMB: number
}

const ESTIMATED_SIZES: Record<string, number> = {
  small: 461,
  medium: 1530,
  'large-v3': 3100
}

// File lists per model — derived from the Systran HuggingFace repos:
//   faster-whisper-small  : config.json model.bin tokenizer.json vocabulary.txt
//   faster-whisper-medium : config.json model.bin tokenizer.json vocabulary.txt
//   faster-whisper-large-v3: config.json model.bin preprocessor_config.json tokenizer.json vocabulary.json
const MODEL_FILES: Record<string, string[]> = {
  small:    ['config.json', 'model.bin', 'tokenizer.json', 'vocabulary.txt'],
  medium:   ['config.json', 'model.bin', 'tokenizer.json', 'vocabulary.txt'],
  'large-v3': ['config.json', 'model.bin', 'preprocessor_config.json', 'tokenizer.json', 'vocabulary.json'],
}
const DEFAULT_MODEL_FILES = MODEL_FILES['medium']

export function checkModel(modelId: string, modelsDir: string): ModelInfo {
  const modelDir = join(modelsDir, modelId)
  if (!existsSync(modelDir)) {
    return { installed: false, sizeMB: ESTIMATED_SIZES[modelId] ?? 0 }
  }
  try {
    let totalBytes = 0
    const items = readdirSync(modelDir)
    for (const item of items) {
      try {
        totalBytes += statSync(join(modelDir, item)).size
      } catch { /* ignore */ }
    }
    return { installed: true, sizeMB: Math.round(totalBytes / 1_000_000) }
  } catch {
    return { installed: false, sizeMB: ESTIMATED_SIZES[modelId] ?? 0 }
  }
}

async function downloadFile(
  url: string,
  destPath: string,
  onProgress: (received: number, total: number) => void,
  signal: AbortSignal
): Promise<void> {
  const resp = await fetch(url, { signal, redirect: 'follow' })

  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} fetching ${new URL(url).pathname.split('/').pop()}`)
  }

  const contentLength = parseInt(resp.headers.get('content-length') ?? '0', 10)
  const dest = createWriteStream(destPath)

  let received = 0
  if (!resp.body) throw new Error(`No response body for ${url}`)
  const reader = resp.body.getReader()

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      dest.write(value)
      received += value.length
      if (contentLength > 0) onProgress(received, contentLength)
    }
    await new Promise<void>((res, rej) => dest.end((err: Error | null | undefined) => (err ? rej(err) : res())))
  } catch (err) {
    dest.destroy()
    try { unlinkSync(destPath) } catch { /* ignore */ }
    throw err
  } finally {
    reader.releaseLock()
  }
}

export async function downloadModel(
  modelId: string,
  modelsDir: string,
  onEvent: (evt: DownloadModelEvent) => void,
  signal: AbortSignal
): Promise<void> {
  const modelDir = join(modelsDir, modelId)
  mkdirSync(modelDir, { recursive: true })

  const files = MODEL_FILES[modelId] ?? DEFAULT_MODEL_FILES
  const baseUrl = `https://huggingface.co/Systran/faster-whisper-${modelId}/resolve/main`
  const totalFiles = files.length
  const downloadedPaths: string[] = []

  try {
    for (let i = 0; i < files.length; i++) {
      const filename = files[i]
      const url = `${baseUrl}/${filename}`
      const destPath = join(modelDir, filename)

      log.info(`[downloader] downloading ${filename} (${i + 1}/${totalFiles})`)
      onEvent({ event: 'progress', file: filename, fileIndex: i, totalFiles, percent: 0 })

      await downloadFile(
        url,
        destPath,
        (received, total) => {
          const overallPct = Math.floor(((i + received / total) / totalFiles) * 100)
          onEvent({ event: 'progress', file: filename, fileIndex: i, totalFiles, percent: overallPct })
        },
        signal
      )

      downloadedPaths.push(destPath)
    }
  } catch (err) {
    // Clean up any files already written for this partial download
    for (const p of downloadedPaths) {
      try { unlinkSync(p) } catch { /* ignore */ }
    }
    throw err
  }

  onEvent({ event: 'completed' })
}
