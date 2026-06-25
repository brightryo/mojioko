; MOJIOKO installer customization
; Python sidecar is bundled via PyInstaller (resources/bin/transcriber/),
; so no host Python check is required at install time.
; Model download is handled inside the app on first use.

!macro customInstall
!macroend

!macro customUnInstall
  ; v1.3.1 (REQ-20260615-071): the legacy install.json cleanup that
  ; lived here is now subsumed by `deleteAppDataOnUninstall: true` in
  ; electron-builder.yml — the whole `%APPDATA%\MOJIOKO\` directory
  ; (install.json, settings.json, models/, logs/, fonts/) is removed
  ; on user-initiated uninstall.  Macro intentionally left empty;
  ; electron-builder requires the definition to exist.
!macroend
