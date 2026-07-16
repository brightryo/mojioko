# Blackwell (sm_120) probe — REQ-0174

Verifies REQ-0173's Blackwell support strategy against a real RTX 50-series
GPU that the owner box cannot exercise. Runs against the same pinned
faster-whisper + CTranslate2 versions the MOJIOKO sidecar ships with.

## What this answers

| # | Question | REQ-0173 assumption to confirm |
|---|---|---|
| 1 | Does `get_supported_compute_types("cuda", 0)` on Blackwell omit `int8_float16`? | Primary defense (ladder falls through to `float16`) |
| 2 | Does `WhisperModel(compute_type="float16")` complete a real transcription on Blackwell? | Sidecar's fallback compute_type actually runs |
| 3 | If `int8_float16` is unexpectedly reported as supported but crashes, **where** does it crash — init or first segment? | Determines whether RES-0173 is complete or whether a **peek-based inference-time retry** REQ is required |

**Why Check 3 matters:** RES-0173's secondary defense (float16 retry at
`WhisperModel(...)` init) only catches init-time exceptions. If Blackwell
reports `int8_float16` as supported and the crash lands on the first
segment iteration instead, the sidecar as shipped will surface a hard
`{event: failed}` — a follow-up REQ would need to add peek-based
inference-time retry. Check 3b's failure-locus verdict is the single
signal that decides the next-step scope.

## Version pinning (must match the shipped sidecar)

MOJIOKO's `python-sidecar/requirements.lock.txt` pins:

```
faster-whisper == 1.2.1
ctranslate2   == 4.8.0
```

The `pip install` step below matches those exactly.

The `ctranslate2` 4.8.x Linux wheel is a CUDA 12.4 build (per its
`Environment :: GPU :: NVIDIA CUDA :: 12 :: 12.4` classifier — same as
4.8.1). Newer major CUDA runtimes on the Pod (12.6 / 12.8) are
forward-compatible with 12.4-built binaries via the CUDA compat guarantee,
so this is fine.

## Runpod setup

1. **Choose a Pod template.** RTX 5090 preferred (24 GB VRAM,
   consumer Blackwell, sm_120). If out of stock, RTX PRO 6000 Blackwell
   (workstation SKU, same sm_120) is fully substitutable. Any Linux
   template with CUDA 12.x + Python ≥ 3.10 works; the PyTorch templates
   ship with cuDNN 9.x already installed via `nvidia-cudnn-cu12`, which
   is what CTranslate2 needs.

2. **Set the container disk to ≥ 10 GB.** The faster-whisper `tiny.en`
   download is only ~40 MB, but the PyTorch base image and pip caches
   quickly eat the default disk.

3. **Deploy.** Boot time is 30–90 seconds. Connect via the web
   terminal (**Connect → Start Web Terminal**) or SSH.

Estimated total cost: **10–20 minutes, well under 200 JPY** at
current Runpod on-demand pricing for a single RTX 5090.

## Run the probe

Inside the Pod terminal:

```bash
# 1. Sanity-check the GPU is visible.
nvidia-smi

# 2. Install the pinned sidecar stack.
#    Adding numpy explicitly in case the base image ships a version
#    incompatible with CTranslate2 4.8.0's expected numpy>=1.20 range.
python -m pip install --upgrade pip
python -m pip install \
    'faster-whisper==1.2.1' \
    'ctranslate2==4.8.0' \
    'numpy>=1.20'

# 3. Verify the installed versions match the pins.
python -c "import faster_whisper, ctranslate2; \
  print('faster_whisper', faster_whisper.__version__); \
  print('ctranslate2', ctranslate2.__version__)"
```

Expected output of step 3:

```
faster_whisper 1.2.1
ctranslate2 4.8.0
```

Then, drop `probe.py` in the current directory via a single heredoc:

```bash
cat > probe.py <<'PROBE_EOF'
#!/usr/bin/env python3
"""REQ-0174 — Blackwell (sm_120) probe for the MOJIOKO faster-whisper sidecar.

Purpose
-------
Answer three questions RES-0173 explicitly left unresolved because
the owner box (RTX 3060, Ampere) cannot exercise Blackwell code paths:

  Q1  Does `ctranslate2.get_supported_compute_types("cuda", 0)` on
      Blackwell (sm_120) omit `int8_float16` (and other int8 kernels)?
      -> confirms the REQ-0173 primary defense (ladder in _select_device)
         will actually pick float16 on real hardware.

  Q2  Does WhisperModel(device="cuda", compute_type="float16") complete a
      real transcription end-to-end on Blackwell?
      -> confirms the MOJIOKO sidecar's chosen fallback compute_type
         genuinely runs on sm_120 with the shipped ctranslate2 4.8.0.

  Q3  If int8_float16 IS reported as supported (unexpected on Blackwell)
      but crashes anyway, WHERE does it crash — at WhisperModel init, or
      on the first segment iteration?
      -> RES-0173's secondary defense (float16 retry at init) only catches
         INIT-time exceptions.  If the crash is at iteration time (i.e.
         *inference* time, once encoder kernels actually run), a
         follow-up REQ would need peek-based iteration retry.  The
         failure-locus verdict from Check 3b is what tells us whether
         REQ-0173 is complete or whether a next-tier REQ is required.

Pinning
-------
Deliberately mirrors MOJIOKO's shipped sidecar (python-sidecar/requirements.lock.txt):
  faster-whisper == 1.2.1
  ctranslate2   == 4.8.0

Both are pinned in the accompanying `pip install` (see README).  Newer
versions might behave differently (e.g. CTranslate2 4.8.1 is still CUDA
12.4 per its wheel's `Environment :: GPU :: NVIDIA CUDA :: 12 :: 12.4`
classifier, but we still probe against the exact version the installer
ships).

Runtime
-------
- Self-contained.  Generates its own audio (silent-ish sine wave), so no
  network dependency for a media file.
- Downloads `tiny.en` from HuggingFace on first WhisperModel() — Runpod
  has outbound network by default.  ~39 MB, one-time.
- Prints an easily-copyable "=== PROBE SUMMARY ===" block at the end.

Non-goals
---------
- Not a stress test, not a benchmark.  We only assert "does a single
  encoder pass complete without a CUDA/cuBLAS/cuDNN exception".
- Not testing quality — using tiny.en on a sine wave will produce
  gibberish or empty output, and that's fine.  0 segments materialized
  is a valid PASS as long as no exception was thrown during iteration.
"""

from __future__ import annotations

import subprocess
import sys
import traceback
from typing import Any


# The exact ladder from python-sidecar/main.py:273.  Kept literal so the
# probe fails loudly if MOJIOKO's ladder ever drifts.
_MOJIOKO_LADDER: tuple[str, ...] = ("int8_float16", "float16", "float32")

# Model used for the sidecar's real inference paths — kept small on
# purpose (probe target is sm_120 kernel viability, not transcription
# quality).  The compute_type code paths inside ctranslate2 are the
# same regardless of model size, so this substitution is faithful.
_PROBE_MODEL = "tiny.en"

# Compute types whose Blackwell status the summary should call out
# individually.  Anything else in the supported set will still be
# listed in the raw dump.
_CALLED_OUT_TYPES: tuple[str, ...] = (
    "int8_float16",
    "int8",
    "int8_float32",
    "int8_bfloat16",
    "float16",
    "bfloat16",
    "float32",
)


def _run_nvidia_smi() -> str:
    """Return a one-line summary of the visible GPU, or a diagnostic string."""
    try:
        out = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=name,compute_cap,driver_version",
                "--format=csv,noheader",
            ],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        if out.returncode == 0 and out.stdout.strip():
            return out.stdout.strip().replace("\n", " | ")
        return f"(nvidia-smi rc={out.returncode} stderr={out.stderr.strip()})"
    except FileNotFoundError:
        return "(nvidia-smi not on PATH)"
    except Exception as e:  # noqa: BLE001
        return f"(nvidia-smi error: {type(e).__name__}: {e})"


def _run_model(model_name: str, compute_type: str, audio) -> str:
    """Try init + one encoder/decoder pass; categorize where any failure lands.

    Return value is one of:
      OK (segments_materialized=N)                — no exception
      INIT_FAILED: <ExcType>: <first 200 chars>   — WhisperModel(...) threw
      INFERENCE_FAILED: <ExcType>: <first 200 chars> — iteration threw

    Full tracebacks are printed to stderr for the operator to include in RES-0175.
    """
    from faster_whisper import WhisperModel  # local import for clean summary if init fails

    try:
        model = WhisperModel(model_name, device="cuda", compute_type=compute_type)
    except Exception as e:  # noqa: BLE001
        print(
            f"[{compute_type}] WhisperModel init raised {type(e).__name__}:",
            file=sys.stderr,
        )
        traceback.print_exc()
        return f"INIT_FAILED: {type(e).__name__}: {str(e)[:200]}"

    try:
        segments, _info = model.transcribe(
            audio,
            language="en",
            beam_size=1,
            vad_filter=False,
        )
        # Force the encoder+decoder to actually run by pulling from the
        # segment generator.  This is where a cuBLAS/cuDNN exception on
        # a broken compute_type would surface, i.e. the "inference-time
        # failure" case RES-0173's secondary defense does NOT catch.
        seg_count = 0
        for _seg in segments:
            seg_count += 1
            if seg_count >= 1:
                break
        return f"OK (segments_materialized={seg_count})"
    except Exception as e:  # noqa: BLE001
        print(
            f"[{compute_type}] segment iteration raised {type(e).__name__}:",
            file=sys.stderr,
        )
        traceback.print_exc()
        return f"INFERENCE_FAILED: {type(e).__name__}: {str(e)[:200]}"


def _print_summary(summary: dict[str, Any]) -> None:
    print()
    print("=" * 60)
    print("=== PROBE SUMMARY ===")
    print("=" * 60)
    for k, v in summary.items():
        print(f"{k}: {v}")
    print("=" * 60)


def _interpret(summary: dict[str, Any]) -> str:
    """Give the operator a plain-language reading of the four possible worlds."""
    has_int8fp16 = summary.get("has_int8_float16")
    ladder = summary.get("ladder_selected")
    fp16 = str(summary.get("float16", ""))
    int8fp16 = str(summary.get("int8_float16", ""))

    if has_int8fp16 is False and ladder == "float16" and fp16.startswith("OK"):
        return (
            "GREEN — RES-0173 primary defense works as designed. "
            "Ladder picks float16 on Blackwell, float16 inference completes. "
            "Secondary defense not exercised (never needed to fire)."
        )
    if has_int8fp16 is True and int8fp16.startswith("INIT_FAILED") and fp16.startswith("OK"):
        return (
            "YELLOW — Blackwell reports int8_float16 as supported but init throws. "
            "RES-0173 secondary defense (float16 retry at init) DOES cover this — sidecar recovers to GPU. "
            "No follow-up REQ required."
        )
    if has_int8fp16 is True and int8fp16.startswith("INFERENCE_FAILED"):
        return (
            "RED — Blackwell reports int8_float16 as supported AND init succeeds, "
            "but the first segment iteration throws.  RES-0173's init-time retry does NOT catch this — "
            "a follow-up REQ is required to add peek-based inference-time retry."
        )
    if fp16.startswith("INIT_FAILED") or fp16.startswith("INFERENCE_FAILED"):
        return (
            "RED — float16 itself failed on Blackwell.  The MOJIOKO sidecar's fallback path "
            "does not work on this hardware.  cuda-v2 (cuBLAS 12.8) or a compute_type outside the "
            "current ladder is likely needed.  A follow-up REQ is required."
        )
    return "INCONCLUSIVE — see raw summary above; matches no expected combination."


def main() -> None:
    summary: dict[str, Any] = {}

    print("=" * 60)
    print("MOJIOKO Blackwell probe (REQ-0174)")
    print("=" * 60)

    # -----------------------------------------------------------
    # 1. Environment
    # -----------------------------------------------------------
    print("\n--- 1. Environment ---")
    gpu_line = _run_nvidia_smi()
    print(f"nvidia-smi: {gpu_line}")
    summary["gpu"] = gpu_line

    import ctranslate2
    import faster_whisper

    print(f"ctranslate2: {ctranslate2.__version__}")
    print(f"faster_whisper: {faster_whisper.__version__}")
    summary["ctranslate2"] = ctranslate2.__version__
    summary["faster_whisper"] = faster_whisper.__version__

    cuda_count = ctranslate2.get_cuda_device_count()
    print(f"ctranslate2.get_cuda_device_count(): {cuda_count}")
    summary["cuda_device_count"] = cuda_count
    if cuda_count == 0:
        print("\nFATAL: no CUDA device visible — probe cannot continue.")
        summary["result"] = "FATAL_NO_CUDA"
        _print_summary(summary)
        sys.exit(1)

    # -----------------------------------------------------------
    # 2. Check 1 — supported compute types (the API-level answer)
    # -----------------------------------------------------------
    print("\n--- 2. Check 1: supported compute types ---")
    supported = ctranslate2.get_supported_compute_types("cuda", 0)
    print(f"raw set: {sorted(supported)}")
    summary["supported_types"] = sorted(supported)
    for key in _CALLED_OUT_TYPES:
        present = key in supported
        summary[f"has_{key}"] = present
        print(f"  has {key}: {present}")

    # -----------------------------------------------------------
    # 3. Check 2 — replay MOJIOKO's _select_device ladder
    # -----------------------------------------------------------
    print("\n--- 3. Check 2: replay MOJIOKO _CUDA_COMPUTE_LADDER ---")
    print(f"ladder = {_MOJIOKO_LADDER}")
    selected = None
    for cand in _MOJIOKO_LADDER:
        if cand in supported:
            selected = cand
            break
    print(f"selected = {selected!r}")
    summary["ladder_selected"] = selected

    if selected is None:
        print(
            "\nFATAL: no ladder candidate is supported — MOJIOKO sidecar would "
            "fall to CPU on this GPU (not a Blackwell issue per se, but a probe stop)."
        )
        summary["result"] = "FATAL_NO_LADDER_CANDIDATE"
        _print_summary(summary)
        sys.exit(1)

    # -----------------------------------------------------------
    # 4. Test audio — 5 seconds of low-amplitude sine at 440 Hz.
    #    Content is irrelevant; we only need the encoder to run.
    # -----------------------------------------------------------
    print("\n--- 4. Prep test audio (5 s sine, mono, 16 kHz) ---")
    import numpy as np

    sr = 16000
    dur_s = 5.0
    t = np.linspace(0.0, dur_s, int(sr * dur_s), endpoint=False, dtype=np.float32)
    audio = (0.05 * np.sin(2.0 * np.pi * 440.0 * t)).astype(np.float32)
    print(f"audio: shape={audio.shape} dtype={audio.dtype} sr={sr}")

    # -----------------------------------------------------------
    # 5a. Check 3a — float16 end-to-end
    # -----------------------------------------------------------
    print(f"\n--- 5a. Check 3a: float16 end-to-end on '{_PROBE_MODEL}' ---")
    fp16_result = _run_model(_PROBE_MODEL, "float16", audio)
    print(f"float16 verdict: {fp16_result}")
    summary["float16"] = fp16_result

    # -----------------------------------------------------------
    # 5b. Check 3b — int8_float16 failure-locus probe
    #     Deliberately runs even if Check 1 already said int8_float16
    #     is not in the supported set: on some drivers ctranslate2 will
    #     accept the argument and only die later, which is itself
    #     informative.
    # -----------------------------------------------------------
    print(f"\n--- 5b. Check 3b: int8_float16 failure-locus probe on '{_PROBE_MODEL}' ---")
    int8fp16_result = _run_model(_PROBE_MODEL, "int8_float16", audio)
    print(f"int8_float16 verdict: {int8fp16_result}")
    summary["int8_float16"] = int8fp16_result

    # -----------------------------------------------------------
    # 6. Summary + human interpretation
    # -----------------------------------------------------------
    summary["interpretation"] = _interpret(summary)
    _print_summary(summary)


if __name__ == "__main__":
    main()
PROBE_EOF
```

The heredoc opener `<<'PROBE_EOF'` uses single quotes deliberately —
that disables all shell expansion so every `$`, backtick, and `\` inside
the probe stays literal.

Then run:

```bash
python probe.py
```

Total wall time on RTX 5090: ~1–2 minutes (mostly the one-time HuggingFace
download of `tiny.en`).

## Report back

Copy **everything** from the `=== PROBE SUMMARY ===` line through the
closing `===` line, plus any stderr traceback that appeared during the
run, and paste into RES-0175.

Example expected shape on Blackwell if REQ-0173's primary defense is
sufficient:

```
=== PROBE SUMMARY ===
============================================================
gpu: NVIDIA GeForce RTX 5090, 12.0, 570.xx.xx
ctranslate2: 4.8.0
faster_whisper: 1.2.1
cuda_device_count: 1
supported_types: ['bfloat16', 'float16', 'float32']
has_int8_float16: False
has_int8: False
has_int8_float32: False
has_int8_bfloat16: False
has_float16: True
has_bfloat16: True
has_float32: True
ladder_selected: float16
float16: OK (segments_materialized=1)
int8_float16: INIT_FAILED: ValueError: Requested int8_float16 is not supported ...
interpretation: GREEN — RES-0173 primary defense works as designed. ...
============================================================
```

Any of the other three shapes the `_interpret` function can return
(`YELLOW`, `RED`, `INCONCLUSIVE`) also count as a valid outcome — they
just point at different next-step REQs.

## Cost hygiene — Terminate, do not Stop

**When done, use "Terminate" from the Runpod dashboard, not "Stop".**

- **Stop** pauses the GPU billing but keeps container storage billed at
  ~$0.10/GB/month indefinitely. It's easy to forget a stopped Pod.
- **Terminate** deletes the container and the storage — no residual
  billing.

This probe is fully reproducible from this file, so there is no reason
to keep a stopped Pod around.

## If something goes wrong

- **`nvidia-smi` returns nothing** → wrong template chosen (CPU-only
  Pod). Redeploy on a Blackwell GPU template.
- **`WhisperModel(...)` raises `ImportError` about `libcudnn.so.9`** →
  the base image is CUDA-only without cuDNN 9. Add
  `pip install 'nvidia-cudnn-cu12>=9.5,<10'` and re-run.
- **HuggingFace download times out** → Runpod's `HF_HUB_OFFLINE=1` is
  set on some templates. Unset it: `unset HF_HUB_OFFLINE`.
- **`ctranslate2` install fails with a wheel not found** → Python
  version too old or too new. Confirm `python --version` reports 3.10,
  3.11, or 3.12. If it reports 3.13, either switch template or
  `pyenv install 3.11 && pyenv shell 3.11`.

## Files

- `probe.py` — probe body, tracked in the repo.
- `README.md` — this file.

The probe body is duplicated inside this README's heredoc for
copy-paste convenience. If you edit `probe.py`, also update the
heredoc block above (or point the operator at the tracked file).
