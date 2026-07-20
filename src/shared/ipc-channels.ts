/** All IPC channel names. Single source of truth. */
export const Channels = {
  videoProbe: 'video:probe',
  videoExtractThumbnail: 'video:extractThumbnail',
  videoExtractFrameForPreview: 'video:extractFrameForPreview',
  /**
   * REQ-20260615-021: extract a single still at the current preview time
   * and save it (PNG / JPG) at the original video resolution.  When
   * subtitles are included the same ASS pipeline as burn-in is reused so
   * the still matches a future burned video exactly.
   */
  videoExportFrame: 'video:exportFrame',

  transcriptionCheckModel: 'transcription:checkModel',
  transcriptionStart: 'transcription:start',
  transcriptionCancel: 'transcription:cancel',
  transcriptionDownloadModel: 'transcription:downloadModel',
  transcriptionListModels: 'transcription:listModels',
  transcriptionUninstallModel: 'transcription:uninstallModel',
  transcriptionSetActiveModel: 'transcription:setActiveModel',

  fontList: 'font:list',
  fontDownload: 'font:download',
  fontUninstall: 'font:uninstall',
  fontSetActive: 'font:setActive',
  fontReadOfl: 'font:readOfl',
  fontReadBytes: 'font:readBytes',

  /**
   * REQ-0149 — GPU acceleration tools (CUDA/cuDNN redistributables).
   * `state` returns the {installed / not-installed / gpu-not-detected}
   * status + folder path; `download` streams progress on a per-run
   * channel (same pattern as `transcriptionDownloadModel`); `delete`
   * removes the extracted folder and returns the fresh state.
   */
  gpuToolState: 'gpu-tool:state',
  gpuToolDownload: 'gpu-tool:download',
  gpuToolDelete: 'gpu-tool:delete',

  /**
   * REQ-0241 → REQ-0244 (removed) → REQ-0245 (restored, multi-slot).
   *
   * Under REQ-0244's per-target-key parallel semantics each UI
   * component's local `downloadingId` state cannot reliably reflect
   * main's slot map — a second DL starting clobbers the first
   * component's local flag, the first row flips back to "Download",
   * a re-click hits `DOWNLOAD_BUSY`.  REQ-0245 fixes this by
   * restoring the broadcast, but the payload is now the SNAPSHOT
   * ARRAY (all active downloads across all kinds), not a single
   * slot.  Renderer stores it in a Zustand slice and per-row
   * `isDownloading` derives from `active.some(a => matches me)`.
   */
  downloadActiveGet: 'download:active:get',
  downloadActiveChanged: 'download:active:changed',
  /**
   * REQ-0150 — persist the user's CPU/GPU card selection.  Payload is
   * `'cpu' | 'gpu'`; main downgrades to `'cpu'` if the GPU tools are
   * not installed or no NVIDIA adapter is detected (defence in depth
   * against a stale renderer state).
   */
  gpuToolSelect: 'gpu-tool:select',

  burninStart: 'burnin:start',
  burninCancel: 'burnin:cancel',

  settingsLoad: 'settings:load',
  settingsSave: 'settings:save',

  dialogOpenVideo: 'dialog:openVideo',
  dialogSaveFile: 'dialog:saveFile',
  /**
   * REQ-0121 — folder-picker used by Settings > General to choose the
   * user-preferred default input / output folders.  `properties:
   * ['openDirectory']` on top of `showOpenDialog`.
   */
  dialogOpenDir: 'dialog:openDir',
  /**
   * REQ-0194 — project file open dialog for `.mojioko`.  Same permission
   * surface as the video/audio open dialog; only the extension filter and
   * default folder differ.
   */
  dialogOpenProject: 'dialog:openProject',
  /**
   * REQ-0223 — SRT open dialog for the "import SRT" flow in step2.
   * Same shape as `dialogOpenProject`; filter narrowed to `.srt`.
   */
  dialogOpenSrt: 'dialog:openSrt',

  shellOpenPath: 'shell:openPath',
  shellShowInFolder: 'shell:showInFolder',
  shellOpenExternal: 'shell:openExternal',
  shellOpenModelsFolder: 'shell:openModelsFolder',
  shellOpenThirdPartyLicensesFolder: 'shell:openThirdPartyLicensesFolder',
  shellWriteTextFile: 'shell:writeTextFile',
  shellFileExists: 'shell:fileExists',
  /**
   * REQ-0194 — read the project file (`.mojioko`) as a UTF-8 string.
   * Path is trusted (only comes from the OS open dialog); the handler
   * still validates it points to a regular file to avoid a directory /
   * device read.
   */
  shellReadTextFile: 'shell:readTextFile',

  /** App metadata queries */
  appGetVersion: 'app:getVersion',
  appGetResourcesPath: 'app:getResourcesPath',
  appGetBuildInfo: 'app:getBuildInfo',
  appDetectEncoders: 'app:detectEncoders',
  /**
   * REQ-0258 — read the MOJIOKO EULA text for the current UI language.
   * Payload: `'ja' | 'en'`.  Returns the verbatim UTF-8 contents of
   * `build/license_<lang>.txt` (dev) / `<resourcesPath>/eula/
   * license_<lang>.txt` (packaged) as an OkResult<string>.
   *
   * Motivation: the MSIX / AppX packaging format has no install-time
   * EULA hook (electron-builder's AppXOptions carries no `license`
   * field), so paid-edition users otherwise have no way to see the
   * EULA text.  The NSIS installer still shows the same file at
   * install time via `license:` in electron-builder.yml — this
   * channel provides parity for both editions through the About
   * dialog's "View EULA" button.
   */
  appReadEula: 'app:readEula',
  /**
   * REQ-088 #4 — runtime tier signal.  `true` when the running process
   * was launched from an MSIX/AppX package (= store/paid build),
   * `false` for the NSIS GitHub free build.  The renderer uses this to
   * gate access to non-default fonts (font picker, per-row selector,
   * bulk-edit selector).  Pure read, no side effects.
   */
  appIsMsix: 'app:isMsix',

  /** Native menu rebuild trigger */
  menuSetLanguage: 'menu:setLanguage',

  /** Disable/enable native menu items during long-running operations */
  menuSetTranscribing: 'menu:setTranscribing'
} as const

export type ChannelName = (typeof Channels)[keyof typeof Channels]
