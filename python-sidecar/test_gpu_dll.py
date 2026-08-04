"""REQ-0412 — unit tests for the shared CUDA/cuDNN DLL preload helper.

These pin the *safety* contract that both sidecars rely on:

  1. `preload_bundled_cuda_dlls()` NEVER raises, whatever the environment —
     unset / blank / non-existent `MOJIOKO_GPU_TOOL_DIR` must all no-op so the
     caller's CPU fallback carries execution.
  2. The dependency order is correct: `cublasLt64_12.dll` precedes
     `cublas64_12.dll`, and every cuDNN sub-library precedes the `cudnn64_9.dll`
     loader.  Getting this wrong reintroduces the Toolkit-less GPU failure.

No real CUDA DLLs are required (we point at empty / missing folders), so this
runs on any machine.

Runnable via
`.venv\\Scripts\\python.exe -m unittest python-sidecar/test_gpu_dll.py`
from the repo root, matching the existing `test_select_device.py` style.
"""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from unittest import mock

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import gpu_dll  # noqa: E402


class PreloadSafetyTests(unittest.TestCase):
    def test_noop_when_env_unset(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("MOJIOKO_GPU_TOOL_DIR", None)
            gpu_dll.preload_bundled_cuda_dlls()  # must not raise

    def test_noop_when_env_blank(self):
        with mock.patch.dict(os.environ, {"MOJIOKO_GPU_TOOL_DIR": "   "}):
            gpu_dll.preload_bundled_cuda_dlls()  # must not raise

    def test_noop_when_dir_missing(self):
        missing = os.path.join(tempfile.gettempdir(), "mojioko-no-such-gpu-dir-req0412")
        self.assertFalse(os.path.isdir(missing))
        with mock.patch.dict(os.environ, {"MOJIOKO_GPU_TOOL_DIR": missing}):
            gpu_dll.preload_bundled_cuda_dlls()  # must not raise

    def test_noop_when_dir_empty(self):
        # A real, existing folder with none of the bundled DLLs: every entry is
        # reported "missing" and the call still returns cleanly.
        with tempfile.TemporaryDirectory() as empty_dir:
            with mock.patch.dict(os.environ, {"MOJIOKO_GPU_TOOL_DIR": empty_dir}):
                gpu_dll.preload_bundled_cuda_dlls()  # must not raise


class PreloadOrderTests(unittest.TestCase):
    def test_cublas_lt_before_cublas(self):
        order = gpu_dll._PRELOAD_ORDER
        self.assertLess(
            order.index("cublasLt64_12.dll"),
            order.index("cublas64_12.dll"),
            "cublasLt must be preloaded before cublas (it is a dependency)",
        )

    def test_cudnn_subs_before_loader(self):
        order = gpu_dll._PRELOAD_ORDER
        loader = order.index("cudnn64_9.dll")
        for sub in (
            "cudnn_graph64_9.dll",
            "cudnn_ops64_9.dll",
            "cudnn_cnn64_9.dll",
            "cudnn_adv64_9.dll",
        ):
            self.assertLess(order.index(sub), loader, f"{sub} must precede cudnn64_9.dll")

    def test_cudart_first(self):
        self.assertEqual(gpu_dll._PRELOAD_ORDER[0], "cudart64_12.dll")


if __name__ == "__main__":
    unittest.main()
