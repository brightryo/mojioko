#!/usr/bin/env python3
"""MOJIOKO transcription sidecar — faster-whisper transcription engine. JSON-line protocol over stdin/stdout."""
import sys
import json
import os
import subprocess
import tempfile
import shutil
from pathlib import Path

# REQ-0103 — stdin must be reconfigured to UTF-8 as well.  Electron writes the
# transcription request as UTF-8 JSON; if this process inherits a non-UTF-8
# system locale (e.g. cp1252 on English Windows, Shift_JIS on Japanese Windows
# without PYTHONUTF8 propagation), decoding stdin with the locale codec
# mangles non-ASCII bytes in `videoPath` (paths containing emoji, middle
# dot, CJK, etc.) and the reconstructed path fails to open.
sys.stdin.reconfigure(encoding='utf-8')
sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')


def send(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def find_ffmpeg(ffmpeg_path: str) -> str:
    """Return usable ffmpeg path, falling back to PATH lookup."""
    if ffmpeg_path and os.path.isfile(ffmpeg_path):
        return ffmpeg_path
    found = shutil.which("ffmpeg")
    if found:
        return found
    raise FileNotFoundError("ffmpeg not found")


def extract_audio(video_path: str, track_index: int, output_wav: str, ffmpeg: str) -> None:
    """Extract audio track to mono 16kHz WAV for Whisper.

    REQ-0103 — defensive path handling.  A Store certification tester reported
    ``Error opening input: No such file or directory`` for input paths that
    contain shell metacharacters (``|``), the middle dot (``·``), emoji and
    non-ASCII CJK/latin-extended.  The most likely cause is not our own shell
    invocation (we already spawn ffmpeg via ``subprocess.run([...])`` — no
    shell) but the combination of (a) stdin locale mismatch corrupting the
    incoming JSON payload before it ever reaches ffmpeg, and (b) missing
    absolute-path normalization / existence check that would surface the
    problem sooner and with a clearer message.  Fixes:

    - Normalize ``video_path`` to an absolute path so ffmpeg is not resolving
      against the sidecar's arbitrary cwd.
    - Pre-check file existence with the actual filesystem so a clearly-worded
      Python-side error is raised instead of ffmpeg's terse ``No such file``.
    - ``subprocess.run(cmd, ...)`` is already argv-based (no ``shell=True``);
      Python builds the command line with CreateProcessW natively, so pipe /
      middle-dot / emoji in the filename are passed to ffmpeg unmolested.
    """
    if not video_path:
        raise RuntimeError("Audio extraction failed: empty input path")

    abs_video_path = os.path.abspath(video_path)
    if not os.path.exists(abs_video_path):
        raise RuntimeError(
            f"Audio extraction failed: input file does not exist at {abs_video_path}"
        )

    audio_map = f"0:a:{track_index - 1}" if track_index >= 1 else "0:a:0"
    cmd = [
        ffmpeg, "-y",
        "-i", abs_video_path,
        "-map", audio_map,
        "-ac", "1",
        "-ar", "16000",
        "-vn",
        output_wav,
    ]
    print(f"[debug] ffmpeg extract argv: {cmd!r}", file=sys.stderr)
    result = subprocess.run(cmd, capture_output=True)
    if result.returncode != 0:
        stderr = result.stderr.decode("utf-8", errors="replace")
        raise RuntimeError(f"ffmpeg audio extraction failed: {stderr[-500:]}")


def transcribe(msg: dict) -> None:
    video_path: str = msg.get("videoPath", "")
    track_index: int = msg.get("trackIndex", 0)
    model_id: str = msg.get("model", "")
    if not model_id:
        send({"event": "failed", "error": "No model specified"})
        return
    models_dir: str = msg.get("modelsDir", "")
    ffmpeg_path: str = msg.get("ffmpegPath", "")

    model_dir = Path(models_dir) / model_id if models_dir else None

    if model_dir is None or not model_dir.is_dir():
        send({"event": "needsDownload", "model": model_id})
        return

    try:
        ffmpeg = find_ffmpeg(ffmpeg_path)
    except FileNotFoundError as e:
        send({"event": "failed", "error": str(e)})
        return

    tmp_wav = os.path.join(tempfile.gettempdir(), f"mojioko_audio_{os.getpid()}.wav")
    try:
        # REQ-0142 §3.1 — phase notifications inserted at each prep boundary.
        # These are pure observation points: the existing extract / import /
        # model-load / transcribe calls below are byte-identical to
        # pre-REQ-0142.  Any tampering with those calls is out of scope
        # (`REQ-0142 §1 excludes' 既存ロジックへの変更`).
        send({"event": "phase", "phase": "extractAudio"})
        try:
            extract_audio(video_path, track_index, tmp_wav, ffmpeg)
        except Exception as e:
            send({"event": "failed", "error": f"Audio extraction failed: {e}"})
            return

        send({"event": "phase", "phase": "loadModel"})
        try:
            from faster_whisper import WhisperModel  # type: ignore[import]
        except ImportError:
            send({"event": "failed", "error": "faster-whisper is not installed"})
            return

        # REQ-0145 — CUDA-first + CPU fallback.  RES-0144 confirmed the
        # shipped ctranslate2.dll is a CUDA build (imports cublas64_12,
        # nvcuda, cudnn64_9; ships CUDA kernels), but main.py had held
        # `device="cpu"` since v1.0.0.  Owner has NVIDIA + CUDA Toolkit
        # installed and asked us to prove GPU actually engages before
        # committing to a distribution overhaul in Step 2 (cudnn redist,
        # cpu/gpu toggle UI, installer size).
        #
        # Compute-type choice:
        #   - GPU: `int8_float16` — the on-disk model is already int8-
        #     quantized, so int8_float16 keeps the small weights but
        #     runs activations in fp16 for higher precision.
        #     faster-whisper's own README recommends this combination
        #     for GPU inference with int8 models.  Pure `float16` would
        #     upcast the weights (larger memory, slower); pure `int8`
        #     on GPU is fastest but slightly lower quality.
        #   - CPU: `int8` (unchanged from pre-REQ-0145 — the fastest
        #     path on modern x86 SIMD int8).
        def _select_device() -> tuple[str, str]:
            try:
                import ctranslate2  # type: ignore[import]
                if ctranslate2.get_cuda_device_count() > 0:
                    return "cuda", "int8_float16"
            except Exception as probe_err:
                # ctranslate2 unavailable or CUDA driver probe threw —
                # treat as "no GPU" and continue with CPU.
                print(f"[device] CUDA probe failed: {type(probe_err).__name__}: {probe_err}",
                      file=sys.stderr)
            return "cpu", "int8"

        requested_device, requested_compute = _select_device()
        actual_device: str = requested_device
        actual_compute: str = requested_compute
        fell_back: bool = False
        try:
            model = WhisperModel(str(model_dir), device=requested_device, compute_type=requested_compute)
        except Exception as e:
            # REQ-0145 §2 — if the CUDA path was chosen but Model init
            # failed (missing cuDNN redist on the user's machine, driver
            # mismatch, out-of-memory, etc.) fall back to CPU rather
            # than aborting the run.  Owner's UX is "transcription
            # completes", not "transcription errors out because the GPU
            # attempt failed."
            if requested_device != "cpu":
                print(f"[device] CUDA WhisperModel init failed ({type(e).__name__}: {e}); "
                      f"falling back to device=cpu compute_type=int8",
                      file=sys.stderr)
                try:
                    model = WhisperModel(str(model_dir), device="cpu", compute_type="int8")
                    actual_device = "cpu"
                    actual_compute = "int8"
                    fell_back = True
                except Exception as e2:
                    send({"event": "failed", "error": f"Failed to load model: {e2}"})
                    return
            else:
                send({"event": "failed", "error": f"Failed to load model: {e}"})
                return

        # REQ-0145 §3 — surface the actual device to (a) the sidecar
        # stderr log so `[sidecar stderr]` in the main-process log shows
        # it, and (b) the renderer via a new `deviceInfo` IPC event so
        # a chip in the drawer can display it live.  Both channels
        # cover the "how does the owner check which device fired?"
        # question in REQ §3.
        print(f"[device] using device={actual_device} compute_type={actual_compute} "
              f"fell_back={fell_back}",
              file=sys.stderr)
        send({
            "event": "deviceInfo",
            "device": actual_device,
            "computeType": actual_compute,
            "fellBack": fell_back,
        })

        # REQ-0142 §3.1 — the VAD + language-detection prepass runs inside
        # `model.transcribe(...)` BEFORE the iterator is returned.  Emit
        # this phase name right before that call so the renderer swaps
        # its label from "loadModel" to "prepass" at the correct instant.
        send({"event": "phase", "phase": "prepass"})

        try:
            beam_size: int = int(msg.get("beamSize", 5))
            lang_raw: str = str(msg.get("language", "auto"))
            language = None if lang_raw == "auto" else lang_raw
            vad_filter: bool = bool(msg.get("vadFilter", True))
            vad_threshold: float = float(msg.get("vadThreshold", 0.5))
            min_speech_ms: int = int(msg.get("minSpeechDurationMs", 250))
            min_silence_ms: int = int(msg.get("minSilenceDurationMs", 2000))

            transcribe_kwargs: dict = {
                "beam_size": beam_size,
                "language": language,
                "vad_filter": vad_filter,
            }
            if vad_filter:
                transcribe_kwargs["vad_parameters"] = {
                    "threshold": vad_threshold,
                    "min_speech_duration_ms": min_speech_ms,
                    "min_silence_duration_ms": min_silence_ms,
                }

            collected = []
            try:
                segments_iter, info = model.transcribe(tmp_wav, **transcribe_kwargs)
                total_duration = info.duration if info.duration else 0.0
                send({"event": "started", "totalDurationSec": total_duration})

                for i, seg in enumerate(segments_iter):
                    print(f"[debug] segment {i}: start={seg.start:.3f}, end={seg.end:.3f}, text={seg.text.strip()!r}", file=sys.stderr)
                    collected.append(seg)
                    send({
                        "event": "segment",
                        "segment": {
                            "startSec": seg.start,
                            "endSec": seg.end,
                            "text": seg.text.strip(),
                        },
                    })
                    if total_duration > 0:
                        percent = min(99, int(seg.end / total_duration * 100))
                    else:
                        percent = 0
                    send({"event": "progress", "percent": percent})
            except ValueError as e:
                # REQ-20260615-063 — faster-whisper crashes with
                # "max() arg is an empty sequence" when VAD filters
                # out every audio chunk AND `language` is "auto" —
                # the eager language-detection majority vote at
                # faster_whisper/transcribe.py:419 then runs `max()`
                # on an empty dict.  In faster-whisper 1.0.3 this
                # happens INSIDE `model.transcribe()` itself (before
                # the iterator is even returned), so the catch must
                # wrap both the call AND the for-loop.  This is not
                # an engine failure — the audio simply has no
                # detectable speech.  Treat it as a clean 0-segment
                # completion so the UI can surface "no speech
                # detected" instead of the raw internal exception.
                # Other ValueErrors still propagate.
                if "empty sequence" in str(e):
                    print(f"[debug] no speech detected (VAD returned 0 chunks): {e}", file=sys.stderr)
                else:
                    raise

            send({"event": "completed", "segmentCount": len(collected)})

        except Exception as e:
            send({"event": "failed", "error": f"Transcription error: {e}"})

    finally:
        try:
            if os.path.exists(tmp_wav):
                os.unlink(tmp_wav)
        except OSError:
            pass


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError as e:
            send({"event": "failed", "error": f"Invalid JSON: {e}"})
            continue

        cmd = msg.get("cmd")
        if cmd == "ping":
            send({"event": "pong"})
        elif cmd == "shutdown":
            break
        elif cmd == "transcribe":
            transcribe(msg)
        else:
            send({"event": "failed", "error": f"Unknown command: {cmd}"})


if __name__ == "__main__":
    main()
