"""#4054 — exit with the Node server that spawned us, and log its exit code.

On Windows the server has twice died silently (no stderr, no stack) while
waiting on this sidecar, most likely a native crash (0xC0000409). The server
can't log its own native death, but we can: the server passes its pid in
SIDECAR_PARENT_PID, we hold a process handle on it, and when it exits we log
the code at error level and exit too. The code separates a native crash
(0xC0000409 / 0xC0000005) from taskkill (1), Stop-Process (0xFFFFFFFF) and a
console Ctrl+C (0xC000013A).

No SIDECAR_PARENT_PID (a standalone `npm run tts:sidecar`) -> nothing watches.

WARNING: never use os.kill(pid, 0) on Windows -- there it is not a liveness
probe, it sends Ctrl+C to the console group. The Windows path uses a process
handle only; os.kill is the POSIX-only fallback.
"""
from __future__ import annotations

import logging
import os
import sys
import threading
import time
from typing import Any, Callable, Mapping, Optional

log = logging.getLogger("sidecar")

PARENT_PID_ENV = "SIDECAR_PARENT_PID"

_KNOWN_CODES: dict[int, str] = {
    0xC0000409: "fast-fail / STATUS_STACK_BUFFER_OVERRUN, a native crash",
    0xC0000005: "access violation, a native crash",
    0xC000013A: "Ctrl+C / STATUS_CONTROL_C_EXIT",
    0xFFFFFFFF: "Stop-Process",
    1: "taskkill",
    0: "clean exit",
}


class WatchUnavailable(Exception):
    """The parent can't be observed (e.g. access denied); don't treat as exit."""


def format_exit_code(code: int) -> str:
    """`0xC0000409 (fast-fail ...)`; negative ints are the signed view of a DWORD."""
    dword = code & 0xFFFFFFFF
    return f"0x{dword:08X} ({_KNOWN_CODES.get(dword, 'unrecognised')})"


class _Win32Api:
    """ctypes view of the four kernel32 calls the watcher needs."""

    SYNCHRONIZE = 0x00100000
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    INFINITE = 0xFFFFFFFF

    def __init__(self) -> None:
        import ctypes
        from ctypes import wintypes

        self._ct = ctypes
        self._wt = wintypes
        k = ctypes.WinDLL("kernel32", use_last_error=True)
        k.OpenProcess.restype = wintypes.HANDLE
        k.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        k.WaitForSingleObject.restype = wintypes.DWORD
        k.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        k.GetExitCodeProcess.restype = wintypes.BOOL
        k.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
        k.CloseHandle.argtypes = [wintypes.HANDLE]
        self._k = k

    def open_process(self, pid: int):
        h = self._k.OpenProcess(
            self.SYNCHRONIZE | self.PROCESS_QUERY_LIMITED_INFORMATION, False, pid
        )
        return h or None

    def wait(self, handle) -> None:
        self._k.WaitForSingleObject(handle, self.INFINITE)

    def exit_code(self, handle) -> int:
        out = self._wt.DWORD()
        self._k.GetExitCodeProcess(handle, self._ct.byref(out))
        return int(out.value)

    def close(self, handle) -> None:
        self._k.CloseHandle(handle)

    def last_error(self) -> int:
        return self._ct.get_last_error()


_ERROR_INVALID_PARAMETER = 87  # OpenProcess on a pid that no longer exists


def wait_for_pid_windows(pid: int, api: Any = None) -> Optional[int]:
    """Block until `pid` exits; return its exit code (None if it was already
    gone before we could open it). Raises WatchUnavailable if it can't be
    opened for another reason."""
    api = api or _Win32Api()
    handle = api.open_process(pid)
    if handle is None:
        err = api.last_error()
        if err == _ERROR_INVALID_PARAMETER:
            return None
        raise WatchUnavailable(f"OpenProcess({pid}) failed, winerror {err}")
    try:
        api.wait(handle)
        return api.exit_code(handle)
    finally:
        api.close(handle)


def wait_for_pid_posix(
    pid: int, poll_s: float = 1.0, sleep: Callable[[float], None] = time.sleep
) -> Optional[int]:
    """Poll until `pid` is gone. POSIX only. A non-child's exit code is not
    observable, so this returns None."""
    while True:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return None
        except PermissionError:
            pass  # exists, owned by someone else
        sleep(poll_s)


def _default_waiter(platform: str) -> Callable[[int], Optional[int]]:
    return wait_for_pid_windows if platform == "win32" else wait_for_pid_posix


def start_parent_watch(
    env: Optional[Mapping[str, str]] = None,
    platform: Optional[str] = None,
    waiter: Optional[Callable[[int], Optional[int]]] = None,
    on_exit: Callable[[int], Any] = os._exit,
) -> Optional[threading.Thread]:
    """Start the daemon watcher thread; returns it, or None when no valid
    SIDECAR_PARENT_PID is set. os._exit (not sys.exit) skips uvicorn's graceful
    shutdown, which can block on a wedged GPU op; the parent is already dead."""
    env = os.environ if env is None else env
    platform = sys.platform if platform is None else platform
    try:
        pid = int(env.get(PARENT_PID_ENV, ""))
    except ValueError:
        return None
    if pid <= 0:
        return None
    wait = waiter or _default_waiter(platform)

    def _run() -> None:
        try:
            code = wait(pid)
        except WatchUnavailable as e:
            log.warning("parent watch disabled: %s", e)
            return
        except Exception:
            log.exception("parent watch failed; sidecar keeps running")
            return
        if code is None:
            log.error(
                "server pid=%d has exited (exit code unavailable); sidecar exiting", pid
            )
        else:
            log.error(
                "server pid=%d exited with code %d = %s; sidecar exiting",
                pid, code, format_exit_code(code),
            )
        on_exit(0)

    t = threading.Thread(target=_run, name="parent-watch", daemon=True)
    t.start()
    return t
