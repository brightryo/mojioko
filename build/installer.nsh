; MOJIOKO installer customization
; Python sidecar is bundled via PyInstaller (resources/bin/transcriber/),
; so no host Python check is required at install time.
; Model download is handled inside the app on first use.

!macro customInstall
!macroend

!macro customUnInstall
  ; Clean up legacy install.json written by previous installer versions
  ; that performed a Python check. Safe to call when the file is absent.
  Delete "$APPDATA\MOJIOKO\install.json"
!macroend
