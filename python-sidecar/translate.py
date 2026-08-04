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
GPU_DIR = os.environ.get("MOJIOKO_GPU_TOOL_DIR")

if DEVICE == "cuda" and GPU_DIR and os.path.isdir(GPU_DIR):
    # Best-effort: let ctranslate2's LoadLibrary find the bundled CUDA DLLs.
    try:
        os.add_dll_directory(GPU_DIR)  # type: ignore[attr-defined]
    except Exception as e:  # noqa: BLE001
        print(f"[translate] add_dll_directory failed: {e}", file=sys.stderr)

_translator = None
_sp = None


def _emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _ensure_loaded():
    """Load the model + tokenizer once.  Returns load time in ms (0 if warm)."""
    global _translator, _sp
    if _translator is not None:
        return 0
    import ctranslate2  # noqa: PLC0415
    import sentencepiece as spm  # noqa: PLC0415

    t0 = time.perf_counter()
    dev = DEVICE
    try:
        translator = ctranslate2.Translator(MODEL_DIR, device=dev)
    except Exception as e:  # noqa: BLE001 — CUDA missing / OOM → fall back to CPU
        print(f"[translate] device={dev} failed ({e}); falling back to CPU", file=sys.stderr)
        translator = ctranslate2.Translator(MODEL_DIR, device="cpu")
    sp = spm.SentencePieceProcessor()
    sp.Load(os.path.join(MODEL_DIR, "spiece.model"))
    _translator = translator
    _sp = sp
    return int((time.perf_counter() - t0) * 1000)


def _translate(text, target):
    load_ms = _ensure_loaded()
    t0 = time.perf_counter()
    # MADLAD-400: the target language is a `<2xx>` token prefixed onto the source.
    source = _sp.encode(f"<2{target}> {text}", out_type=str)
    results = _translator.translate_batch([source], beam_size=1)
    out = _sp.decode(results[0].hypotheses[0])
    translate_ms = int((time.perf_counter() - t0) * 1000)
    return out, load_ms, translate_ms


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
        try:
            text = req.get("text", "") or ""
            target = req.get("target", "en") or "en"
            out, load_ms, translate_ms = _translate(text, target)
            _emit({"id": rid, "ok": True, "text": out, "loadMs": load_ms, "translateMs": translate_ms})
        except Exception as e:  # noqa: BLE001
            _emit({"id": rid, "ok": False, "error": str(e)})


if __name__ == "__main__":
    main()
