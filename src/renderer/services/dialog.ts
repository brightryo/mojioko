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
