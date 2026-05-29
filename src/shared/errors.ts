export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export class InvalidVideoError extends AppError {
  constructor(message: string, details?: unknown) {
    super('INVALID_VIDEO', message, details)
    this.name = 'InvalidVideoError'
  }
}

export class FfmpegError extends AppError {
  constructor(message: string, details?: unknown) {
    super('FFMPEG_ERROR', message, details)
    this.name = 'FfmpegError'
  }
}

export class TranscriptionError extends AppError {
  constructor(message: string, details?: unknown) {
    super('TRANSCRIPTION_ERROR', message, details)
    this.name = 'TranscriptionError'
  }
}

export class WhisperModelNotFoundError extends AppError {
  constructor(modelId: string) {
    super('WHISPER_MODEL_NOT_FOUND', `Whisper model "${modelId}" is not installed.`, { modelId })
    this.name = 'WhisperModelNotFoundError'
  }
}

export class ModelDownloadError extends AppError {
  constructor(message: string, details?: unknown) {
    super('MODEL_DOWNLOAD_ERROR', message, details)
    this.name = 'ModelDownloadError'
  }
}

export class SettingsCorruptError extends AppError {
  constructor(message: string, details?: unknown) {
    super('SETTINGS_CORRUPT', message, details)
    this.name = 'SettingsCorruptError'
  }
}
