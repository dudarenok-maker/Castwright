/* Crash-handler diagnostics (2026-05-30 silent-server-death incident).
 *
 * Pins: the crash line carries the stack/reason; uncaughtException logs + exits;
 * unhandledRejection logs but SURVIVES (no exit) so a transient async error
 * can't kill a long generation run. A plain EventEmitter stands in for `process`
 * so the test drives the handlers without touching the real process. */
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { formatCrash, installCrashHandlers } from './crash-logging.js';

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
