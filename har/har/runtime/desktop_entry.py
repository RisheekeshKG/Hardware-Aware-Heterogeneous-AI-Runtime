"""PyInstaller entry point for the packaged desktop runtime sidecar.

The frozen sidecar no longer ships torch; it's installed on first launch by uv
into a user-writable directory and the path to that directory is passed in via
`HAR_USER_PKGS_DIR`. Prepend it to sys.path BEFORE any `import har.*` so the
first `import torch` the runtime does finds the external install.
"""

import os
import sys

_user_pkgs = os.environ.get("HAR_USER_PKGS_DIR")
if _user_pkgs and os.path.isdir(_user_pkgs):
    sys.path.insert(0, _user_pkgs)

from har.runtime.cli import app


if __name__ == "__main__":
    app()
