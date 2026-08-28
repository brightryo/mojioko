"""REQ-0410 — minimal resident MADLAD-400 translation sidecar (prototype).

Reads one JSON request per line on stdin, writes one JSON response per line on
stdout (both UTF-8, flushed).  The CTranslate2 model + SentencePiece tokenizer
are loaded ONCE, lazily, on the first translate request and kept resident; the
first response carries a non-zero `loadMs` so the UI can tell cold from warm.

Environment:
  MOJIOKO_TRANSLATION_MODEL_DIR   directory of the active tool (contains
                                  model.bin, spiece.model, …)
  MOJIOKO_TRANSLATION_DEVICE      'cpu' (default) or 'cuda'
  MOJIOKO_GPU_TOOL_DIR            (optional) folder of CUDA DLLs for device=cuda

Protocol:
  request  {"id": <n>, "text": "...", "target": "en"}   or   {"id": <n>, "cmd": "ping"}
  response {"id": <n>, "ok": true,  "text": "...", "loadMs": <int>, "translateMs": <int>}
           {"id": <n>, "ok": false, "error": "..."}

Non-persisted: this process holds no state beyond the loaded model; the caller
never writes the translation anywhere durable (REQ-0410 is a prototype).
"""
import sys
import os
import json
import time

sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")

MODEL_DIR = os.environ.get("MOJIOKO_TRANSLATION_MODEL_DIR", "")
DEVICE = os.environ.get("MOJIOKO_TRANSLATION_DEVICE", "cpu")

# REQ-0412 — resolve the bundled CUDA/cuDNN DLLs BEFORE ctranslate2 is imported
# (which happens lazily inside `_ensure_loaded`).  Shared with the Whisper
# sidecar (`gpu_dll.py`): an ordered absolute-path preload — NOT a bare
# `os.add_dll_directory` — is what makes ctranslate2's internal
# `LoadLibrary("cublas64_12.dll")` resolve on Toolkit-less machines.  No-op when
# MOJIOKO_GPU_TOOL_DIR is unset (the CPU path).
from gpu_dll import preload_bundled_cuda_dlls

preload_bundled_cuda_dlls()

_translator = None
_sp = None
_active_device = "cpu"


def _emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _ensure_loaded():
    """Load the model + tokenizer once.  Returns load time in ms (0 if warm)."""
    global _translator, _sp, _active_device
    if _translator is not None:
        return 0
    import ctranslate2  # noqa: PLC0415
    import sentencepiece as spm  # noqa: PLC0415

    t0 = time.perf_counter()
    # Load the tokenizer first so the warm-up translate below can build a real
    # source sequence.
    sp = spm.SentencePieceProcessor()
    sp.Load(os.path.join(MODEL_DIR, "spiece.model"))

    def _build(device):
        # REQ-0412 — build AND warm up: run one tiny translate so the CUDA GEMM
        # path (and thus the cuBLAS DLL resolution) executes NOW, during load.
        # ctranslate2 constructs a `Translator(device="cuda")` lazily and only
        # touches cuBLAS at the first GEMM; without this warm-up a missing
        # `cublas64_12.dll` would slip past the try/except below and surface
        # much later as a per-request SIDECAR_ERROR.  Warming up here means any
        # device/DLL failure is caught where the CPU fallback can handle it.
        tr = ctranslate2.Translator(MODEL_DIR, device=device)
        warm = sp.encode("<2en> ok", out_type=str)
        tr.translate_batch([warm], beam_size=1)
        return tr

    requested = DEVICE if DEVICE in ("cpu", "cuda") else "cpu"
    try:
        translator = _build(requested)
        _active_device = requested
    except Exception as e:  # noqa: BLE001 — CUDA missing / DLL / OOM → CPU
        if requested != "cpu":
            print(f"[translate] device={requested} load failed ({e}); falling back to CPU",
                  file=sys.stderr)
            translator = _build("cpu")
            _active_device = "cpu"
        else:
            raise
    _translator = translator
    _sp = sp
    print(f"[translate] model loaded on device={_active_device}", file=sys.stderr)
    return int((time.perf_counter() - t0) * 1000)


# REQ-0438 — decode options shared by both translate paths.  Short inputs
# ("ありがとう。" etc.) could send MADLAD into a repetition loop
# ("Thank you, thank you, thank you."); `no_repeat_ngram_size=3` forbids
# repeating any 3-token span (the primary fix) and a mild `repetition_penalty`
# discourages token loops without hurting normal translation quality.  Tunable.
_DECODE_KWARGS = dict(beam_size=1, no_repeat_ngram_size=3, repetition_penalty=1.1)


def _translate(text, target):
    load_ms = _ensure_loaded()
    t0 = time.perf_counter()
    # MADLAD-400: the target language is a `<2xx>` token prefixed onto the source.
    source = _sp.encode(f"<2{target}> {text}", out_type=str)
    results = _translator.translate_batch([source], **_DECODE_KWARGS)
    out = _sp.decode(results[0].hypotheses[0])
    translate_ms = int((time.perf_counter() - t0) * 1000)
    return out, load_ms, translate_ms


def _translate_batch(texts, target):
    # REQ-0430 — bulk translate: encode every source with its `<2xx>` prefix and
    # run them through CTranslate2's translate_batch in one call.
    load_ms = _ensure_loaded()
    t0 = time.perf_counter()
    sources = [_sp.encode(f"<2{target}> {tx}", out_type=str) for tx in texts]
    results = _translator.translate_batch(sources, **_DECODE_KWARGS) if sources else []
    outs = [_sp.decode(r.hypotheses[0]) for r in results]
    translate_ms = int((time.perf_counter() - t0) * 1000)
    return outs, load_ms, translate_ms


def main():
    if not MODEL_DIR:
        _emit({"id": None, "ok": False, "error": "MOJIOKO_TRANSLATION_MODEL_DIR not set"})
    _emit({"event": "ready"})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:  # noqa: BLE001
            continue
        rid = req.get("id")
        if req.get("cmd") == "ping":
            _emit({"id": rid, "ok": True, "pong": True})
            continue
        if req.get("cmd") == "selftest":
            # REQ-0494 — model-free proof that the translation runtime is present
            # in THIS bundle: import the two deps that were missing in the
            # pre-REQ-0494 packaged build (ctranslate2 comes from faster-whisper;
            # sentencepiece is the net-new collect).  The packaged smoke gate
            # (scripts/verify-translate-packaged.mjs) asserts this reply so a
            # regression cannot slip past without a model installed.
            try:
                import ctranslate2  # noqa: PLC0415
                import sentencepiece  # noqa: PLC0415,F401
                _emit({"id": rid, "ok": True, "selftest": True,
                       "ct2": getattr(ctranslate2, "__version__", "?"), "spm": True})
            except Exception as e:  # noqa: BLE001
                _emit({"id": rid, "ok": False, "error": f"selftest import failed: {e}"})
            continue
        try:
            target = req.get("target", "en") or "en"
            if isinstance(req.get("texts"), list):
                # REQ-0430 — bulk translate: a list of sources → a list of outputs.
                outs, load_ms, translate_ms = _translate_batch(req.get("texts") or [], target)
                _emit({"id": rid, "ok": True, "texts": outs, "loadMs": load_ms, "translateMs": translate_ms})
            else:
                text = req.get("text", "") or ""
                out, load_ms, translate_ms = _translate(text, target)
                _emit({"id": rid, "ok": True, "text": out, "loadMs": load_ms, "translateMs": translate_ms})
        except Exception as e:  # noqa: BLE001
            _emit({"id": rid, "ok": False, "error": str(e)})


if __name__ == "__main__":
    main()
