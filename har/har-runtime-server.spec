# -*- mode: python ; coding: utf-8 -*-

from PyInstaller.utils.hooks import collect_submodules

# Bake the user-facing `har` SDK into the bundle so scripts the runtime executes can `import har`
# without any extra install step on the end user's machine.
_har_sdk_imports = collect_submodules('har')

a = Analysis(
    ['src/har/runtime/desktop_entry.py'],
    pathex=['src'],
    # NOTE: `pyinstaller` must be run from the `har/` directory so these relative
    # paths resolve.
    binaries=[],
    datas=[],
    hiddenimports=_har_sdk_imports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
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
