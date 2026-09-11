/* Shared helpers for install bootstraps (Qwen, Coqui, Kokoro, Whisper).
 * Hoisted from four per-engine files to eliminate duplication and ensure
 * consistency (findings 1-2 from PR #3197 review: idle watchdog and
 * active-generation refusal were missing from the three siblings).
 */

import { type ChildProcess } from 'node:child_process';
import { getActiveSupervisor } from './sidecar-supervisor.js';

/** Pull the actionable line(s) out of the installer's stderr tail.
    pip prints its own routine "[notice] A new release of pip is available…"
    line AFTER a real failure (including a WinError 5 traceback), so a naive
    "last N lines" slice can surface only that notice and hide the actual
    error. Drop pip's own notice lines first, then take the tail of what's
    left. Windows stderr is CRLF-terminated, so split on both LF and CR to
    avoid empty strings in the lines array. (#3039) */
export function extractInstallErrorDetail(stderrTail: string): string {
  const lines = stderrTail
    .trim()
    .split(/[\r\n]+/)
    .filter((line) => line.length > 0 && !/^\[notice\]/i.test(line.trim()));
  return lines.slice(-5).join(' ').trim();
}

/** Options for the runChild helper. */
export interface RunChildHooks {
  onStdoutLine?: (line: string) => void;
  failure: (code: number | null, detail: string) => string;
}

/** Options for the runChild timeout behavior. */
export interface RunChildOpts {
  /** How long a child may produce NO output before it is killed as stalled.
      Idle time, not wall clock: the download runs for many minutes but never
      goes quiet, whereas a stalled download never settles (#3043 M2).
      Defaults to DEFAULT_CHILD_IDLE_TIMEOUT_MS. */
  childIdleTimeoutMs?: number;
  /** Engine label for idle-timeout error message (e.g., 'install-qwen3'). */
  engineLabel: string;
}

/** 30 minutes of complete silence. Far past healthy steps, far short of forever. */
export const DEFAULT_CHILD_IDLE_TIMEOUT_MS = 30 * 60_000;

/** Spawn + await one child through spawnFn. Never blocks the event loop.
    The installer and pip steps run for minutes. Resolves on exit 0;
    rejects with `failure(code, stderrDetail)` otherwise.

    Includes an idle watchdog (#3043 M2): a child that produces no output
    for the full timeout is killed and reported as stalled, which releases
    the sidecar hold — without it a stalled child holds the sidecar down
    indefinitely and POST /api/sidecar/restart is inert. */
export function runChild(
  spawnFn: (cmd: string, args: readonly string[], opts?: any) => ChildProcess,
  repoRoot: string,
  cmd: string,
  args: readonly string[],
  hooks: RunChildHooks,
  opts: RunChildOpts,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let proc: ChildProcess;
    try {
      proc = spawnFn(cmd, args, { cwd: repoRoot, windowsHide: true });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    let stderrTail = '';
    /* Idle watchdog (#3043 M2). Rearmed on every byte either stream emits,
       so a slow-but-live download is never touched; a child that has gone
       completely quiet is killed and reported, which is what releases the hold. */
    let idleTimer: NodeJS.Timeout | null = null;
    let settled = false;
    const clearIdle = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
    };
    const armIdle = (): void => {
      clearIdle();
      const timeout = opts.childIdleTimeoutMs ?? DEFAULT_CHILD_IDLE_TIMEOUT_MS;
      idleTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          proc.kill();
        } catch {
          /* already gone — the reject below is still the outcome */
        }
        reject(
          new Error(
            `${cmd} produced no output for ${Math.round(timeout / 60_000)} minutes ` +
              'and was stopped as stalled. The voice engine has been released. Retry the install (downloads resume).',
          ),
        );
      }, timeout);
      idleTimer.unref?.();
    };
    armIdle();
    proc.stdout?.on('data', (b: Buffer) => {
      armIdle();
      if (!hooks.onStdoutLine) return;
      for (const line of b.toString('utf8').split('\n')) hooks.onStdoutLine(line);
    });
    proc.stderr?.on('data', (b: Buffer) => {
      armIdle();
      /* Keep only the tail — a pip/HF failure dump can be huge; the last
         few lines carry the actionable error. #3039: widened from 2000 to
         4000 chars so a real error isn't pushed out of the window by pip's
         own routine notice line(s) printed after it. */
      stderrTail = (stderrTail + b.toString('utf8')).slice(-4000);
    });
    proc.on('error', (err) => {
      clearIdle();
      if (settled) return;
      settled = true;
      reject(err);
    });
    proc.on('close', (code) => {
      clearIdle();
      if (settled) return; // the idle watchdog already reported this child
      settled = true;
      if (code === 0) resolve();
      else reject(new Error(hooks.failure(code, extractInstallErrorDetail(stderrTail))));
    });
  });
}

/** Default holdSidecarFn — runs `fn` inside the active supervisor's hold
    if one is registered, otherwise just runs `fn` as a pass-through. */
export function defaultHoldSidecar<T>(fn: () => Promise<T>): Promise<T> {
  const supervisor = getActiveSupervisor();
  return supervisor ? supervisor.withSidecarHeld(fn) : fn();
}
