"""#4054 -- log the Node server's exit code when it dies, wait a grace period,
then exit unless a new server has picked us up.

On Windows the server has twice died silently (no stderr, no stack) while
waiting on this sidecar, most likely a native crash (0xC0000409). The server
can't log its own native death, but we can: the server passes its pid in
SIDECAR_PARENT_PID (and its start time in SIDECAR_PARENT_START_MS), we hold a
process handle on it, and when it exits we log the code at error level AT ONCE.
The code separates a native crash (0xC0000409 / 0xC0000005) from taskkill or a
Node child.kill() / process.exit(1) (1), Stop-Process (0xFFFFFFFF) and an
unhandled console event -- Ctrl+C, Ctrl+Break, console close (0xC000013A).

We then wait DEFAULT_GRACE_S before exiting. A dev reload (`tsx watch`) kills the
server and starts a new one in ~2 s; the new server adopts this sidecar and says
so with POST /parent, which calls rearm() and cancels the pending exit, so the
loaded models stay. A real death gets no re-arm, and the sidecar exits.

No SIDECAR_PARENT_PID (a standalone `npm run tts:sidecar`) -> nothing watches,
and rearm() is a no-op: a hand-launched sidecar is never taken over.

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
PARENT_START_ENV = "SIDECAR_PARENT_START_MS"

# A dev reload re-adopts in ~2 s; 15 s leaves room for a slow tsx cold start
# without keeping a genuinely orphaned sidecar (and its VRAM) around for long.
DEFAULT_GRACE_S = 15.0

# Node's performance.timeOrigin trails the OS process-creation time by tens of
# ms; a pid reused by another process is created far later than this.
START_TIME_TOLERANCE_MS = 10_000

_KNOWN_CODES: dict[int, str] = {
    0xC0000409: "fast-fail / STATUS_STACK_BUFFER_OVERRUN, a native crash",
    0xC0000005: "access violation, a native crash",
    0xC000013A: "STATUS_CONTROL_C_EXIT, an unhandled console event: Ctrl+C, Ctrl+Break or console close",
    0xFFFFFFFF: "Stop-Process",
    1: "taskkill, a Node child.kill() (tsx restart, concurrently -k) or process.exit(1)",
    0: "clean exit",
}


class WatchUnavailable(Exception):
    """The parent can't be observed (e.g. access denied); don't treat as exit."""


class ParentGone(Exception):
    """The pid is not the server we were told about (reused by another process),
    so the server is gone. Carries the reason for the log line."""


def format_exit_code(code: int) -> str:
    """`0xC0000409 (fast-fail ...)`; negative ints are the signed view of a DWORD."""
    dword = code & 0xFFFFFFFF
    return f"0x{dword:08X} ({_KNOWN_CODES.get(dword, 'unrecognised')})"


class _Win32Api:
    """ctypes view of the kernel32 calls the watcher needs."""

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
        k.GetProcessTimes.restype = wintypes.BOOL
        k.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
        k.CloseHandle.argtypes = [wintypes.HANDLE]
        self._k = k

    def open_process(self, pid: int):
        h = self._k.OpenProcess(
            self.SYNCHRONIZE | self.PROCESS_QUERY_LIMITED_INFORMATION, False, pid
        )
        return h or None

    def wait(self, handle) -> int:
        return int(self._k.WaitForSingleObject(handle, self.INFINITE))

    def exit_code(self, handle) -> Optional[int]:
        """None when GetExitCodeProcess returned FALSE."""
        out = self._wt.DWORD()
        if not self._k.GetExitCodeProcess(handle, self._ct.byref(out)):
            return None
        return int(out.value)

    def creation_ms(self, handle) -> Optional[int]:
        """Process creation time as ms since the Unix epoch; None on FALSE."""
        ft = [self._wt.FILETIME() for _ in range(4)]
        if not self._k.GetProcessTimes(handle, *[self._ct.byref(f) for f in ft]):
            return None
        ticks = (ft[0].dwHighDateTime << 32) | ft[0].dwLowDateTime  # 100 ns since 1601
        return (ticks - 116444736000000000) // 10_000

    def close(self, handle) -> None:
        self._k.CloseHandle(handle)

    def last_error(self) -> int:
        return self._ct.get_last_error()


_ERROR_INVALID_PARAMETER = 87  # OpenProcess on a pid that no longer exists
_WAIT_OBJECT_0 = 0
_STILL_ACTIVE = 259  # GetExitCodeProcess on a process that has not exited


def _check_start_time(pid: int, start_ms: Optional[int], created_ms: Optional[int]) -> None:
    if start_ms is None or created_ms is None:
        return
    if abs(created_ms - start_ms) > START_TIME_TOLERANCE_MS:
        raise ParentGone(
            f"pid {pid} was created {created_ms - start_ms} ms after the server started "
            "(pid reused by another process)"
        )


def wait_for_pid_windows(pid: int, start_ms: Optional[int] = None, api: Any = None) -> Optional[int]:
    """Block until `pid` exits; return its exit code (None if it was already
    gone before we could open it). Raises WatchUnavailable if it can't be
    opened or waited on, ParentGone if the pid is a different process."""
    api = api or _Win32Api()
    handle = api.open_process(pid)
    if handle is None:
        err = api.last_error()
        if err == _ERROR_INVALID_PARAMETER:
            return None
        raise WatchUnavailable(f"OpenProcess({pid}) failed, winerror {err}")
    try:
        _check_start_time(pid, start_ms, api.creation_ms(handle) if start_ms is not None else None)
        result = api.wait(handle)
        if result != _WAIT_OBJECT_0:
            raise WatchUnavailable(f"WaitForSingleObject({pid}) returned 0x{result:X}, not WAIT_OBJECT_0")
        code = api.exit_code(handle)
        if code is None:
            raise WatchUnavailable(f"GetExitCodeProcess({pid}) failed")
        if code == _STILL_ACTIVE:
            raise WatchUnavailable(f"GetExitCodeProcess({pid}) reported STILL_ACTIVE after the wait")
        return code
    finally:
        api.close(handle)


def _posix_creation_ms(pid: int) -> Optional[int]:
    """Process start time in ms since the epoch via psutil (a sidecar
    requirement); None when it can't be read."""
    try:
        import psutil

        return int(psutil.Process(pid).create_time() * 1000)
    except Exception:
        return None


def wait_for_pid_posix(
    pid: int,
    start_ms: Optional[int] = None,
    poll_s: float = 1.0,
    sleep: Callable[[float], None] = time.sleep,
) -> Optional[int]:
    """Poll until `pid` is gone. POSIX only. A non-child's exit code is not
    observable, so this returns None."""
    if start_ms is not None:
        _check_start_time(pid, start_ms, _posix_creation_ms(pid))
    while True:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return None
        except PermissionError:
            pass  # exists, owned by someone else
        sleep(poll_s)


def _default_waiter(platform: str) -> Callable[[int, Optional[int]], Optional[int]]:
    return wait_for_pid_windows if platform == "win32" else wait_for_pid_posix


def _parse_pid(raw: Any) -> Optional[int]:
    try:
        pid = int(raw)
    except (TypeError, ValueError):
        return None
    return pid if pid > 0 else None


def _parse_ms(raw: Any) -> Optional[int]:
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


class ParentWatch:
    """Watches one server pid at a time; rearm() switches to a new one and
    cancels a pending grace exit."""

    def __init__(
        self,
        waiter: Callable[[int, Optional[int]], Optional[int]],
        on_exit: Callable[[int], Any],
        grace_s: float,
    ) -> None:
        self._waiter = waiter
        self._on_exit = on_exit
        self._grace_s = grace_s
        self._cond = threading.Condition()
        self._gen = 0
        self._pid: Optional[int] = None
        self.thread: Optional[threading.Thread] = None

    def arm(self, pid: int, start_ms: Optional[int]) -> threading.Thread:
        with self._cond:
            self._gen += 1
            gen = self._gen
            self._pid = pid
            self._cond.notify_all()
        t = threading.Thread(
            target=self._run, args=(gen, pid, start_ms), name="parent-watch", daemon=True
        )
        self.thread = t
        t.start()
        return t

    def rearm(self, pid: int, start_ms: Optional[int] = None) -> bool:
        """A new server adopted us: watch it instead, and cancel any pending exit."""
        if _parse_pid(pid) is None:
            return False
        old = self._pid
        self.arm(pid, start_ms)
        log.info("parent watch re-armed: server pid=%d (was pid=%s)", pid, old)
        return True

    def _run(self, gen: int, pid: int, start_ms: Optional[int]) -> None:
        try:
            code = self._waiter(pid, start_ms)
            why = None
        except WatchUnavailable as e:
            log.warning("parent watch disabled: %s", e)
            return
        except ParentGone as e:
            code, why = None, str(e)
        except Exception:
            log.exception("parent watch failed; sidecar keeps running")
            return
        with self._cond:
            if self._gen != gen:
                return  # a newer server took over while we waited
        if why is not None:
            log.error("server pid=%d is gone: %s", pid, why)
        elif code is None:
            log.error("server pid=%d has exited (exit code unavailable)", pid)
        else:
            log.error("server pid=%d exited with code %d = %s", pid, code, format_exit_code(code))
        with self._cond:
            rearmed = self._cond.wait_for(lambda: self._gen != gen, timeout=self._grace_s)
        if rearmed:
            log.info("a new server took over within %.0fs; sidecar stays up", self._grace_s)
            return
        log.warning("no new server within %.0fs; sidecar exiting", self._grace_s)
        self._on_exit(0)


_active: Optional[ParentWatch] = None


def start_parent_watch(
    env: Optional[Mapping[str, str]] = None,
    platform: Optional[str] = None,
    waiter: Optional[Callable[[int, Optional[int]], Optional[int]]] = None,
    on_exit: Optional[Callable[[int], Any]] = None,
    grace_s: float = DEFAULT_GRACE_S,
) -> Optional[ParentWatch]:
    """Start the daemon watcher thread; returns the ParentWatch, or None when no
    valid SIDECAR_PARENT_PID is set. The default exit is os._exit (not sys.exit,
    which in a daemon thread only ends that thread; and it skips uvicorn's
    graceful shutdown, which can block on a wedged GPU op)."""
    global _active
    env = os.environ if env is None else env
    platform = sys.platform if platform is None else platform
    pid = _parse_pid(env.get(PARENT_PID_ENV, ""))
    if pid is None:
        log.info("parent watch off (no valid %s); this sidecar outlives any server", PARENT_PID_ENV)
        return None
    start_ms = _parse_ms(env.get(PARENT_START_ENV))
    watch = ParentWatch(waiter or _default_waiter(platform), on_exit or os._exit, grace_s)
    _active = watch
    log.info("parent watch armed: server pid=%d (start_ms=%s, grace %.0fs)", pid, start_ms, grace_s)
    watch.arm(pid, start_ms)
    return watch


def rearm(pid: int, start_ms: Optional[int] = None) -> bool:
    """Called by POST /parent. False when there is no watcher (a standalone
    sidecar) or the pid is invalid: nothing changes in either case."""
    if _active is None:
        return False
    return _active.rearm(pid, start_ms)
