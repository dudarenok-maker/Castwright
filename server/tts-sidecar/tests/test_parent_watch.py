"""#4054 — the sidecar exits when the Node server that spawned it dies, and logs
the server's exit code so a silent server death explains itself (0xC0000409
native fast-fail vs taskkill vs Stop-Process vs Ctrl+C).

Pure-logic tests: the process-handle wait is stubbed, so nothing here touches a
real process, a console, or the GPU."""
from __future__ import annotations

import logging
import sys
import threading
from pathlib import Path

import pytest

SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

import parent_watch  # noqa: E402


@pytest.mark.parametrize(
    "code,expected",
    [
        (0xC0000409, "0xC0000409 (fast-fail"),
        (3221226505, "0xC0000409 (fast-fail"),  # the vitest-worker decimal form
        (0xC0000005, "0xC0000005 (access violation"),
        (0xC000013A, "0xC000013A (Ctrl+C"),
        (1, "0x00000001 (taskkill"),
        (0xFFFFFFFF, "0xFFFFFFFF (Stop-Process"),
        (-1, "0xFFFFFFFF (Stop-Process"),  # signed view of the same DWORD
        (0, "0x00000000 (clean exit"),
        (0x1234, "0x00001234 (unrecognised"),
    ],
)
def test_format_exit_code_names_known_codes(code: int, expected: str) -> None:
    assert expected in parent_watch.format_exit_code(code)


def test_no_pid_means_no_watcher() -> None:
    called = []
    t = parent_watch.start_parent_watch(
        env={}, platform="win32", waiter=lambda pid: called.append(pid), on_exit=lambda c: None
    )
    assert t is None
    assert called == []


@pytest.mark.parametrize("bad", ["", "abc", "0", "-5"])
def test_invalid_pid_means_no_watcher(bad: str) -> None:
    t = parent_watch.start_parent_watch(
        env={"SIDECAR_PARENT_PID": bad}, platform="win32", waiter=lambda pid: 1, on_exit=lambda c: None
    )
    assert t is None


def test_server_exit_logs_error_with_code_then_exits_sidecar(caplog: pytest.LogCaptureFixture) -> None:
    exited = threading.Event()
    exit_codes: list[int] = []

    def on_exit(code: int) -> None:
        exit_codes.append(code)
        exited.set()

    with caplog.at_level(logging.ERROR):
        t = parent_watch.start_parent_watch(
            env={"SIDECAR_PARENT_PID": "4242"},
            platform="win32",
            waiter=lambda pid: 0xC0000409,
            on_exit=on_exit,
        )
        assert t is not None and t.daemon
        assert exited.wait(5)
        t.join(5)

    assert exit_codes == [0]
    errors = [r for r in caplog.records if r.levelno == logging.ERROR]
    assert len(errors) == 1
    msg = errors[0].getMessage()
    assert "4242" in msg and "0xC0000409" in msg and "fast-fail" in msg


def test_unobservable_exit_code_still_exits_sidecar(caplog: pytest.LogCaptureFixture) -> None:
    exited = threading.Event()
    with caplog.at_level(logging.ERROR):
        t = parent_watch.start_parent_watch(
            env={"SIDECAR_PARENT_PID": "7"},
            platform="linux",
            waiter=lambda pid: None,  # POSIX: gone, code unknowable
            on_exit=lambda c: exited.set(),
        )
        assert exited.wait(5)
        t.join(5)
    assert "exit code unavailable" in caplog.text


def test_windows_wait_uses_handle_and_never_os_kill(monkeypatch: pytest.MonkeyPatch) -> None:
    """os.kill(pid, 0) on Windows sends Ctrl+C to the console group -- it killed
    every shared-console process once already. The Windows path must go through
    the process handle only."""
    def boom(*a, **k):
        raise AssertionError("os.kill must never be called on the Windows path")

    monkeypatch.setattr(parent_watch.os, "kill", boom)

    class FakeApi:
        def __init__(self) -> None:
            self.calls: list[tuple] = []

        def open_process(self, pid: int):
            self.calls.append(("open", pid))
            return 99

        def wait(self, handle) -> None:
            self.calls.append(("wait", handle))

        def exit_code(self, handle) -> int:
            self.calls.append(("code", handle))
            return 0xC000013A

        def close(self, handle) -> None:
            self.calls.append(("close", handle))

        def last_error(self) -> int:
            return 0

    api = FakeApi()
    assert parent_watch.wait_for_pid_windows(31337, api=api) == 0xC000013A
    assert api.calls == [("open", 31337), ("wait", 99), ("code", 99), ("close", 99)]


def test_windows_open_failure_access_denied_does_not_report_exit() -> None:
    class DeniedApi:
        def open_process(self, pid):
            return None

        def last_error(self):
            return 5  # ERROR_ACCESS_DENIED

    with pytest.raises(parent_watch.WatchUnavailable):
        parent_watch.wait_for_pid_windows(1, api=DeniedApi())


def test_windows_already_gone_parent_reports_exit_without_code() -> None:
    class GoneApi:
        def open_process(self, pid):
            return None

        def last_error(self):
            return 87  # ERROR_INVALID_PARAMETER: no such pid

    assert parent_watch.wait_for_pid_windows(1, api=GoneApi()) is None


def test_posix_wait_polls_os_kill_until_gone(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[tuple] = []
    alive = iter([True, True, False])

    def fake_kill(pid: int, sig: int) -> None:
        seen.append((pid, sig))
        if not next(alive):
            raise ProcessLookupError

    monkeypatch.setattr(parent_watch.os, "kill", fake_kill)
    assert parent_watch.wait_for_pid_posix(55, poll_s=0, sleep=lambda s: None) is None
    assert seen == [(55, 0)] * 3


def test_default_waiter_on_windows_is_not_the_posix_poll(monkeypatch: pytest.MonkeyPatch) -> None:
    """start_parent_watch picks the waiter by platform; win32 must never reach
    the os.kill poll."""
    assert parent_watch._default_waiter("win32") is parent_watch.wait_for_pid_windows
    assert parent_watch._default_waiter("linux") is parent_watch.wait_for_pid_posix


def test_main_starts_the_watch_at_import() -> None:
    """Wiring pin: main.py must call start_parent_watch() at module scope (not
    inside _lifespan -- test_lifespan_order pins that sequence by name)."""
    src = (SIDECAR_ROOT / "main.py").read_text(encoding="utf-8")
    assert "from parent_watch import start_parent_watch" in src
    assert "\nstart_parent_watch()\n" in src


@pytest.mark.skipif(sys.platform != "win32", reason="real Win32 process-handle wait")
def test_real_windows_handle_wait_reads_a_childs_exit_code() -> None:
    """Exercises the actual ctypes kernel32 path against a tiny real child, so a
    wrong argtypes/restype can't hide behind the fake api above."""
    import subprocess

    child = subprocess.Popen([sys.executable, "-c", "import os; os._exit(-1073740791)"])
    try:
        assert parent_watch.wait_for_pid_windows(child.pid) == 0xC0000409
    finally:
        child.wait()
