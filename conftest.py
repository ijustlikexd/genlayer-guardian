"""Windows shim for gltest Direct Mode (no-op elsewhere).

gltest.direct.loader._inject_message_to_fd0 unlinks a tempfile that is still open
through the dup2'd fd 0. Linux allows that; Windows raises WinError 32.
Scope: only PermissionError, only files under the system temp dir, only on win32.
Deferred deletes run at interpreter exit.
"""
import atexit
import os
import sys
import tempfile

if sys.platform == "win32":
    _real_unlink = os.unlink
    _tmp = os.path.normcase(tempfile.gettempdir())
    _pending: list[str] = []

    def _unlink(path, *a, **k):
        try:
            return _real_unlink(path, *a, **k)
        except PermissionError:
            if os.path.normcase(os.path.abspath(path)).startswith(_tmp):
                _pending.append(path)
                return None
            raise

    def _cleanup():
        for p in _pending:
            try:
                _real_unlink(p)
            except OSError:
                pass

    os.unlink = _unlink
    atexit.register(_cleanup)
