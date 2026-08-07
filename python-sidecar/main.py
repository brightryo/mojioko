#!/usr/bin/env python3
"""MOJIOKO transcription sidecar — faster-whisper transcription engine. JSON-line protocol over stdin/stdout."""
import sys
import json
import os
import subprocess
import tempfile
import shutil
from pathlib import Path


# REQ-0147 / REQ-0412 — pre-load the bundled CUDA/cuDNN runtime DLLs in
# dependency order BEFORE `import ctranslate2` ever runs.  The full rationale
# (Toolkit-less GPU failure, ctranslate2's bare `LoadLibrary("cublas64_12.dll")`,
# the loaded-modules-cache fix) lives in `gpu_dll.py`, which is now SHARED with
# the translation sidecar (`translate.py`) so both resolve CUDA identically.
#
# Runs at module import so it's finished before `_select_device()` or any
# faster-whisper machinery.  On non-Windows, when the env var is unset, or when
# the folder is empty (the "GPU tools not downloaded yet" state) this is a
# silent no-op and the runtime falls through to CPU via `_select_device()`.
from gpu_dll import preload_bundled_cuda_dlls  # noqa: E402

preload_bundled_cuda_dlls()


# REQ-0215 — device-selection guard.  Pure predicate over `os.environ` so
# unit tests can pin the truth table without importing ctranslate2 or
# spawning a subprocess.  See RES-0214 for the full failure narrative
# this fixes; the short version is that `_select_device()` used to probe
# CUDA via `ctranslate2.get_cuda_device_count()`, which returns >0 on
# any machine with an NVIDIA driver — even when the main process
# deliberately withheld `MOJIOKO_GPU_TOOL_DIR` because the user picked
# the CPU card (or the GPU tools aren't downloaded yet).  Selecting
# CUDA in that state made `WhisperModel(device="cuda")` init hit
# `LoadLibrary("cublas64_12.dll")` and fail hard.
#
# The contract with the main process (src/main/services/gpu-tool.ts's
# `getEffectiveGpuToolDir`) is now: **absence of `MOJIOKO_GPU_TOOL_DIR`
# means CPU-only**.  It is set only when the GPU tools are installed
# AND the user has picked the GPU card.  Presence therefore doubles as
# "GPU authorized + CUDA DLL search path pre-loaded"; absence means
# "do not probe CUDA at all, do not pass Go, return CPU."
def _cpu_forced_by_missing_gpu_env() -> bool:
    """Return True when `MOJIOKO_GPU_TOOL_DIR` is unset, empty, or
    whitespace-only — the marker that the main process wants CPU
    execution.  Treats "set-but-blank" identically to "unset" so a
    stray empty-string leak from the env layer cannot accidentally
    permit CUDA probing.
    """
    val = os.environ.get("MOJIOKO_GPU_TOOL_DIR", "")
    return not val.strip()


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
        #
        # REQ-0173 primary defense — ask CTranslate2 which compute types
        # the GPU actually supports on this build, then pick the fastest
        # supported entry from a priority ladder.  Blackwell (sm_120)
        # crashes cuBLAS with CUBLAS_STATUS_NOT_SUPPORTED when it hits
        # the shipped 12.6 int8 kernels because the new INT8 tensor
        # cores require a different memory-padding layout.  On such
        # cards `get_supported_compute_types("cuda", 0)` is expected
        # to omit int8_float16 (and int8*), so the ladder falls
        # through to float16 — the compute type Purfview / Subtitle
        # Edit's Blackwell reference build uses with the same
        # ctranslate2 4.x runtime and confirms works.  Ampere / Ada
        # keep int8_float16 in the set → byte-identical to pre-0173
        # behaviour on RTX 20/30/40.
        _CUDA_COMPUTE_LADDER: tuple[str, ...] = ("int8_float16", "float16", "float32")

        def _select_device() -> tuple[str, str]:
            # REQ-0215 — honour the main process's device intent.  When
            # `MOJIOKO_GPU_TOOL_DIR` is unset, the user picked CPU (or has
            # not downloaded the GPU tools yet) and the CUDA DLL search
            # path was deliberately withheld.  Probing CUDA in that state
            # produces the RES-0214 failure: NVIDIA driver presence flips
            # `get_cuda_device_count()` to >0, we return "cuda", then
            # `WhisperModel(device="cuda")` init hits an unresolvable
            # `LoadLibrary("cublas64_12.dll")` and crashes the transcribe
            # command.  Short-circuit here so the CUDA path is never
            # entered and the CPU fallback below is only reached via the
            # legitimate "probed CUDA and it declined" branch.
            if _cpu_forced_by_missing_gpu_env():
                print("[device] MOJIOKO_GPU_TOOL_DIR unset — forcing CPU (REQ-0215)",
                      file=sys.stderr)
                return "cpu", "int8"
            try:
                import ctranslate2  # type: ignore[import]
                if ctranslate2.get_cuda_device_count() > 0:
                    supported = ctranslate2.get_supported_compute_types("cuda", 0)
                    for candidate in _CUDA_COMPUTE_LADDER:
                        if candidate in supported:
                            print(f"[device] supported cuda compute_types={sorted(supported)} "
                                  f"selected={candidate}",
                                  file=sys.stderr)
                            return "cuda", candidate
                    # Empty ladder — falls through to CPU
                    print(f"[device] no cuda compute type in ladder is supported "
                          f"(supported={sorted(supported)}); falling back to CPU",
                          file=sys.stderr)
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

        # REQ-0173 secondary defense — even if `_select_device` reports
        # int8_float16 as supported, cuBLAS may still throw
        # CUBLAS_STATUS_NOT_SUPPORTED at WhisperModel init on Blackwell
        # (the API's reported support and the runtime library's actual
        # capability can disagree on brand-new architectures).  Retry
        # the init once with float16 before the REQ-0145 CPU fallback
        # kicks in, so a Blackwell user whose supported set incorrectly
        # includes int8_float16 still lands on GPU rather than
        # silently going CPU.  On success we override `actual_compute`
        # but keep `actual_device = "cuda"` and `fell_back = False`
        # — the run genuinely used the GPU.
        model = None
        init_err: Exception | None = None
        try:
            model = WhisperModel(str(model_dir), device=requested_device, compute_type=requested_compute)
        except Exception as e:
            init_err = e
            print(f"[device] initial attempt device={requested_device} "
                  f"compute_type={requested_compute} init failed "
                  f"({type(e).__name__}: {e})",
                  file=sys.stderr)

            if requested_device == "cuda" and requested_compute != "float16":
                print("[device] REQ-0173 secondary defense: retrying CUDA with compute_type=float16",
                      file=sys.stderr)
                try:
                    model = WhisperModel(str(model_dir), device="cuda", compute_type="float16")
                    actual_compute = "float16"
                    init_err = None
                    print("[device] float16 retry succeeded — staying on GPU",
                          file=sys.stderr)
                except Exception as e2:
                    print(f"[device] float16 retry also failed "
                          f"({type(e2).__name__}: {e2})",
                          file=sys.stderr)
                    init_err = e2

            # REQ-0145 §2 — if we STILL don't have a working model and
            # we started on CUDA, fall through to CPU.  This preserves
            # pre-REQ-0173 behaviour for machines where every CUDA
            # attempt genuinely failed (missing cuDNN, driver mismatch,
            # OOM, etc.).
            if model is None and requested_device != "cpu":
                print("[device] falling back to device=cpu compute_type=int8",
                      file=sys.stderr)
                try:
                    model = WhisperModel(str(model_dir), device="cpu", compute_type="int8")
                    actual_device = "cpu"
                    actual_compute = "int8"
                    fell_back = True
                except Exception as e3:
                    send({"event": "failed", "error": f"Failed to load model: {e3}"})
                    return
            elif model is None:
                # requested_device was already "cpu" (no GPU / probe failed)
                # and the CPU init also failed — nothing else to try.
                send({"event": "failed", "error": f"Failed to load model: {init_err}"})
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
            # REQ-0207 — experimental word-level subtitle re-split.
            # Off (default / missing / falsy) is the ONLY path v1.3.3 users
            # exercise; the branch below therefore must produce a
            # transcribe_kwargs dict, an iterator loop and a segment event
            # stream BYTE-IDENTICAL to the pre-REQ-0207 code path.
            word_subtitle: bool = bool(msg.get("wordSubtitle", False))

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
            # REQ-0285 — request per-word timestamps ALWAYS (was previously
            # gated on `word_subtitle` per REQ-0207).  The word data flows
            # through as an optional `words` field on each segment event so
            # renderers that don't consume it (pre-REQ-0285 builds, or the
            # default word-subtitle-off code path) still work byte-identically
            # at the receiving end.
            #
            # Cost impact (faster-whisper docs + REQ-0207 shipping observation):
            # ~10-25 % transcribe-time overhead vs. the pre-REQ-0285 default.
            # The cost buys the Phase B feature surface (karaoke fill /
            # keyword highlight / speaking-word pill) unconditionally — no
            # runtime toggle, no coordination between renderer UI and IPC
            # payload.  If a future REQ needs to disable it (e.g. very long
            # audio + CPU-only + tight timing), reintroduce a flag here.
            transcribe_kwargs["word_timestamps"] = True

            def _serialize_words(words):
                """REQ-0285 — convert a faster-whisper `.words` iterable into
                the IPC `words` array shape: `[{startSec, endSec, text}, ...]`.
                Handles the rare None-timed word case per RES-0205 §6.5 by
                folding into a zero-duration span at 0.0 (defensive; the
                renderer's validity helper will re-check).  `text` keeps
                faster-whisper's leading space so downstream re-tokenisation
                is possible if ever needed.
                """
                out = []
                for w in words or ():
                    start = w.start if w.start is not None else 0.0
                    end = w.end if w.end is not None else start
                    out.append({
                        "startSec": start,
                        "endSec": end,
                        "text": w.word,
                    })
                return out

            def _bucket_words_into_cues(cues, words):
                """REQ-0285 — for the REQ-0207 resplit path (word_subtitle=True),
                distribute the flat `seg.words` list across the multiple
                sub-cues that `resplit_segment` produced.  A word is assigned
                to the cue whose time window contains its start; words that
                fall in a gap between cues (rare, from the resplit's silence-
                gap boundary) are attached to the nearest cue by edge
                distance — Phase B validity checks will just fall back to
                "no per-word render" on those pathological cases.
                """
                buckets = [[] for _ in cues]
                if not cues or not words:
                    return buckets
                for w in words:
                    w_start = w.start if w.start is not None else 0.0
                    placed = False
                    for i, c in enumerate(cues):
                        if c.startSec <= w_start <= c.endSec:
                            buckets[i].append(w)
                            placed = True
                            break
                    if not placed:
                        best = 0
                        best_dist = float('inf')
                        for i, c in enumerate(cues):
                            d = min(abs(c.startSec - w_start), abs(c.endSec - w_start))
                            if d < best_dist:
                                best = i
                                best_dist = d
                        buckets[best].append(w)
                return buckets

            collected = []
            try:
                segments_iter, info = model.transcribe(tmp_wav, **transcribe_kwargs)
                total_duration = info.duration if info.duration else 0.0
                # REQ-0457 A3 — surface the language faster-whisper actually
                # detected (info.language) so an agent can tell whether the
                # karaoke/translate preconditions match, instead of only the
                # requested value.  Absent on pre-REQ-0457 bundled exes; the
                # main side falls back to the requested language then.
                detected_language = getattr(info, "language", None)
                send({
                    "event": "started",
                    "totalDurationSec": total_duration,
                    "language": detected_language,
                })

                for i, seg in enumerate(segments_iter):
                    print(f"[debug] segment {i}: start={seg.start:.3f}, end={seg.end:.3f}, text={seg.text.strip()!r}", file=sys.stderr)
                    collected.append(seg)
                    if word_subtitle and seg.words:
                        # REQ-0207 — run the pure re-split helper and emit
                        # each resulting cue through the SAME `segment` IPC
                        # shape the renderer already consumes.  Callers see
                        # "more segments, same schema."  Import is lazy so
                        # a startup import failure in word_split.py does not
                        # affect the default path (which never touches it).
                        # REQ-0285 — additionally bucket `seg.words` into the
                        # emitted sub-cues so each carries its share (optional
                        # `words` field on the IPC).
                        from word_split import resplit_segment
                        cues = resplit_segment(seg.start, seg.words)
                        cue_words = _bucket_words_into_cues(cues, seg.words)
                        for cue, bucket in zip(cues, cue_words):
                            send({
                                "event": "segment",
                                "segment": {
                                    "startSec": cue.startSec,
                                    "endSec": cue.endSec,
                                    "text": cue.text,
                                    "words": _serialize_words(bucket),
                                },
                            })
                    else:
                        # REQ-0285 — default path also attaches words now.
                        # `seg.words` may be empty when the segment contained
                        # no speech (silence-only fragment); serialize_words
                        # tolerates None / empty and returns [].  Renderers
                        # treat empty words as "no per-word data".
                        send({
                            "event": "segment",
                            "segment": {
                                "startSec": seg.start,
                                "endSec": seg.end,
                                "text": seg.text.strip(),
                                "words": _serialize_words(seg.words),
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
