# Privacy Policy

**Effective Date**: May 30, 2026
**Last Updated**: May 30, 2026

[日本語版 / Japanese version](PRIVACY_JA.md)

---

## Summary

**MOJIOKO does not collect, transmit, or store any personal data.**
All video processing, transcription, and subtitle generation happen entirely on your local PC.
No data leaves your device unless you explicitly initiate an action that requires network access.

---

## 1. Data Collection

MOJIOKO does **not** collect any of the following:

- Personal identification information (name, email, address, etc.)
- Video content or audio data
- Transcribed text content
- Subtitle files or output videos
- Usage statistics, analytics, or telemetry
- Device fingerprints, IP addresses, or hardware identifiers
- Crash reports or error logs (logs are stored locally only)

---

## 2. Local Data Storage

The following data is stored **locally on your PC** only:

| Data | Location | Purpose |
|---|---|---|
| Application settings | `%APPDATA%\MOJIOKO\settings.json` | Language preference, fade duration, encoder choice, etc. |
| Application logs | `%APPDATA%\MOJIOKO\logs\mojioko.log` | Debugging and troubleshooting (rotated at 5 MB, 3 generations) |
| Whisper models | `%APPDATA%\MOJIOKO\models\` | Speech recognition models you downloaded |
| Video / audio files | User-specified locations | Your input and output files |

You can delete any of this data at any time. Uninstalling the application removes the program files but preserves user settings by default.

---

## 3. Network Communication

MOJIOKO performs network requests **only when you explicitly trigger them**:

### Initiated Actions

- **Downloading a Whisper model**
  - Connects to: HuggingFace (`huggingface.co`)
  - Purpose: Downloads the selected speech recognition model
- **Opening the download page**
  - Opens external browser to: `brightryo.github.io/mojioko`
- **Opening user guide or external links**
  - Opens external browser to URLs on the documented allowlist
- **Donating via Buy Me a Coffee / BOOTH / GitHub Sponsors**
  - Opens external browser to respective service URLs

### What is NOT Communicated

- No telemetry or analytics requests are sent on startup, during use, or at any other time
- No automatic update checks (manual via Help menu)
- No crash reports or error reports

---

## 4. Third-Party Services

MOJIOKO does not embed any third-party SDKs or services that collect user data.

External services accessed via your explicit action (Whisper model download from HuggingFace, donation services, documentation pages) are subject to their own privacy policies. We recommend reviewing them:

- [HuggingFace Privacy Policy](https://huggingface.co/privacy)
- [Buy Me a Coffee Privacy Policy](https://www.buymeacoffee.com/privacy-policy)
- [BOOTH Privacy Policy](https://booth.pm/help_legal)
- [GitHub Privacy Policy](https://docs.github.com/site-policy/privacy-policies)

---

## 5. Security

- **Sandboxed processes**: The application's renderer process runs in a sandbox with `contextIsolation` enabled, preventing direct Node.js API access from the UI layer.
- **Content Security Policy**: Strict CSP prevents loading external scripts or unauthorized resources.
- **File access restrictions**: Video file access is restricted via the `mojioko-media://` allowlist to files explicitly opened by the user.
- **External URL allowlist**: Outbound browser URLs are restricted to a documented allowlist.

---

## 6. Open Source Components

MOJIOKO is built with open-source components (Electron, faster-whisper, ffmpeg, etc.). Third-party license information is included with the application. None of these components include telemetry or data collection in the configurations used.

---

## 7. Children's Privacy

MOJIOKO is not directed at children under 13. As we do not collect any personal information, this policy does not specifically address children's privacy beyond stating that no data is collected from any user.

---

## 8. Changes to This Policy

If we make changes to this privacy policy, the updated version will be reflected in:
- The application's source repository
- Future installer documentation

The "Last Updated" date at the top of this document will be revised accordingly.

---

## 9. Contact

For privacy-related questions or concerns:
- GitHub Issues: [github.com/brightryo/mojioko/issues](https://github.com/brightryo/mojioko/issues)

---

Copyright © 2026 BrightRyo. All rights reserved.
