export async function openVideoDialog(defaultDir?: string): Promise<string | null> {
  return window.electronAPI.openVideoDialog(defaultDir)
}

export async function saveFileDialog(
  defaultName: string,
  defaultDir?: string,
  filters?: { name: string; extensions: string[] }[]
): Promise<string | null> {
  return window.electronAPI.saveFileDialog(defaultName, defaultDir, filters)
}

/**
 * REQ-0121 — folder picker used by the Settings > General folder inputs.
 * Returns the chosen directory or null when the user cancelled.
 */
export async function openDirectoryDialog(defaultDir?: string): Promise<string | null> {
  return window.electronAPI.openDirectoryDialog(defaultDir)
}

export async function shellOpenPath(path: string): Promise<void> {
  return window.electronAPI.shellOpenPath(path)
}

export async function shellShowInFolder(path: string): Promise<void> {
  return window.electronAPI.shellShowInFolder(path)
}

export async function writeTextFile(filePath: string, content: string): Promise<void> {
  return window.electronAPI.shellWriteTextFile(filePath, content)
}

export async function shellOpenExternal(url: string): Promise<void> {
  return window.electronAPI.shellOpenExternal(url)
}

/** True if the path exists on disk.  Returns false on any probe error. */
export async function fileExists(filePath: string): Promise<boolean> {
  return window.electronAPI.shellFileExists(filePath)
}

/** REQ-0194 — `.mojioko` project file open dialog. */
export async function openProjectDialog(defaultDir?: string): Promise<string | null> {
  return window.electronAPI.openProjectDialog(defaultDir)
}

/** REQ-0194 — read a UTF-8 text file (used for `.mojioko` project files). */
export async function readTextFile(filePath: string): Promise<string> {
  return window.electronAPI.shellReadTextFile(filePath)
}
