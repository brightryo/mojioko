"""REQ-0215 — unit tests for the sidecar's CPU-force guard.

Two layers of coverage:

  1. **Pure predicate** (`_cpu_forced_by_missing_gpu_env`) — exhaust the
     truth table for `MOJIOKO_GPU_TOOL_DIR` values.  Fast, no I/O, no
     dependencies on ctranslate2.

  2. **Process-level guard** — spawn the sidecar Python entry point with
     controlled `MOJIOKO_GPU_TOOL_DIR` env values and inspect stderr.
     This is the load-bearing check for the fix: with the env var
     unset, the sidecar must NOT emit any of the CUDA-probe stderr
     lines (which would indicate `ctranslate2.get_cuda_device_count()`
     ran).  Uses a fake transcribe payload that fails at the
     audio-extract phase — enough to force `_select_device()` to run
     but cheap because we never reach the WhisperModel init.

Runnable via
`.venv\\Scripts\\python.exe -m unittest python-sidecar/test_select_device.py`
from the repo root, matching the existing `test_word_split.py` style.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
import wave
from unittest import mock

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

# Import the module under test.  This will run `_preload_bundled_cuda_dlls()`
# once at import time, which is a no-op in this test process because we do
# not set MOJIOKO_GPU_TOOL_DIR before importing.
import main  # noqa: E402


class CpuForcedPredicateTests(unittest.TestCase):
    """Truth table for the pure `_cpu_forced_by_missing_gpu_env` guard."""

    def test_unset_returns_true(self) -> None:
        with mock.patch.dict(os.environ, {}, clear=False) as env:
            env.pop("MOJIOKO_GPU_TOOL_DIR", None)
            self.assertTrue(main._cpu_forced_by_missing_gpu_env())

    def test_empty_string_returns_true(self) -> None:
        with mock.patch.dict(os.environ, {"MOJIOKO_GPU_TOOL_DIR": ""}):
            self.assertTrue(main._cpu_forced_by_missing_gpu_env())

    def test_whitespace_only_returns_true(self) -> None:
        # "   " and "\t\n" both count as "not really set"; the strip()
        # in the predicate exists exactly for this — a stray whitespace
        # leak from the env layer must not permit CUDA probing.
        for spaces in ("   ", "\t", "\n", " \t\n "):
            with self.subTest(env_value=repr(spaces)):
                with mock.patch.dict(os.environ, {"MOJIOKO_GPU_TOOL_DIR": spaces}):
                    self.assertTrue(main._cpu_forced_by_missing_gpu_env())

    def test_valid_path_returns_false(self) -> None:
        # A real path (even a non-existent one — the predicate does not
        # touch the filesystem; existence is checked separately inside
        # `_preload_bundled_cuda_dlls()`).
        with mock.patch.dict(os.environ, {"MOJIOKO_GPU_TOOL_DIR": r"C:\mojioko-fixture\gpu-tools\cuda-v1"}):
            self.assertFalse(main._cpu_forced_by_missing_gpu_env())

    def test_leading_trailing_whitespace_ignored(self) -> None:
        # A leaked leading/trailing space around an otherwise-valid path
        # should still count as "set" — strip() only rejects entirely-
        # blank values.
        with mock.patch.dict(os.environ, {"MOJIOKO_GPU_TOOL_DIR": "  C:\\gpu  "}):
            self.assertFalse(main._cpu_forced_by_missing_gpu_env())


def _write_silent_wav(path: str, seconds: float = 0.1) -> None:
    """Create a mono 16 kHz 16-bit PCM WAV of `seconds` silence.
    Enough to satisfy `extract_audio()`'s ffmpeg pass so the sidecar
    reaches `_select_device()` — which is what these tests need to
    observe.  Kept out of any repo fixture directory (per-test tmp).
    """
    n_frames = int(16_000 * seconds)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16_000)
        w.writeframes(b"\x00\x00" * n_frames)


def _bundled_ffmpeg_path() -> str:
    """Absolute path to the bundled ffmpeg the app ships with.  Under
    normal dev layout that is `<repo>/resources/bin/ffmpeg/ffmpeg.exe`.
    """
    repo_root = os.path.abspath(os.path.join(_HERE, ".."))
    return os.path.join(repo_root, "resources", "bin", "ffmpeg", "ffmpeg.exe")


def _spawn_sidecar(env_override: dict[str, str | None]) -> subprocess.CompletedProcess[str]:
    """Spawn the sidecar via `.venv` Python with a one-shot transcribe
    request that succeeds through audio extraction and reaches
    `_select_device()`, then fails at WhisperModel init (the
    modelsDir is a scratch path that has no model files).  We only
    care about the stderr lines that appear before the model init
    fails — specifically, whether the CUDA probe was entered.

    Inputs:
      - a per-test silent WAV file
      - the bundled ffmpeg the app ships with
      - a nonexistent modelsDir (WhisperModel will raise inside
        ctranslate2 — but only AFTER `_select_device()` has run)

    Returns CompletedProcess with stdout/stderr for assertions.
    """
    env = os.environ.copy()
    env.setdefault("PYTHONIOENCODING", "utf-8")
    env.setdefault("PYTHONUTF8", "1")
    for k, v in env_override.items():
        if v is None:
            env.pop(k, None)
        else:
            env[k] = v

    main_py = os.path.join(_HERE, "main.py")
    ffmpeg = _bundled_ffmpeg_path()

    with tempfile.TemporaryDirectory() as td:
        wav_path = os.path.join(td, "silent.wav")
        _write_silent_wav(wav_path)
        # `transcribe()` (main.py) exits early with a `needsDownload`
        # event if `<modelsDir>/<model>/` is not an existing directory.
        # We create an empty stub directory so the check passes; the
        # WhisperModel init later fails because there are no model
        # files inside, but that happens AFTER `_select_device()` has
        # fired — which is exactly what these tests need to observe.
        model_id = "large-v3-turbo"
        os.makedirs(os.path.join(td, model_id), exist_ok=True)
        payload = {
            "cmd": "transcribe",
            "videoPath": wav_path,
            "trackIndex": 0,
            "model": model_id,
            "modelsDir": td,
            "ffmpegPath": ffmpeg,
            "vadFilter": True,
            "vadThreshold": 0.5,
            "minSpeechDurationMs": 250,
            "minSilenceDurationMs": 2000,
            "beamSize": 5,
            "language": "auto",
        }
        return subprocess.run(
            [sys.executable, main_py],
            input=json.dumps(payload) + "\n",
            capture_output=True,
            # Force UTF-8 for both directions.  The sidecar writes UTF-8
            # stderr (its `[device]` log line contains an em dash), but
            # subprocess.run's default codec on a Japanese-locale Windows
            # host is cp932, which can't decode 0x94 and reports stderr
            # as None.  `PYTHONIOENCODING`/`PYTHONUTF8` in the child env
            # already covers the child side; `encoding=` covers the
            # parent side.
            encoding="utf-8",
            errors="replace",
            env=env,
            timeout=60,
        )


class SelectDeviceProcessTests(unittest.TestCase):
    """Spawn-the-sidecar checks that verify the CUDA probe is not
    entered when `MOJIOKO_GPU_TOOL_DIR` is unset.  These are the
    load-bearing tests for the REQ-0215 fix: the pure predicate above
    only proves the input/output mapping; these prove that the whole
    device-selection code path honours it in practice.
    """

    def _assert_cuda_probe_did_not_run(self, stderr: str) -> None:
        """The CUDA probe emits distinctive stderr strings.  None of
        them should appear when the guard fires."""
        forbidden = (
            "supported cuda compute_types=",     # ladder-hit branch
            "no cuda compute type in ladder",    # ladder-empty branch
            "CUDA probe failed:",                # exception branch
        )
        for needle in forbidden:
            self.assertNotIn(
                needle, stderr,
                msg=f"CUDA probe emitted forbidden stderr line {needle!r} "
                    f"while MOJIOKO_GPU_TOOL_DIR was unset. Full stderr:\n{stderr}",
            )

    def test_env_unset_skips_cuda_probe(self) -> None:
        proc = _spawn_sidecar({"MOJIOKO_GPU_TOOL_DIR": None})
        # The guard's log line must appear.
        self.assertIn(
            "MOJIOKO_GPU_TOOL_DIR unset — forcing CPU (REQ-0215)",
            proc.stderr,
            msg=f"Guard log line missing. stderr:\n{proc.stderr}",
        )
        self._assert_cuda_probe_did_not_run(proc.stderr)

    def test_env_empty_string_skips_cuda_probe(self) -> None:
        proc = _spawn_sidecar({"MOJIOKO_GPU_TOOL_DIR": ""})
        self.assertIn(
            "MOJIOKO_GPU_TOOL_DIR unset — forcing CPU (REQ-0215)",
            proc.stderr,
            msg=f"Guard log line missing. stderr:\n{proc.stderr}",
        )
        self._assert_cuda_probe_did_not_run(proc.stderr)

    def test_env_whitespace_only_skips_cuda_probe(self) -> None:
        proc = _spawn_sidecar({"MOJIOKO_GPU_TOOL_DIR": "   "})
        self.assertIn(
            "MOJIOKO_GPU_TOOL_DIR unset — forcing CPU (REQ-0215)",
            proc.stderr,
            msg=f"Guard log line missing. stderr:\n{proc.stderr}",
        )
        self._assert_cuda_probe_did_not_run(proc.stderr)

    def test_env_set_runs_cuda_probe(self) -> None:
        # Point at a non-existent folder — the preload treats that as
        # "not downloaded yet", but the guard sees a set value and lets
        # `_select_device()` proceed to the CUDA probe.  On a machine
        # with the NVIDIA driver present the probe returns >0 and we
        # get a `supported cuda compute_types=` line.  On a CI runner
        # with no NVIDIA driver the probe throws and we get a
        # `CUDA probe failed:` line.  Either proves the guard did NOT
        # short-circuit.
        proc = _spawn_sidecar(
            {"MOJIOKO_GPU_TOOL_DIR": r"C:\mojioko-fixture-does-not-exist"},
        )
        self.assertNotIn(
            "MOJIOKO_GPU_TOOL_DIR unset — forcing CPU (REQ-0215)",
            proc.stderr,
            msg=f"Guard log line unexpectedly fired for a SET env. stderr:\n{proc.stderr}",
        )
        # One of the two CUDA-probe outcomes must have been emitted.
        # (`get_cuda_device_count() > 0` route OR probe-failed route.)
        probed = (
            "supported cuda compute_types=" in proc.stderr
            or "CUDA probe failed:" in proc.stderr
            or "no cuda compute type in ladder" in proc.stderr
        )
        self.assertTrue(
            probed,
            msg=f"CUDA probe expected to run but no probe stderr line found. stderr:\n{proc.stderr}",
        )


if __name__ == "__main__":
    unittest.main()
