"""#4054 — the sidecar exits when the Node server that spawned it dies, and logs
the server's exit code so a silent server death explains itself (0xC0000409
native fast-fail vs taskkill vs Stop-Process vs Ctrl+C).

Pure-logic tests: the process-handle wait is stubbed, so nothing here touches a
real process, a console, or the GPU."""
from __future__ import annotations

import logging
import sys
import threading
import time
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
        (0xC000013A, "0xC000013A (STATUS_CONTROL_C_EXIT, an unhandled console event: Ctrl+C, Ctrl+Break or console close"),
        (1, "0x00000001 (taskkill, a Node child.kill() (tsx restart, concurrently -k) or process.exit(1)"),
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
        env={}, platform="win32", waiter=lambda pid, ms: called.append(pid), on_exit=lambda c: None
    )
    assert t is None
    assert called == []


@pytest.mark.parametrize("bad", ["", "abc", "0", "-5"])
def test_invalid_pid_means_no_watcher(bad: str) -> None:
    t = parent_watch.start_parent_watch(
        env={"SIDECAR_PARENT_PID": bad}, platform="win32", waiter=lambda pid, ms: 1, on_exit=lambda c: None
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
            waiter=lambda pid, ms: 0xC0000409,
            grace_s=0,
            on_exit=on_exit,
        )
        assert t is not None and t.thread.daemon
        assert exited.wait(5)
        t.thread.join(5)

    assert exit_codes == [parent_watch.GRACE_EXIT_CODE]
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
            waiter=lambda pid, ms: None,  # POSIX: gone, code unknowable
            grace_s=0,
            on_exit=lambda c: exited.set(),
        )
        assert exited.wait(5)
        t.thread.join(5)
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

        def wait(self, handle) -> int:
            self.calls.append(("wait", handle))
            return 0  # WAIT_OBJECT_0

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
    assert "\nimport parent_watch  # noqa: E402\n" in src
    assert "\nparent_watch.start_parent_watch()\n" in src


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


@pytest.mark.skipif(sys.platform != "win32", reason="real GetProcessTimes FILETIME conversion")
def test_real_windows_creation_time_is_in_the_unix_epoch() -> None:
    """A FILETIME-epoch slip (1601 vs 1970 off by even minutes) would make every
    Windows sidecar judge its live server 'reused' and exit after the grace --
    invisible to the fake-api tests. The child prints its own time.time()*1000 at
    start; the real creation time must agree with it inside the tolerance, and a
    start_ms 10 minutes earlier must read as a different process."""
    import subprocess

    child = subprocess.Popen(
        [sys.executable, "-c", "import sys, time; print(int(time.time()*1000), flush=True); time.sleep(0.5)"],
        stdout=subprocess.PIPE,
        text=True,
    )
    try:
        start_ms = int(child.stdout.readline())
        assert parent_watch.wait_for_pid_windows(child.pid, start_ms=start_ms) is not None
    finally:
        child.wait()
    child = subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(0.5)"], stdout=subprocess.PIPE, text=True
    )
    try:
        with pytest.raises(parent_watch.ParentGone):
            parent_watch.wait_for_pid_windows(child.pid, start_ms=int(time.time() * 1000) - 600_000)
    finally:
        child.wait()


# ---------------------------------------------------------------------------
# #4054 owner decision: log the server's exit code at once, wait a grace
# period, exit only if no new server re-armed the watch (POST /parent).
# ---------------------------------------------------------------------------


def _gone_after(event: threading.Event):
    """A waiter that blocks until `event` is set, then reports exit code 1."""

    def waiter(pid: int, start_ms) -> int:
        assert event.wait(10)
        return 1

    return waiter


def _wait_for_caplog(caplog: pytest.LogCaptureFixture, text: str, timeout: float = 5) -> None:
    deadline = time.time() + timeout
    while text not in caplog.text and time.time() < deadline:
        time.sleep(0.01)
    assert text in caplog.text


def test_log_is_immediate_but_exit_waits_for_the_grace(caplog: pytest.LogCaptureFixture) -> None:
    gone = threading.Event()
    exited = threading.Event()
    with caplog.at_level(logging.INFO, logger="sidecar"):
        w = parent_watch.start_parent_watch(
            env={"SIDECAR_PARENT_PID": "41"},
            platform="linux",
            waiter=_gone_after(gone),
            on_exit=lambda c: exited.set(),
            grace_s=0.6,
        )
        gone.set()
        _wait_for_caplog(caplog, "exited with code")  # logged at once ...
        assert not exited.is_set()  # ... but the sidecar is still up
        assert exited.wait(5)  # exits once the grace has run out
        w.thread.join(5)
    assert "sidecar exiting" in caplog.text


def test_rearm_within_the_grace_cancels_the_exit(caplog: pytest.LogCaptureFixture) -> None:
    gone = threading.Event()
    block = threading.Event()
    exited = threading.Event()
    seen: list[tuple] = []

    def waiter(pid: int, start_ms) -> int:
        seen.append((pid, start_ms))
        if pid == 41:
            assert gone.wait(10)
            return 1
        block.wait(10)  # the new server stays alive
        return 0

    with caplog.at_level(logging.INFO, logger="sidecar"):
        w = parent_watch.start_parent_watch(
            env={"SIDECAR_PARENT_PID": "41"},
            platform="linux",
            waiter=waiter,
            on_exit=lambda c: exited.set(),
            grace_s=1.0,
        )
        gone.set()
        _wait_for_caplog(caplog, "exited with code")
        assert w.rearm(77, 1234) is True
        assert not exited.wait(1.8)  # well past the 1.0 s grace: still alive
        block.set()
    assert (77, 1234) in seen
    assert "re-armed" in caplog.text


def test_rearm_switches_the_watched_pid_while_the_old_server_is_alive(caplog: pytest.LogCaptureFixture) -> None:
    """Adoption with the previous server still running: the old pid's later
    death must NOT take the sidecar down, only the new pid's does."""
    old_gone = threading.Event()
    new_gone = threading.Event()
    exited = threading.Event()

    def waiter(pid: int, start_ms) -> int:
        (old_gone if pid == 41 else new_gone).wait(10)
        return 1

    w = parent_watch.start_parent_watch(
        env={"SIDECAR_PARENT_PID": "41"},
        platform="linux",
        waiter=waiter,
        on_exit=lambda c: exited.set(),
        grace_s=0.2,
    )
    with caplog.at_level(logging.INFO, logger="sidecar"):
        assert w.rearm(77, None) is True
        old_gone.set()
        assert not exited.wait(0.8)
        assert "server pid=41 exited" not in caplog.text  # the superseded server is not news
        new_gone.set()
        assert exited.wait(5)


def test_module_rearm_is_a_noop_without_a_watcher(monkeypatch: pytest.MonkeyPatch) -> None:
    """A hand-launched standalone sidecar has no watcher; a server adopting it
    must not start one (it never promised to own it)."""
    monkeypatch.setattr(parent_watch, "_active", None)
    assert parent_watch.rearm(55, None) is False


def test_module_rearm_reaches_the_active_watcher(monkeypatch: pytest.MonkeyPatch) -> None:
    block = threading.Event()
    w = parent_watch.start_parent_watch(
        env={"SIDECAR_PARENT_PID": "41"},
        platform="linux",
        waiter=lambda pid, ms: block.wait(10) and 0,
        on_exit=lambda c: None,
        grace_s=0,
    )
    try:
        assert parent_watch._active is w
        assert parent_watch.rearm(55, 9) is True
    finally:
        block.set()
        monkeypatch.setattr(parent_watch, "_active", None)


@pytest.mark.parametrize("pid", [0, -3])
def test_rearm_rejects_a_bad_pid(pid: int) -> None:
    block = threading.Event()
    w = parent_watch.start_parent_watch(
        env={"SIDECAR_PARENT_PID": "41"},
        platform="linux",
        waiter=lambda p, ms: block.wait(10) and 0,
        on_exit=lambda c: None,
        grace_s=0,
    )
    try:
        assert w.rearm(pid, None) is False
    finally:
        block.set()


def test_armed_and_off_are_logged(caplog: pytest.LogCaptureFixture) -> None:
    block = threading.Event()
    with caplog.at_level(logging.INFO, logger="sidecar"):
        parent_watch.start_parent_watch(env={}, platform="linux")
        assert "parent watch off" in caplog.text
        parent_watch.start_parent_watch(
            env={"SIDECAR_PARENT_PID": "41", "SIDECAR_PARENT_START_MS": "1700000000000"},
            platform="linux",
            waiter=lambda p, ms: block.wait(5) and 0,
            on_exit=lambda c: None,
            grace_s=0,
        )
        block.set()
    assert "parent watch armed" in caplog.text and "41" in caplog.text


def test_start_ms_is_passed_to_the_waiter() -> None:
    seen: list[tuple] = []
    done = threading.Event()

    def waiter(pid: int, start_ms) -> int:
        seen.append((pid, start_ms))
        done.set()
        return 0

    parent_watch.start_parent_watch(
        env={"SIDECAR_PARENT_PID": "41", "SIDECAR_PARENT_START_MS": "1700000000123"},
        platform="linux",
        waiter=waiter,
        on_exit=lambda c: None,
        grace_s=0,
    )
    assert done.wait(5)
    assert seen == [(41, 1700000000123)]


class _FakeWinApi:
    """Configurable stand-in for _Win32Api (all the knobs the checks read)."""

    def __init__(self, *, wait_result=0, code=0xC0000409, created_ms=None, code_ok=True):
        self.wait_result = wait_result
        self.code = code
        self.created_ms = created_ms
        self.code_ok = code_ok

    def open_process(self, pid):
        return 99

    def wait(self, handle) -> int:
        return self.wait_result

    def exit_code(self, handle):
        return self.code if self.code_ok else None

    def creation_ms(self, handle):
        return self.created_ms

    def close(self, handle) -> None:
        pass

    def last_error(self) -> int:
        return 0


@pytest.mark.parametrize("wait_result", [0xFFFFFFFF, 0x102, 0x80])  # FAILED, TIMEOUT, ABANDONED
def test_windows_unexpected_wait_result_is_watch_unavailable(wait_result: int) -> None:
    with pytest.raises(parent_watch.WatchUnavailable):
        parent_watch.wait_for_pid_windows(1, api=_FakeWinApi(wait_result=wait_result))


def test_windows_false_get_exit_code_is_watch_unavailable() -> None:
    with pytest.raises(parent_watch.WatchUnavailable):
        parent_watch.wait_for_pid_windows(1, api=_FakeWinApi(code_ok=False))


def test_windows_still_active_exit_code_is_watch_unavailable() -> None:
    with pytest.raises(parent_watch.WatchUnavailable):
        parent_watch.wait_for_pid_windows(1, api=_FakeWinApi(code=259))


def test_windows_creation_time_mismatch_means_the_parent_is_gone() -> None:
    """The pid now belongs to a different (younger) process: PID reuse."""
    with pytest.raises(parent_watch.ParentGone):
        parent_watch.wait_for_pid_windows(
            1, start_ms=1_700_000_000_000, api=_FakeWinApi(created_ms=1_700_000_000_000 + 600_000)
        )


def test_windows_creation_time_match_within_tolerance_keeps_watching() -> None:
    api = _FakeWinApi(created_ms=1_700_000_000_000 + 400)
    assert parent_watch.wait_for_pid_windows(1, start_ms=1_700_000_000_000, api=api) == 0xC0000409


def test_windows_no_start_ms_skips_the_identity_check() -> None:
    api = _FakeWinApi(created_ms=5)
    assert parent_watch.wait_for_pid_windows(1, start_ms=None, api=api) == 0xC0000409


def test_main_exposes_post_parent_and_rearm_wiring() -> None:
    src = (SIDECAR_ROOT / "main.py").read_text(encoding="utf-8")
    assert '@app.post("/parent")' in src
    assert "parent_watch.rearm(" in src


def test_post_parent_route_rearms_for_a_loopback_caller(monkeypatch: pytest.MonkeyPatch) -> None:
    pytest.importorskip("httpx")
    from fastapi.testclient import TestClient

    import main

    calls: list[tuple] = []
    monkeypatch.setattr(main.parent_watch, "rearm", lambda pid, ms: calls.append((pid, ms)) or True)
    c = TestClient(main.app, client=("127.0.0.1", 50000))
    r = c.post("/parent", json={"pid": 4321, "startMs": 1700000000999})
    assert r.status_code == 200 and r.json() == {"armed": True}
    assert calls == [(4321, 1700000000999)]


def test_post_parent_route_reports_exiting_when_the_grace_ran_out(monkeypatch: pytest.MonkeyPatch) -> None:
    pytest.importorskip("httpx")
    from fastapi.testclient import TestClient

    import main

    monkeypatch.setattr(main.parent_watch, "rearm", lambda pid, ms: False)
    monkeypatch.setattr(main.parent_watch, "is_exiting", lambda: True)
    c = TestClient(main.app, client=("127.0.0.1", 50000))
    r = c.post("/parent", json={"pid": 4321})
    assert r.status_code == 200 and r.json() == {"armed": False, "reason": "exiting"}
    monkeypatch.setattr(main.parent_watch, "is_exiting", lambda: False)
    assert c.post("/parent", json={"pid": 4321}).json() == {"armed": False}


def test_post_parent_route_refuses_a_non_loopback_caller(monkeypatch: pytest.MonkeyPatch) -> None:
    pytest.importorskip("httpx")
    from fastapi.testclient import TestClient

    import main

    calls: list[tuple] = []
    monkeypatch.setattr(main.parent_watch, "rearm", lambda pid, ms: calls.append((pid, ms)) or True)
    c = TestClient(main.app, client=("10.1.2.3", 50000))
    assert c.post("/parent", json={"pid": 4321}).status_code == 403
    assert calls == []


# --- production-default subprocess tests (no injected on_exit) --------------


_SIDECAR_LIKE = """
import sys, logging, time, threading
sys.path.insert(0, {sidecar_dir!r})
logging.basicConfig(level=logging.INFO, format='%(asctime)s.%(msecs)03d [sidecar] %(message)s')
import parent_watch
parent_watch.start_parent_watch(grace_s={grace})
{extra}
t0 = time.time()
while time.time() - t0 < {run_s}:
    sum(range(100000))
print('SIDECAR SURVIVED', flush=True)
"""


def _spawn_sidecar_like(tmp_path: Path, server_pid: int, grace: float, run_s: float, extra: str = ""):
    import os
    import subprocess

    err = tmp_path / "sidecar.err.log"
    f = open(err, "wb")
    env = dict(os.environ, SIDECAR_PARENT_PID=str(server_pid))
    env.pop("SIDECAR_PARENT_START_MS", None)
    code = _SIDECAR_LIKE.format(sidecar_dir=str(SIDECAR_ROOT), grace=grace, run_s=run_s, extra=extra)
    p = subprocess.Popen([sys.executable, "-c", code], env=env, stderr=f, stdout=f)
    return p, err, f


def _wait_for_text(path: Path, text: str, timeout: float) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if text in path.read_text(encoding="utf-8", errors="replace"):
            return True
        time.sleep(0.05)
    return False


def test_production_defaults_log_then_exit_after_the_grace(tmp_path: Path) -> None:
    """No injected on_exit: the real default must really end the process (a
    SystemExit raised in a daemon thread would be silently swallowed)."""
    import subprocess

    server = subprocess.Popen([sys.executable, "-c", "import time, os; time.sleep(4); os._exit(-1073740791)"])
    side, err, f = _spawn_sidecar_like(tmp_path, server.pid, grace=1.5, run_s=25)
    try:
        assert _wait_for_text(err, "parent watch armed", 15)
        t0 = time.time()
        server.wait(timeout=30)  # reaps it (POSIX zombies still answer kill(pid, 0))
        side.wait(timeout=20)
        took = time.time() - t0
    finally:
        for p in (server, side):
            if p.poll() is None:
                p.kill()
        f.close()
    text = err.read_text(encoding="utf-8", errors="replace")
    assert "SIDECAR SURVIVED" not in text
    assert f"server pid={server.pid}" in text and "exited" in text
    if sys.platform == "win32":
        assert "0xC0000409" in text
    assert took < 15


def test_production_defaults_rearm_within_the_grace_keeps_the_sidecar(tmp_path: Path) -> None:
    import subprocess

    server1 = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(3)"])
    server2 = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    extra = f"threading.Timer(4.0, lambda: parent_watch.rearm({server2.pid}, None)).start()"
    side, err, f = _spawn_sidecar_like(tmp_path, server1.pid, grace=6.0, run_s=11, extra=extra)
    try:
        assert _wait_for_text(err, "parent watch armed", 15)
        server1.wait(timeout=30)
        side.wait(timeout=40)
    finally:
        for p in (server1, server2, side):
            if p.poll() is None:
                p.kill()
        f.close()
    text = err.read_text(encoding="utf-8", errors="replace")
    assert "SIDECAR SURVIVED" in text
    assert "re-armed" in text


def test_the_grace_exit_uses_its_own_nonzero_code() -> None:
    """Not 0 (reads as a clean exit / a pytest pass) and not 42-44 (poison, drain-restart, model-load fault)."""
    assert parent_watch.GRACE_EXIT_CODE not in (0, 42, 43, 44)
    codes: list[int] = []
    done = threading.Event()
    parent_watch.start_parent_watch(
        env={"SIDECAR_PARENT_PID": "41"},
        platform="linux",
        waiter=lambda pid, ms: 1,
        on_exit=lambda c: (codes.append(c), done.set()),
        grace_s=0.05,
    )
    assert done.wait(5)
    assert codes == [parent_watch.GRACE_EXIT_CODE]


def test_posix_start_time_mismatch_means_the_parent_is_gone(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(parent_watch, "_posix_creation_ms", lambda pid: 1_700_000_000_000 + 600_000)
    with pytest.raises(parent_watch.ParentGone):
        parent_watch.wait_for_pid_posix(5, start_ms=1_700_000_000_000, poll_s=0, sleep=lambda s: None)


def test_posix_start_time_unreadable_keeps_watching(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(parent_watch, "_posix_creation_ms", lambda pid: None)

    def gone(pid: int, sig: int) -> None:
        raise ProcessLookupError

    monkeypatch.setattr(parent_watch.os, "kill", gone)
    assert parent_watch.wait_for_pid_posix(5, start_ms=1_700_000_000_000, poll_s=0, sleep=lambda s: None) is None


# --- N1: a wall-clock step must not read as "pid reused" (POSIX) ---------------


def _creation_times(monkeypatch: pytest.MonkeyPatch, server_ms, ancestors=()) -> None:
    monkeypatch.setattr(parent_watch, "_posix_creation_ms", lambda pid: server_ms)
    monkeypatch.setattr(parent_watch, "_ancestor_pids", lambda: set(ancestors))

    def gone(pid: int, sig: int) -> None:
        raise ProcessLookupError

    monkeypatch.setattr(parent_watch.os, "kill", gone)


def test_posix_an_ancestor_is_accepted_even_when_start_ms_is_off(monkeypatch: pytest.MonkeyPatch) -> None:
    """The server that spawned us is in our process ancestry: no clock is involved,
    so a stepped wall clock (start_ms 20 s off) cannot call it a reused pid."""
    start_ms = 1_700_000_000_000
    _creation_times(monkeypatch, server_ms=start_ms + 20_000, ancestors=[5])
    with pytest.raises(parent_watch.ParentGone):  # the absolute check is what would break
        parent_watch.wait_for_pid_posix(5, start_ms=start_ms, poll_s=0, sleep=lambda s: None)
    assert (
        parent_watch.wait_for_pid_posix(5, start_ms=start_ms, poll_s=0, sleep=lambda s: None, trust_ancestry=True)
        is None
    )


def test_posix_a_non_ancestor_falls_back_to_the_absolute_check(monkeypatch: pytest.MonkeyPatch) -> None:
    start_ms = 1_700_000_000_000
    _creation_times(monkeypatch, server_ms=start_ms + 20_000, ancestors=[999])
    with pytest.raises(parent_watch.ParentGone):
        parent_watch.wait_for_pid_posix(5, start_ms=start_ms, poll_s=0, sleep=lambda s: None, trust_ancestry=True)
    _creation_times(monkeypatch, server_ms=start_ms + 50, ancestors=[999])
    assert (
        parent_watch.wait_for_pid_posix(5, start_ms=start_ms, poll_s=0, sleep=lambda s: None, trust_ancestry=True)
        is None
    )


def test_posix_warn_only_logs_a_mismatch_and_keeps_watching(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """A /parent caller is alive on loopback, so a start-time mismatch (a clock
    step) is logged, never a reason to exit."""
    _creation_times(monkeypatch, server_ms=1_700_000_600_000)
    with caplog.at_level(logging.WARNING, logger="sidecar"):
        assert (
            parent_watch.wait_for_pid_posix(
                5, start_ms=1_700_000_000_000, poll_s=0, sleep=lambda s: None, warn_only=True
            )
            is None
        )
    assert "reused" in caplog.text


def _live_child(code: str):
    import subprocess

    return subprocess.Popen([sys.executable, "-c", code], stdout=subprocess.PIPE, text=True)


def test_real_posix_creation_ms_is_in_ms_and_ordered() -> None:
    """The REAL psutil read (every OS): a seconds/ms slip or a broken import would
    make every POSIX sidecar judge its live server "reused" (or never judge)."""
    import os

    pytest.importorskip("psutil")
    child = _live_child("import time; print(int(time.time()*1000), flush=True); time.sleep(1)")
    try:
        own_start_ms = int(child.stdout.readline())
        created = parent_watch._posix_creation_ms(child.pid)
        assert created is not None
        assert abs(created - own_start_ms) < 5_000
        assert created > parent_watch._posix_creation_ms(os.getpid())
    finally:
        child.wait()


@pytest.mark.skipif(sys.platform == "win32", reason="os.kill(pid, 0) sends Ctrl+C on Windows")
def test_real_posix_younger_child_reads_as_a_reused_pid() -> None:
    pytest.importorskip("psutil")
    child = _live_child("import time; time.sleep(2)")
    try:
        with pytest.raises(parent_watch.ParentGone):
            parent_watch.wait_for_pid_posix(
                child.pid, start_ms=int(time.time() * 1000) - 600_000, poll_s=0.05, trust_ancestry=True
            )
    finally:
        child.kill()
        child.wait()


def test_env_armed_posix_watch_trusts_ancestry_and_a_rearm_is_warn_only(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[tuple] = []
    done = threading.Barrier(2, timeout=5)

    def fake(pid, start_ms=None, poll_s=1.0, sleep=time.sleep, trust_ancestry=False, warn_only=False):
        seen.append((pid, start_ms, trust_ancestry, warn_only))
        done.wait()
        return None

    monkeypatch.setattr(parent_watch, "wait_for_pid_posix", fake)
    w = parent_watch.start_parent_watch(
        env={"SIDECAR_PARENT_PID": "41", "SIDECAR_PARENT_START_MS": "1700000000000"},
        platform="linux",
        on_exit=lambda c: None,
        grace_s=30,
    )
    done.wait()
    assert w.rearm(77, 1700000001000) is True
    done.wait()
    assert seen == [(41, 1700000000000, True, False), (77, 1700000001000, False, True)]


def test_ancestor_pids_lists_this_process_parents() -> None:
    import os

    pytest.importorskip("psutil")
    assert os.getppid() in parent_watch._ancestor_pids()
    assert os.getpid() not in parent_watch._ancestor_pids()


def test_ancestor_pids_is_empty_when_psutil_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    psutil = pytest.importorskip("psutil")

    def boom(*a, **k):
        raise psutil.Error("nope")

    monkeypatch.setattr(psutil, "Process", boom)
    assert parent_watch._ancestor_pids() == set()


# --- N6: a re-arm after the grace decision must not be told "armed" ----------


def test_rearm_after_the_grace_ran_out_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    exiting = threading.Event()
    release = threading.Event()

    def on_exit(code: int) -> None:
        exiting.set()
        release.wait(5)  # os._exit has not killed us yet: the window N6 describes

    w = parent_watch.start_parent_watch(
        env={"SIDECAR_PARENT_PID": "41"},
        platform="linux",
        waiter=lambda pid, ms: 1,
        on_exit=on_exit,
        grace_s=0.1,
    )
    try:
        assert exiting.wait(5)
        assert w.rearm(77, None) is False
    finally:
        release.set()


# --- a leaked SIDECAR_PARENT_PID must not arm the watch inside the test run -----


def test_conftest_drops_a_leaked_parent_pid_before_any_import(tmp_path: Path) -> None:
    """Run a throwaway pytest session that uses this directory's conftest, with the
    variables leaked in: the session's own tests must not see them."""
    import os
    import shutil
    import subprocess

    shutil.copy(Path(__file__).with_name("conftest.py"), tmp_path / "conftest.py")
    (tmp_path / "test_env.py").write_text(
        "import os\n"
        "def test_env_is_clean():\n"
        "    assert 'SIDECAR_PARENT_PID' not in os.environ\n"
        "    assert 'SIDECAR_PARENT_START_MS' not in os.environ\n",
        encoding="utf-8",
    )
    env = dict(os.environ, SIDECAR_PARENT_PID="4242", SIDECAR_PARENT_START_MS="1")
    r = subprocess.run(
        [sys.executable, "-m", "pytest", str(tmp_path), "-q", "-p", "no:cacheprovider"],
        capture_output=True,
        text=True,
        env=env,
    )
    assert r.returncode == 0, r.stdout + r.stderr
