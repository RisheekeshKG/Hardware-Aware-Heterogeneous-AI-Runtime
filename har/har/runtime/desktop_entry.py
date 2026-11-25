"""PyInstaller entry point for the packaged desktop runtime sidecar.

The frozen sidecar no longer ships torch; it's installed on first launch by uv
into a user-writable directory and the path to that directory is passed in via
`HAR_USER_PKGS_DIR`. Prepend it to sys.path BEFORE any `import har.*` so the
first `import torch` the runtime does finds the external install.
"""

import os
import sys

# The desktop app reads this process's output through pipes as UTF-8. On Windows, Python
# would otherwise encode piped output in the ANSI code page (e.g. "…" becomes byte 0x85).
for _stream in (sys.stdout, sys.stderr):
    if _stream is not None and hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

_user_pkgs = os.environ.get("HAR_USER_PKGS_DIR")
if _user_pkgs and os.path.isdir(_user_pkgs):
    sys.path.insert(0, _user_pkgs)

from har.runtime.cli import app


if __name__ == "__main__":
    app()
