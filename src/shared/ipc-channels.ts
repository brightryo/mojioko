/** All IPC channel names. Single source of truth. */
export const Channels = {
  videoProbe: 'video:probe',
  videoExtractThumbnail: 'video:extractThumbnail',
  videoExtractFrameForPreview: 'video:extractFrameForPreview',

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

  /** Native menu rebuild trigger */
  menuSetLanguage: 'menu:setLanguage',

  /** Disable/enable native menu items during long-running operations */
  menuSetTranscribing: 'menu:setTranscribing'
} as const

export type ChannelName = (typeof Channels)[keyof typeof Channels]
