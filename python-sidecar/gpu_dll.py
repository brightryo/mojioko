"""Shared CUDA/cuDNN DLL preload for the MOJIOKO Python sidecars.

REQ-0412 — extracted verbatim from `main.py`'s `_preload_bundled_cuda_dlls`
(REQ-0147) so BOTH the transcription sidecar (`main.py`) and the translation
sidecar (`translate.py`) resolve the bundled CUDA runtime the same way.

The translation sidecar previously only called `os.add_dll_directory`, which
is NOT enough: ctranslate2's C++ code issues a plain
`LoadLibrary("cublas64_12.dll")` at model-load / first-GEMM time, and that
plain call ignores the Python-side search-path registration on Toolkit-less
machines.  The fix is to pre-load every bundled CUDA/cuDNN library BY ABSOLUTE
PATH, in dependency order, so Windows' loaded-modules cache satisfies every
later bare-name `LoadLibrary` from any component/thread.

Call `preload_bundled_cuda_dlls()` at module import, BEFORE `import ctranslate2`
runs.  On non-Windows, or when `MOJIOKO_GPU_TOOL_DIR` is unset/empty/missing
(the "GPU tools not downloaded / CPU card picked" state), it is a silent no-op
and the caller's CPU path takes over.
"""
import os
import sys


# Dependency-ordered preload.  Leaves first (no deps among the bundled files),
# roots last.  The order matters because Windows resolves static imports when a
# DLL is loaded; if cublas comes before its LT dep the loader would have to
# search for cublasLt on its own (and fail on Toolkit-less machines).
_PRELOAD_ORDER = [
    # CUDA Runtime (no deps among the bundle)
    "cudart64_12.dll",
    # cuBLAS — cublasLt is a dep of cublas for LT-GEMM code paths
    "cublasLt64_12.dll",
    "cublas64_12.dll",
    # cuDNN sub-libraries (loader `cudnn64_9.dll` imports these)
    "cudnn_graph64_9.dll",
    "cudnn_ops64_9.dll",
    "cudnn_cnn64_9.dll",
    "cudnn_adv64_9.dll",
    "cudnn_heuristic64_9.dll",
    "cudnn_engines_runtime_compiled64_9.dll",
    "cudnn_engines_precompiled64_9.dll",
    # cuDNN loader — statically imports adv/cnn/graph/ops so those must be
    # loaded first.
    "cudnn64_9.dll",
]


def preload_bundled_cuda_dlls() -> None:
    """Pre-load bundled CUDA/cuDNN DLLs so ctranslate2 can find cuBLAS/cuDNN.

    Silent no-op on non-Windows, when `MOJIOKO_GPU_TOOL_DIR` is unset/blank, or
    when the folder does not exist.  Never raises: any failure is logged to
    stderr and the caller's CPU fallback carries execution.
    """
    if sys.platform != "win32":
        return
    # REQ-0149 — CUDA/cuDNN redistributables are downloaded separately via the
    # in-app UI to `%APPDATA%/MOJIOKO/gpu-tools/cuda-v1/`.  The Electron main
    # process passes that path via `MOJIOKO_GPU_TOOL_DIR` when it wants GPU;
    # unset / non-existent → "GPU tools not downloaded yet" → CPU-only path.
    dll_dir = os.environ.get("MOJIOKO_GPU_TOOL_DIR", "").strip()
    if not dll_dir:
        return
    if not os.path.isdir(dll_dir):
        print(f"[dll_preload] MOJIOKO_GPU_TOOL_DIR={dll_dir!r} does not exist; skipping GPU preload",
              file=sys.stderr)
        return
    print(f"[dll_preload] using DLL folder: {dll_dir}", file=sys.stderr)
    # Register the folder for LOAD_LIBRARY_SEARCH_USER_DIRS-aware LoadLibrary
    # paths.  Belt-and-braces; the CDLL pre-load below is the actual fix.
    try:
        os.add_dll_directory(dll_dir)
    except OSError as e:
        print(f"[dll_preload] add_dll_directory({dll_dir!r}) failed: {e}",
              file=sys.stderr)

    import ctypes
    loaded, missing, failed = [], [], []
    for dll_name in _PRELOAD_ORDER:
        full_path = os.path.join(dll_dir, dll_name)
        if not os.path.isfile(full_path):
            missing.append(dll_name)
            continue
        try:
            ctypes.CDLL(full_path)
            loaded.append(dll_name)
        except OSError as e:
            failed.append((dll_name, str(e)))
    if loaded:
        print(f"[dll_preload] loaded {len(loaded)}/{len(_PRELOAD_ORDER)}: "
              f"{', '.join(loaded)}", file=sys.stderr)
    if missing:
        # Not fatal.  A build without cuDNN redist simply won't have these
        # files, and the caller's CPU fallback will engage.
        print(f"[dll_preload] not bundled (skipped): {', '.join(missing)}",
              file=sys.stderr)
    if failed:
        for name, err in failed:
            print(f"[dll_preload] FAILED to load {name}: {err}", file=sys.stderr)
