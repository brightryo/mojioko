type OkResult<T> = { ok: true; data: T }
type ErrResult = { ok: false; error: { code: string; message: string } }
type IpcResult<T> = OkResult<T> | ErrResult

/**
 * REQ-0258 — read the MOJIOKO EULA text for the current UI language.
 * Delegates to the main process's `app:readEula` handler which resolves
 * `build/license_<lang>.txt` (dev) or `<resourcesPath>/eula/
 * license_<lang>.txt` (packaged) and returns the UTF-8 body.
 */
export async function readEula(lang: 'ja' | 'en'): Promise<IpcResult<string>> {
  return window.electronAPI.readEula(lang)
}
