# -*- mode: python ; coding: utf-8 -*-
from PyInstaller.utils.hooks import collect_all

datas = []
binaries = []
# REQ-0207 — word_split.py sits next to main.py.  PyInstaller normally
# picks up static imports automatically, but this module is imported
# lazily inside a runtime branch, so we declare it explicitly as a
# belt-and-braces measure.  Removing this line would probably still
# work today, but any future refactor that hoists the import out of the
# branch shouldn't be able to accidentally break the packaged build.
# REQ-0412 — gpu_dll.py sits next to main.py and is imported at module top
# for the CUDA/cuDNN DLL preload.  Declared explicitly so the packaged build
# always bundles it (same belt-and-braces reasoning as word_split above).
# REQ-0494 — translate.py is the MADLAD translation sidecar, reached via
# main.py's `translate` subcommand (lazy import inside a runtime branch).
# Declared explicitly so PyInstaller bundles it even though the import is not
# statically reachable from the top of main.py.  ctranslate2 is already
# collected below (faster-whisper dep); the only net-new runtime dep is
# sentencepiece (see collect_all('sentencepiece') below), so both engines
# share this single bundle's _internal.
hiddenimports = ['word_split', 'gpu_dll', 'translate']
tmp_ret = collect_all('faster_whisper')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
tmp_ret = collect_all('ctranslate2')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
# REQ-0494 — sentencepiece: the SentencePiece tokenizer (spiece.model) the
# MADLAD translation path needs.  faster-whisper uses HF `tokenizers`, not
# sentencepiece, so this is not pulled in transitively — collect it explicitly.
tmp_ret = collect_all('sentencepiece')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
tmp_ret = collect_all('huggingface_hub')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
tmp_ret = collect_all('tokenizers')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
tmp_ret = collect_all('onnxruntime')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
tmp_ret = collect_all('av')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]


a = Analysis(
    ['python-sidecar\\main.py'],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='mojioko-transcriber',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='mojioko-transcriber',
)
