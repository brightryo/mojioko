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

  burninStart: 'burnin:start',
  burninCancel: 'burnin:cancel',

  settingsLoad: 'settings:load',
  settingsSave: 'settings:save',

  dialogOpenVideo: 'dialog:openVideo',
  dialogSaveFile: 'dialog:saveFile',

  shellOpenPath: 'shell:openPath',
  shellShowInFolder: 'shell:showInFolder',
  shellOpenExternal: 'shell:openExternal',
  shellOpenModelsFolder: 'shell:openModelsFolder',
  shellOpenThirdPartyLicensesFolder: 'shell:openThirdPartyLicensesFolder',
  shellWriteTextFile: 'shell:writeTextFile',
  shellFileExists: 'shell:fileExists',

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
