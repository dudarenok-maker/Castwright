/* Crash-handler diagnostics (2026-05-30 silent-server-death incident).
 *
 * Pins: the crash line carries the stack/reason; uncaughtException logs + exits;
 * unhandledRejection logs but SURVIVES (no exit) so a transient async error
 * can't kill a long generation run. A plain EventEmitter stands in for `process`
 * so the test drives the handlers without touching the real process. */
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import fs, { readFileSync } from 'node:fs';
import {
  formatCrash,
  installCrashHandlers,
  installExitLogging,
  installShutdownSignals,
  formatListenError,
  listenWithAutoRebind,
  formatRebindExhausted,
} from './crash-logging.js';

describe('formatCrash', () => {
  it('includes the kind and the Error stack', () => {
    const err = new Error('boom');
    const line = formatCrash('uncaughtException', err);
    expect(line).toContain('FATAL uncaughtException');
    expect(line).toContain(err.stack ?? 'boom'); // full stack when present
  });

  it('stringifies a non-Error rejection reason', () => {
    expect(formatCrash('unhandledRejection', 'just a string')).toContain('just a string');
    expect(formatCrash('unhandledRejection', { code: 42 })).toContain('[object Object]');
  });
});

describe('installCrashHandlers', () => {
  it('uncaughtException → logs the stack AND exits(1)', () => {
    const target = new EventEmitter();
    const onLog = vi.fn();
    const onExit = vi.fn();
    installCrashHandlers({ target, onLog, onExit });

    target.emit('uncaughtException', new Error('kaboom'));

    expect(onLog).toHaveBeenCalledWith(expect.stringContaining('uncaughtException'));
    expect(onLog).toHaveBeenCalledWith(expect.stringContaining('kaboom'));
    expect(onExit).toHaveBeenCalledWith(1);
  });

  it('unhandledRejection → logs the reason but does NOT exit (survives)', () => {
    const target = new EventEmitter();
    const onLog = vi.fn();
    const onExit = vi.fn();
    installCrashHandlers({ target, onLog, onExit });

    target.emit('unhandledRejection', new Error('transient sidecar fetch failed'));

    expect(onLog).toHaveBeenCalledWith(expect.stringContaining('transient sidecar fetch failed'));
    expect(onLog).toHaveBeenCalledWith(expect.stringContaining('survived'));
    expect(onExit).not.toHaveBeenCalled(); // the run keeps serving
  });
});

/* srv-17 — the captured FATALs were `listen EADDRINUSE` at startup (a
 * double-start), not a mid-run death. These pin the actionable bind-error
 * handling that keeps EADDRINUSE off the uncaughtException path. */
describe('formatListenError', () => {
  it('EADDRINUSE → actionable "already in use" hint naming the port', () => {
    const err: NodeJS.ErrnoException = Object.assign(new Error('listen EADDRINUSE'), {
      code: 'EADDRINUSE',
    });
    const line = formatListenError(8080, err);
    expect(line).toContain('8080');
    expect(line).toContain('already in use');
    expect(line).toContain('already running'); // points at the double-start cause
    expect(line).not.toContain('FATAL'); // friendly, not a raw crash dump
  });

  it('non-EADDRINUSE → generic FATAL line with the stack', () => {
    const err: NodeJS.ErrnoException = Object.assign(new Error('permission denied'), {
      code: 'EACCES',
    });
    const line = formatListenError(8443, err);
    expect(line).toContain('FATAL listen error on port 8443');
    expect(line).toContain(err.stack ?? 'permission denied');
  });
});

/* srv-60 — a busy port is now recovered by walking upward to a free one
 * (production only). listenWithAutoRebind owns the listen loop. A tiny fake
 * server records listen() calls and lets the test drive 'error'/'listening'. */
class FakeServer extends EventEmitter {
  listened: number[] = [];
  private boundPort: number | null = null;
  listen(port: number, _host?: string): void {
    this.listened.push(port);
    this.boundPort = port;
  }
  address() {
    return this.boundPort === null
      ? null
      : { address: '0.0.0.0', family: 'IPv4', port: this.boundPort };
  }
  /** Test helper: simulate the OS rejecting the most recent bind. */
  failInUse() {
    this.boundPort = null;
    this.emit('error', Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' }));
  }
  /** Test helper: simulate the most recent bind succeeding. */
  succeed() {
    this.emit('listening');
  }
}

describe('listenWithAutoRebind', () => {
  it('autoRebind: first port busy → re-listens on port+1, does NOT exit', () => {
    const server = new FakeServer();
    const onListening = vi.fn();
    const onExit = vi.fn();
    listenWithAutoRebind(server as never, {
      startPort: 8080,
      onListening,
      autoRebind: true,
      onLog: vi.fn(),
      onExit,
    });

    server.failInUse(); // 8080 busy
    server.succeed(); // 8081 binds

    expect(server.listened).toEqual([8080, 8081]);
    expect(onListening).toHaveBeenCalledTimes(1);
    expect(onListening).toHaveBeenCalledWith(8081); // the REAL bound port
    expect(onExit).not.toHaveBeenCalled();
  });

  it('autoRebind: onListening fires exactly once across a multi-attempt rebind', () => {
    const server = new FakeServer();
    const onListening = vi.fn();
    listenWithAutoRebind(server as never, {
      startPort: 8080,
      onListening,
      autoRebind: true,
      onLog: vi.fn(),
      onExit: vi.fn(),
    });

    server.failInUse(); // 8080
    server.failInUse(); // 8081
    server.succeed(); // 8082

    expect(onListening).toHaveBeenCalledTimes(1);
    expect(onListening).toHaveBeenCalledWith(8082);
  });

  it('dev (autoRebind off): EADDRINUSE → actionable line AND exit(1), no rebind', () => {
    const server = new FakeServer();
    const onLog = vi.fn();
    const onExit = vi.fn();
    listenWithAutoRebind(server as never, {
      startPort: 8080,
      onListening: vi.fn(),
      autoRebind: false,
      onLog,
      onExit,
    });

    server.failInUse();

    expect(server.listened).toEqual([8080]); // no retry
    expect(onLog).toHaveBeenCalledWith(expect.stringContaining('already in use'));
    expect(onExit).toHaveBeenCalledWith(1);
  });

  it('autoRebind: every port busy → after maxAttempts, exit(1); last try is startPort+19', () => {
    const server = new FakeServer();
    const onLog = vi.fn();
    const onExit = vi.fn();
    listenWithAutoRebind(server as never, {
      startPort: 8443,
      onListening: vi.fn(),
      autoRebind: true,
      onLog,
      onExit,
    });

    for (let i = 0; i < 20; i++) server.failInUse();

    expect(server.listened).toHaveLength(20);
    expect(server.listened[0]).toBe(8443);
    expect(server.listened[19]).toBe(8462); // startPort + (maxAttempts - 1)
    expect(onLog).toHaveBeenCalledWith(expect.stringContaining('8443'));
    expect(onLog).toHaveBeenCalledWith(expect.stringContaining('8462'));
    expect(onExit).toHaveBeenCalledWith(1);
  });

  it('a non-EADDRINUSE error → FATAL line AND exit(1), even with autoRebind on', () => {
    const server = new FakeServer();
    const onLog = vi.fn();
    const onExit = vi.fn();
    listenWithAutoRebind(server as never, {
      startPort: 8080,
      onListening: vi.fn(),
      autoRebind: true,
      onLog,
      onExit,
    });

    server.emit('error', Object.assign(new Error('permission denied'), { code: 'EACCES' }));

    expect(onLog).toHaveBeenCalledWith(expect.stringContaining('FATAL listen error'));
    expect(onExit).toHaveBeenCalledWith(1);
  });
});

describe('formatRebindExhausted', () => {
  it('names the scanned range and attempt count', () => {
    const line = formatRebindExhausted(8443, 20);
    expect(line).toContain('8443');
    expect(line).toContain('8462');
    expect(line).toContain('20');
  });
});

/* #4054 — a silent Windows server death (likely native 0xC0000409) left no
 * trace. The exit line is written with a SYNC fd write so it survives; the
 * SIGBREAK/SIGHUP handlers keep those signals from terminating node silently. */
describe('installExitLogging (#4054)', () => {
  it("process 'exit' → one sync line carrying the exit code", () => {
    const target = new EventEmitter();
    const write = vi.fn();
    installExitLogging({ target, write });

    target.emit('exit', 3221226505);

    expect(write).toHaveBeenCalledTimes(1);
    const line = String(write.mock.calls[0][0]);
    expect(line).toContain('[server] process exit');
    expect(line).toContain('3221226505');
    expect(line.endsWith('\n')).toBe(true);
  });

  it('the default writer goes to stderr (fd 2) via writeSync', () => {
    const target = new EventEmitter();
    const spy = vi.spyOn(fs, 'writeSync').mockImplementation(() => 0);
    try {
      installExitLogging({ target });
      target.emit('exit', 0);
      expect(spy).toHaveBeenCalledWith(2, expect.stringContaining('exit code 0'));
    } finally {
      spy.mockRestore();
    }
  });
});

describe('installExitLogging timestamp (#4054)', () => {
  it('stamps the line in local time with the standard logger format', () => {
    const target = new EventEmitter();
    const write = vi.fn();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 12, 14, 5, 9, 7)); // local 2026-11-12 14:05:09.007
    try {
      installExitLogging({ target, write });
      target.emit('exit', 1);
    } finally {
      vi.useRealTimers();
    }
    expect(String(write.mock.calls[0][0])).toMatch(
      /^2026-11-12 14:05:09\.007 \[server\] process exit — exit code 1\n$/,
    );
  });
});

describe('installShutdownSignals (#4054)', () => {
  it('registers SIGINT, SIGTERM, SIGBREAK and SIGHUP on win32', () => {
    const target = new EventEmitter();
    installShutdownSignals(vi.fn(), { target, platform: 'win32' });
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) {
      expect(target.listenerCount(sig)).toBe(1);
    }
  });

  it('leaves SIGHUP alone off win32, so an inherited nohup ignore survives', () => {
    const target = new EventEmitter();
    installShutdownSignals(vi.fn(), { target, platform: 'linux' });
    expect(target.listenerCount('SIGHUP')).toBe(0);
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
      expect(target.listenerCount(sig)).toBe(1);
    }
  });

  it('defaults the platform to the running one: SIGHUP only on win32', () => {
    const target = new EventEmitter();
    installShutdownSignals(vi.fn(), { target });
    expect(target.listenerCount('SIGHUP')).toBe(process.platform === 'win32' ? 1 : 0);
  });

  it('each signal is logged and routed to the shutdown path with its name', () => {
    const target = new EventEmitter();
    const shutdown = vi.fn();
    const onLog = vi.fn();
    installShutdownSignals(shutdown, { target, onLog, platform: 'win32' });

    target.emit('SIGBREAK');
    target.emit('SIGHUP');

    expect(onLog).toHaveBeenCalledWith(expect.stringContaining('SIGBREAK'));
    expect(onLog).toHaveBeenCalledWith(expect.stringContaining('SIGHUP'));
    expect(shutdown).toHaveBeenNthCalledWith(1, 'SIGBREAK');
    expect(shutdown).toHaveBeenNthCalledWith(2, 'SIGHUP');
  });
});

describe('index.ts wiring (#4054)', () => {
  it('installs the exit line at boot and routes signals through installShutdownSignals', () => {
    const src = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    // Strip comments first: a commented-out call must not satisfy the pin.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    expect(code).toMatch(/^installExitLogging\(\);$/m);
    expect(code).toMatch(/^[ \t]*installShutdownSignals\(shutdown\);$/m);
  });
});
