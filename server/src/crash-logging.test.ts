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
  attachListenErrorHandler,
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

describe('attachListenErrorHandler', () => {
  it('EADDRINUSE error → logs the actionable line AND exits(1)', () => {
    const server = new EventEmitter();
    const onLog = vi.fn();
    const onExit = vi.fn();
    attachListenErrorHandler(server, 8080, { onLog, onExit });

    server.emit('error', Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' }));

    expect(onLog).toHaveBeenCalledWith(expect.stringContaining('already in use'));
    expect(onExit).toHaveBeenCalledWith(1);
  });

  it('a generic listen error → logs the FATAL line AND exits(1)', () => {
    const server = new EventEmitter();
    const onLog = vi.fn();
    const onExit = vi.fn();
    attachListenErrorHandler(server, 8443, { onLog, onExit });

    server.emit('error', Object.assign(new Error('permission denied'), { code: 'EACCES' }));

    expect(onLog).toHaveBeenCalledWith(expect.stringContaining('FATAL listen error'));
    expect(onExit).toHaveBeenCalledWith(1);
  });
});
