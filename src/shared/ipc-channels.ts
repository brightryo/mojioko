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
  // REQ-0241 → REQ-0244: the app-wide DL broadcast channels were
  // retired when download policy shifted from single-slot mutex to
  // per-target-key parallel.  Each manager tracks its own state
  // locally; main-side DownloadManager still enforces same-target
  // uniqueness but does not need renderer observability.
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
