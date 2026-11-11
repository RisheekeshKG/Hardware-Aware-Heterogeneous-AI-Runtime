# -*- mode: python ; coding: utf-8 -*-

from PyInstaller.utils.hooks import collect_data_files, collect_submodules

import sys

# Bake the user-facing `har` SDK into the bundle so scripts the runtime executes can `import har`
# without any extra install step on the end user's machine.
_har_sdk_imports = collect_submodules('har')

# torch (installed later by uv) and user scripts import stdlib modules HAR itself never touches,
# e.g. torch needs `timeit`. PyInstaller only bundles what it sees imported, so ship the whole
# stdlib except GUI/test packages.
_STDLIB_SKIP = {"tkinter", "turtle", "turtledemo", "idlelib", "test", "lib2to3", "ensurepip", "venv"}
_stdlib_imports = []
for _name in sorted(sys.stdlib_module_names):
    if _name in _STDLIB_SKIP or _name.startswith("_"):
        continue
    _stdlib_imports.extend(collect_submodules(_name, filter=lambda m: ".test" not in m and ".tests" not in m))

# PyInstaller strips `*.dist-info` by default, which makes `importlib.metadata.version()`
# return "absent" for every package in the frozen bundle. That broke our env-hash mismatch
# warning because host and worker both reported every package as missing. Pull in the
# dist-info directories for every package env_hash cares about. torch and numpy are NOT
# bundled — uv installs them into HAR_USER_PKGS_DIR on first launch, with real dist-info.
_env_hash_packages = (
    "psutil",
    "fastapi",
    "uvicorn",
    "httpx",
    "pydantic",
    "pynvml",
)
_metadata_datas = []
for _pkg in _env_hash_packages:
    try:
        _metadata_datas.extend(collect_data_files(_pkg, include_py_files=False, includes=["*.dist-info/*"]))
    except Exception:
        # Some optional packages (pynvml on non-NVIDIA machines) legitimately aren't
        # installed — collect_data_files raises in that case; skip them silently so the
        # build doesn't fail on hardware-specific omissions.
        pass

a = Analysis(
    ['har/runtime/desktop_entry.py'],
    pathex=['.'],
    # NOTE: `pyinstaller` must be run from the `har/` directory so these relative
    # paths resolve.
    binaries=[],
    datas=_metadata_datas,
    hiddenimports=_har_sdk_imports + _stdlib_imports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # Installed at first launch by uv, not bundled. Keeps the installer ~50MB.
        'torch',
        'torchvision',
        'torchaudio',
        'numpy',
        'tensorflow',
        'cv2',
        'pyarrow',
        'pandas',
        'scipy',
        'sklearn',
        'matplotlib',
        'h5py',
        'lxml',
        'grpc',
        'jedi',
    ],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='har-runtime-server',
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
    name='har-runtime-server',
)
