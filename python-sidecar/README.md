# Python Sidecar

MOJIOKO の文字起こしエンジン（faster-whisper ラッパー）。
Electron メインプロセスからサブプロセスとして起動され、stdin/stdout で JSON-line 通信する。

## Requirements

- Python 3.11.x
- `requirements.txt` に記載のパッケージ

## Setup (development)

```powershell
cd <repo>
py -3.11 -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r python-sidecar\requirements.txt
```

## Protocol

**Main → Sidecar（stdin、1 行 = 1 JSON）:**

```json
{ "cmd": "ping" }
{ "cmd": "transcribe", "videoPath": "C:/video.mp4", "trackIndex": 2, "modelId": "medium", "modelsDir": "C:/Users/user/AppData/Roaming/MOJIOKO/models", "ffmpegPath": "C:/path/to/ffmpeg.exe" }
{ "cmd": "shutdown" }
```

**Sidecar → Main（stdout、1 行 = 1 JSON）:**

```json
{ "event": "pong" }
{ "event": "started", "totalDurationSec": 870.5 }
{ "event": "segment", "segment": { "startSec": 1.23, "endSec": 3.45, "text": "こんにちは" } }
{ "event": "progress", "percent": 24 }
{ "event": "completed", "segmentCount": 142 }
{ "event": "failed", "error": "エラーメッセージ" }
{ "event": "needsDownload", "model": "medium" }
```

## Troubleshooting

### `ModuleNotFoundError: No module named 'requests'`

`faster-whisper==1.0.3` は `requests` を内部で使用していますが、パッケージメタデータへの宣言が漏れています（`pip check` では検出されません）。`requirements.txt` には `requests>=2.28` を明示しているため、通常の手順でインストールすれば解消されます。

既存の venv でこのエラーが出る場合は、以下を実行してください。

```powershell
cd <repo>
.\.venv\Scripts\Activate.ps1
pip install --force-reinstall -r python-sidecar\requirements.txt
```

### その他の `ModuleNotFoundError`

依存の不整合が疑われる場合は、venv を作り直してください。

```powershell
cd <repo>
Remove-Item -Recurse -Force .venv
py -3.11 -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r python-sidecar\requirements.txt
```

## Notes

- `transcribe` コマンドを受信すると、まず `modelsDir/modelId/` ディレクトリの存在確認を行う。
  存在しない場合は `needsDownload` を送信して終了（ダウンロード自体は Electron 側が担当）。
- 音声抽出は ffmpeg（`ffmpegPath` で指定、なければ PATH を探索）で行い、一時 WAV ファイルを生成する。
- 処理完了後、一時 WAV は自動削除される。
- `shutdown` コマンドを受信するか、stdin が閉じられると終了する。
