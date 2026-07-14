/* Crash-handler diagnostics (2026-05-30 silent-server-death incident).
 *
 * Pins: the crash line carries the stack/reason; uncaughtException logs + exits;
 * unhandledRejection logs but SURVIVES (no exit) so a transient async error
 * can't kill a long generation run. A plain EventEmitter stands in for `process`
 * so the test drives the handlers without touching the real process. */
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  formatCrash,
  installCrashHandlers,
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
