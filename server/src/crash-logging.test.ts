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
  // What every launcher passes node (start-app-prod.mjs, server/package.json, pinokio start.js).
  const flags = { execArgv: [...LAUNCHER_FLAGS], nodeOptions: '' };

  it('R1 enables: creates the dir, then sets directory and reportOnFatalError', () => {
    const report = { reportOnFatalError: false, directory: '', excludeEnv: false, excludeNetwork: false };
    const mkdir = vi.fn();
    const log = vi.fn();
    expect(enableFatalErrorReports('X/node-reports', { report, mkdir, log, ...flags })).toBe(true);
    expect(mkdir).toHaveBeenCalledTimes(1);
    expect(mkdir).toHaveBeenCalledWith('X/node-reports');
    expect(report.directory).toBe('X/node-reports');
    expect(report.reportOnFatalError).toBe(true);
    // The report is attached to a public issue: no env vars (API keys, LAN token), no interfaces.
    expect(report.excludeEnv).toBe(true);
    expect(report.excludeNetwork).toBe(true);
    const line = String(log.mock.calls[0][0]);
    expect(line).toContain('diagnostic report on a fatal error');
    expect(line).toContain('X/node-reports');
  });

  it('R2 a folder that cannot be made: logs OFF, returns false, leaves report untouched', () => {
    const report = { reportOnFatalError: false, directory: '', excludeEnv: false, excludeNetwork: false };
    const mkdir = vi.fn(() => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    });
    const log = vi.fn();
    let result: boolean | undefined;
    expect(() => {
      result = enableFatalErrorReports('X/node-reports', { report, mkdir, log, ...flags });
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
      expect(fs.existsSync(path.dirname(dir))).toBe(false);
      expect(enableFatalErrorReports(dir, { log: vi.fn(), ...flags })).toBe(true);
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
    ['neither flag', [], ''],
    ['only --report-exclude-env', ['--report-exclude-env'], ''],
    ['only --report-exclude-network', [], '--report-exclude-network'],
    ['a flag negated later', [...LAUNCHER_FLAGS, '--no-report-exclude-env'], ''],
  ])('R5 fails closed without both per-process flags (%s): reports stay OFF', (_name, execArgv, nodeOptions) => {
    const report = { reportOnFatalError: false, directory: '', excludeEnv: false, excludeNetwork: false };
    const mkdir = vi.fn();
    const log = vi.fn();
    expect(enableFatalErrorReports('X/node-reports', { report, mkdir, log, execArgv, nodeOptions })).toBe(false);
    expect(report.reportOnFatalError).toBe(false);
    expect(report.directory).toBe('');
    expect(mkdir).not.toHaveBeenCalled();
    const line = String(log.mock.calls[0][0]);
    expect(line).toContain('OFF');
    expect(line).toContain('--report-exclude-env --report-exclude-network');
  });

  it('R5 accepts the flags from NODE_OPTIONS, or split across it and execArgv', () => {
    const cases: Array<[string[], string]> = [
      [[], '--max-old-space-size=4096 --report-exclude-env  --report-exclude-network'],
      [['--report-exclude-network'], '--report-exclude-env'],
    ];
    for (const [execArgv, nodeOptions] of cases) {
      const report = { reportOnFatalError: false, directory: '', excludeEnv: false, excludeNetwork: false };
      expect(
        enableFatalErrorReports('X/node-reports', { report, mkdir: vi.fn(), log: vi.fn(), execArgv, nodeOptions }),
      ).toBe(true);
      expect(report.reportOnFatalError).toBe(true);
    }
  });
});

/* #4054 pass 2 — a young-generation OOM (many small retained objects) has no
 * Environment, so the per-Environment excludeEnv/excludeNetwork setters do not
 * reach its report; a worker's sub-report has its own Environment and ignores
 * the main thread's setters too. Only the per-process flags close both, so
 * these spawn a real heap exhaustion through the real enableFatalErrorReports. */
describe('enableFatalErrorReports under a real fatal OOM (#4054)', () => {
  const serverDir = fileURLToPath(new URL('..', import.meta.url));
  const crashLogging = fileURLToPath(new URL('./crash-logging.ts', import.meta.url));
  const sentinelKey = 'CW_4054_SENTINEL';
  const sentinel = ['cw4054', 'fatal', 'secret'].join('-');
  // `small`: many small objects, the young-generation OOM. `large`: big arrays,
  // an old-generation OOM, which has an Environment and so lists the worker.
  const CHILD = `
const { pathToFileURL } = await import('node:url');
const { Worker } = await import('node:worker_threads');
const [, , modPath, dir, shape] = process.argv;
const mod = await import(pathToFileURL(modPath).href);
mod.enableFatalErrorReports(dir);
const w = new Worker('setInterval(() => {}, 1000);', { eval: true });
await new Promise((r) => w.once('online', r));
const keep = [];
let i = 0;
if (shape === 'small') for (;;) keep.push({ a: i++, s: 'x' + i });
for (;;) keep.push(new Array(1e5).fill(i++));
`;

  function runOom(shape: 'small' | 'large', extraFlags: readonly string[]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-4054-oom-'));
    const script = path.join(root, 'child.mjs');
    const dir = path.join(root, 'reports');
    fs.writeFileSync(script, CHILD);
    const env: NodeJS.ProcessEnv = { ...process.env, [sentinelKey]: sentinel };
    delete env.NODE_OPTIONS;
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

  it.each(['small', 'large'] as const)(
    'R6 with the launcher flags, a %s-object OOM writes a report with no env and no interfaces anywhere',
    (shape) => {
      const { stderr, reports } = runOom(shape, LAUNCHER_FLAGS);
      expect(stderr).toMatch(/heap out of memory/);
      expect(reports).toHaveLength(1);
      expect(reports[0]).not.toContain(sentinel);
      const parsed = JSON.parse(reports[0]) as { workers: unknown[] };
      if (shape === 'large') expect(parsed.workers).toHaveLength(1); // the worker's sub-report is checked too
      const keys = allKeys(parsed);
      expect(keys).toContain('javascriptStack');
      expect(keys).not.toContain('environmentVariables');
      expect(keys).not.toContain('networkInterfaces');
    },
    30_000,
  );

  it('R6 without the flags, a small-object OOM writes no report at all and says why at boot', () => {
    const { stdout, stderr, reports } = runOom('small', []);
    expect(stderr).toMatch(/heap out of memory/);
    expect(reports).toEqual([]);
    expect(stdout).toContain('diagnostic reports on a fatal error are OFF');
  }, 30_000);
});

describe('launchers pass the report-exclusion flags (#4054)', () => {
  const flagsBefore = (cmd: string, entry: string) =>
    expect(cmd).toMatch(new RegExp(`--report-exclude-env --report-exclude-network ${entry.replace('.', '\\.')}$`));

  it('server/package.json dev (npm start, dev, dev:lan) and start', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      scripts: Record<string, string>;
    };
    flagsBefore(pkg.scripts.dev, 'src/index.ts');
    expect(pkg.scripts.dev).toMatch(/^tsx watch /);
    flagsBefore(pkg.scripts.start, 'dist/index.js');
    expect(pkg.scripts.start).toMatch(/^node /);
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
