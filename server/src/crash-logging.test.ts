/* Crash-handler diagnostics (2026-05-30 silent-server-death incident).
 *
 * Pins: the crash line carries the stack/reason; uncaughtException logs + exits;
 * unhandledRejection logs but SURVIVES (no exit) so a transient async error
 * can't kill a long generation run. A plain EventEmitter stands in for `process`
 * so the test drives the handlers without touching the real process. */
import { describe, it, expect, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs, { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  formatCrash,
  enableFatalErrorReports,
  installCrashHandlers,
  installExitLogging,
  installShutdownSignals,
  formatListenError,
  listenWithAutoRebind,
  formatRebindExhausted,
} from './crash-logging.js';

/** #4054: the per-process flags every launcher passes node so a fatal report carries no env or interfaces. */
const LAUNCHER_FLAGS = ['--report-exclude-env', '--report-exclude-network'] as const;

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

  it.each([
    ['win32', 1],
    ['linux', 0],
    ['darwin', 0],
  ])('defaults the platform to the running one (%s): SIGHUP listeners %i', (platform, expected) => {
    const real = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: platform });
    try {
      const target = new EventEmitter();
      installShutdownSignals(vi.fn(), { target });
      expect(target.listenerCount('SIGHUP')).toBe(expected);
    } finally {
      Object.defineProperty(process, 'platform', real);
    }
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

describe('enableFatalErrorReports (#4054)', () => {
  // process.report as node leaves it when started with LAUNCHER_FLAGS (start-app-prod.mjs, server/package.json, pinokio start.js).
  const flagged = () => ({ reportOnFatalError: false, directory: '', excludeEnv: true, excludeNetwork: true });

  it('R1 enables: creates the dir, then writes only directory and then reportOnFatalError', () => {
    const report = flagged();
    const writes: [string, unknown][] = [];
    const mkdir = vi.fn(() => void writes.push(['mkdir', 'X/node-reports']));
    const recorded = new Proxy(report, {
      set(target, key, value) {
        writes.push([String(key), value]);
        return Reflect.set(target, key, value);
      },
    });
    const log = vi.fn();
    expect(enableFatalErrorReports('X/node-reports', { report: recorded, mkdir, log })).toBe(true);
    expect(mkdir).toHaveBeenCalledWith('X/node-reports');
    // The folder first, the directory before the switch (so no report can go to the old one),
    // and nothing else: not `filename`, and not the exclusion fields, which are only read.
    expect(writes).toEqual([
      ['mkdir', 'X/node-reports'],
      ['directory', 'X/node-reports'],
      ['reportOnFatalError', true],
    ]);
    const line = String(log.mock.calls[0][0]);
    expect(line).toContain('diagnostic report on a fatal error');
    expect(line).toContain('X/node-reports');
  });

  it('R2 a folder that cannot be made: logs OFF, returns false, leaves report untouched', () => {
    const report = flagged();
    const mkdir = vi.fn(() => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    });
    const log = vi.fn();
    let result: boolean | undefined;
    expect(() => {
      result = enableFatalErrorReports('X/node-reports', { report, mkdir, log });
    }).not.toThrow();
    expect(result).toBe(false);
    expect(report.reportOnFatalError).toBe(false);
    expect(report.directory).toBe('');
    const line = String(log.mock.calls[0][0]);
    expect(line).toContain('OFF');
    expect(line).toContain('EACCES');
  });

  it('R3 the real process.report: creates the folder, never touches filename', () => {
    const saved = {
      reportOnFatalError: process.report.reportOnFatalError,
      directory: process.report.directory,
      filename: process.report.filename,
      excludeEnv: process.report.excludeEnv,
      excludeNetwork: (process.report as unknown as { excludeNetwork: boolean }).excludeNetwork,
    };
    const sentinelKey = 'CW_4054_SENTINEL';
    const sentinel = ['cw4054', 'secret', String(process.pid)].join('-');
    const hadKey = Object.prototype.hasOwnProperty.call(process.env, sentinelKey);
    const savedKey = process.env[sentinelKey];
    process.env[sentinelKey] = sentinel;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-4054-'));
    // The parent is missing too (a fresh clone has no logs/ yet), so a non-recursive mkdir fails.
    const dir = path.join(root, 'logs', 'node-reports');
    try {
      // This vitest worker runs without LAUNCHER_FLAGS; stand in for them (restored below).
      process.report.excludeEnv = true;
      (process.report as unknown as { excludeNetwork: boolean }).excludeNetwork = true;
      expect(fs.existsSync(path.dirname(dir))).toBe(false);
      expect(enableFatalErrorReports(dir, { log: vi.fn() })).toBe(true);
      expect(fs.existsSync(dir)).toBe(true);
      expect(process.report.directory).toBe(dir);
      expect(process.report.reportOnFatalError).toBe(true);
      expect(process.report.filename).toBe(saved.filename);
      // getReport() always has an Environment, so it shows only the per-Environment setters.
      // A young-generation OOM has none and ignores them; R6 covers that path with a real OOM.
      const text = JSON.stringify(process.report.getReport());
      expect(text).not.toContain(sentinel);
      const parsed = JSON.parse(text) as { header: Record<string, unknown> } & Record<string, unknown>;
      expect(parsed.environmentVariables).toBeUndefined();
      expect(parsed.header.networkInterfaces).toBeUndefined();
    } finally {
      process.report.reportOnFatalError = saved.reportOnFatalError;
      process.report.directory = saved.directory;
      process.report.filename = saved.filename;
      process.report.excludeEnv = saved.excludeEnv;
      (process.report as unknown as { excludeNetwork: boolean }).excludeNetwork = saved.excludeNetwork;
      if (hadKey) process.env[sentinelKey] = savedKey;
      else delete process.env[sentinelKey];
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['neither flag', false, false],
    ['only --report-exclude-env', true, false],
    ['only --report-exclude-network', false, true],
  ])(
    'R5 fails closed unless node itself parsed both flags (%s): reports stay OFF',
    (_name, excludeEnv, excludeNetwork) => {
      const report = { reportOnFatalError: false, directory: '', excludeEnv, excludeNetwork };
      const mkdir = vi.fn();
      const log = vi.fn();
      expect(enableFatalErrorReports('X/node-reports', { report, mkdir, log })).toBe(false);
      expect(report.reportOnFatalError).toBe(false);
      expect(report.directory).toBe('');
      expect(mkdir).not.toHaveBeenCalled();
      const line = String(log.mock.calls[0][0]);
      expect(line).toContain('OFF');
      expect(line).toContain('--report-exclude-env --report-exclude-network');
    },
  );
});

/* #4054 pass 2 — a young-generation OOM (many small retained objects) has no
 * Environment, so the per-Environment excludeEnv/excludeNetwork setters do not
 * reach its report; a worker's sub-report has its own Environment and ignores
 * the main thread's setters too. Only the per-process options close both, so
 * these spawn a real heap exhaustion through the real enableFatalErrorReports.
 *
 * Pass 4 — the child's Worker is esbuild's shape (`execArgv: []`, which tsx's
 * esbuild sync API starts in dev). A Worker parses its own execArgv plus the
 * NODE_OPTIONS in its env, never the parent's command line, so the dev
 * launcher's NODE_OPTIONS (scripts/lib/report-exclusion.mjs) is what keeps its
 * sub-report clean. TSX_DISABLE_CACHE=1 makes every child transform cold, so the
 * result never depends on test order or on tsx's on-disk cache. */
describe('enableFatalErrorReports under a real fatal OOM (#4054)', () => {
  const serverDir = fileURLToPath(new URL('..', import.meta.url));
  const crashLogging = fileURLToPath(new URL('./crash-logging.ts', import.meta.url));
  const reportExclusion = new URL('../../scripts/lib/report-exclusion.mjs', import.meta.url).href;
  const sentinelKey = 'CW_4054_SENTINEL';
  const sentinel = ['cw4054', 'fatal', 'secret'].join('-');
  // `small`: many small objects, the young-generation OOM. `large`: big arrays,
  // an old-generation OOM, which has an Environment and so lists the worker.
  const CHILD = `
const { pathToFileURL } = await import('node:url');
const { Worker } = await import('node:worker_threads');
const [, , modPath, dir, shape, runtimeNodeOptions] = process.argv;
const mod = await import(pathToFileURL(modPath).href);
// What load-env.ts does with a NODE_OPTIONS line in server/.env: too late for node to parse.
if (runtimeNodeOptions) process.env.NODE_OPTIONS = runtimeNodeOptions;
mod.enableFatalErrorReports(dir);
const w = new Worker('setInterval(() => {}, 1000);', { eval: true, execArgv: [] });
await new Promise((r) => w.once('online', r));
const keep = [];
let i = 0;
if (shape === 'small') for (;;) keep.push({ a: i++, s: 'x' + i });
for (;;) keep.push(new Array(1e5).fill(i++));
`;

  /** The NODE_OPTIONS the dev launcher starts node with (from an env that had none). */
  async function devNodeOptions(): Promise<string> {
    const { withReportExclusionNodeOptions } = (await import(reportExclusion)) as {
      withReportExclusionNodeOptions: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
    };
    return withReportExclusionNodeOptions({}).NODE_OPTIONS ?? '';
  }

  function runOom(
    shape: 'small' | 'large',
    extraFlags: readonly string[],
    { nodeOptions = '', runtimeNodeOptions = '' }: { nodeOptions?: string; runtimeNodeOptions?: string } = {},
  ) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-4054-oom-'));
    const script = path.join(root, 'child.mjs');
    const dir = path.join(root, 'reports');
    fs.writeFileSync(script, CHILD);
    const env: NodeJS.ProcessEnv = { ...process.env, [sentinelKey]: sentinel, TSX_DISABLE_CACHE: '1' };
    delete env.NODE_OPTIONS;
    if (nodeOptions) env.NODE_OPTIONS = nodeOptions;
    try {
      const res = spawnSync(
        process.execPath,
        [
          '--import',
          'tsx',
          ...extraFlags,
          '--max-old-space-size=16',
          '--max-semi-space-size=16',
          script,
          crashLogging,
          dir,
          shape,
          runtimeNodeOptions,
        ],
        { cwd: serverDir, env, encoding: 'utf8', timeout: 60_000, windowsHide: true },
      );
      const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
      const reports = files.map((f) => fs.readFileSync(path.join(dir, f), 'utf8'));
      return { stdout: res.stdout, stderr: res.stderr, reports };
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  function allKeys(value: unknown, out: string[] = []): string[] {
    if (Array.isArray(value)) for (const v of value) allKeys(v, out);
    else if (value && typeof value === 'object')
      for (const [k, v] of Object.entries(value)) {
        out.push(k);
        allKeys(v, out);
      }
    return out;
  }

  type Report = { workers: unknown[] } & Record<string, unknown>;

  /** Up to five runs of runOom, until one leaves a whole report that took the GC path the shape
   *  is meant to prove: `large` an old-generation OOM (workers listed), `small` a young-generation
   *  one (none). Seen on Windows / Node 24.15: a 16 MiB OOM sometimes dies mid-write (0xC0000409:
   *  about 1 in 80 dev-shape `large` runs, 3 in 20 of the control's) and leaves a report cut off
   *  at 16 KiB, before workers[]; and about 1 in 80 `small` runs dies on the old-generation path.
   *  Returns every report text seen, rejected ones included, so a caller can check them all. */
  function runOomUntilWhole(
    shape: 'small' | 'large',
    extraFlags: readonly string[],
    opts: { nodeOptions?: string } = {},
  ): { stdout: string; texts: string[]; parsed: Report } {
    const texts: string[] = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      const { stdout, stderr, reports } = runOom(shape, extraFlags, opts);
      expect(stderr).toMatch(/heap out of memory/);
      expect(reports).toHaveLength(1);
      texts.push(reports[0]);
      let parsed: Report;
      try {
        parsed = JSON.parse(reports[0]) as Report;
      } catch {
        continue; // cut off mid-write: run it again
      }
      if ((parsed.workers.length > 0) === (shape === 'large')) return { stdout, texts, parsed };
    }
    throw new Error(`five runs in a row left no whole ${shape}-shape report`);
  }

  it.each(['small', 'large'] as const)(
    'R6 launched like the dev launcher (flags + its NODE_OPTIONS), a %s-object OOM writes a report with no env and no interfaces anywhere',
    async (shape) => {
      const nodeOptions = await devNodeOptions();
      const { texts, parsed } = runOomUntilWhole(shape, LAUNCHER_FLAGS, { nodeOptions });
      for (const text of texts) expect(text).not.toContain(sentinel);
      // `large` has an Environment, so the live workers' sub-reports are listed and checked too
      // (ours, plus tsx's esbuild worker on a cold transform); `small` lists none, the sign it
      // took the no-Environment young-generation path (runOomUntilWhole only accepts that).
      if (shape === 'large') expect(parsed.workers.length).toBeGreaterThan(0);
      else expect(parsed.workers).toHaveLength(0);
      const keys = allKeys(parsed);
      expect(keys).toContain('javascriptStack');
      expect(keys).not.toContain('environmentVariables');
      expect(keys).not.toContain('networkInterfaces');
    },
    30_000,
  );

  // The control for the case above: the pass-3 head's shape (flags on the command line only).
  // If this ever stops leaking, the case above no longer proves NODE_OPTIONS is what cleans it.
  it('R6 control: with the flags on the command line only, an execArgv:[] worker leaks the env into a large-object OOM report', () => {
    const { stdout, parsed } = runOomUntilWhole('large', LAUNCHER_FLAGS);
    expect(stdout).toContain('diagnostic report on a fatal error ->');
    expect(parsed.environmentVariables).toBeUndefined();
    expect(JSON.stringify(parsed.workers)).toContain(sentinel);
    expect(allKeys(parsed.workers)).toContain('environmentVariables');
  }, 30_000);

  it('R6 without the flags, a small-object OOM writes no report at all and says why at boot', () => {
    const { stdout, stderr, reports } = runOom('small', []);
    expect(stderr).toMatch(/heap out of memory/);
    expect(reports).toEqual([]);
    expect(stdout).toContain('diagnostic reports on a fatal error are OFF');
  }, 30_000);

  it('R6 T3 flags only in a NODE_OPTIONS set at runtime (a server/.env line): reports stay OFF', () => {
    const { stdout, stderr, reports } = runOom('small', [], { runtimeNodeOptions: LAUNCHER_FLAGS.join(' ') });
    expect(stderr).toMatch(/heap out of memory/);
    expect(reports).toEqual([]);
    expect(reports.join('')).not.toContain(sentinel);
    expect(stdout).toContain('diagnostic reports on a fatal error are OFF');
  }, 30_000);
});

describe('launchers pass the report-exclusion flags (#4054)', () => {
  const flagsBefore = (cmd: string, entry: string) =>
    expect(cmd).toMatch(new RegExp(`--report-exclude-env --report-exclude-network ${entry.replace('.', '\\.')}$`));

  it('server/package.json start, and dev (npm start, dev, dev:mock, dev:lan) through the NODE_OPTIONS wrapper', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      scripts: Record<string, string>;
    };
    flagsBefore(pkg.scripts.start, 'dist/index.js');
    expect(pkg.scripts.start).toMatch(/^node /);
    // dev goes through scripts/dev-server.mjs, which starts tsx with the flags on its
    // command line AND in NODE_OPTIONS (tsx's esbuild Worker reads only the latter).
    expect(pkg.scripts.dev).toBe('node ../scripts/dev-server.mjs');
    const src = readFileSync(new URL('../../scripts/dev-server.mjs', import.meta.url), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    expect(code).toMatch(/env: withReportExclusionNodeOptions\(baseEnv\)/);
    expect(code).toMatch(/'watch',\s*'--include=\.env',\s*\.\.\.REPORT_EXCLUSION_FLAGS,\s*'src\/index\.ts'/);
  });

  it("Pinokio's start.js", () => {
    const src = readFileSync(new URL('../../pinokio-scripts/start.js', import.meta.url), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    expect(code).toContain(
      "message: 'cd server && node --report-exclude-env --report-exclude-network dist/index.js',",
    );
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

  it('R4 enables fatal-error reports as the first statement of main(), never at module scope', () => {
    const src = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    // Anchored to main()'s opening brace: a gate or an early return before the call fails it.
    expect(code).toMatch(
      /async function main\(\): Promise<void> \{\s*enableFatalErrorReports\(resolve\(resolveLogDir\(repoRoot\), 'node-reports'\)\);\s*ensureWorkspace\(\);/,
    );
    const mainAt = code.indexOf('async function main(): Promise<void> {');
    expect(code.slice(0, mainAt)).not.toContain('enableFatalErrorReports(');
  });
});
