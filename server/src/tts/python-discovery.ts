/* fs-21 wave 1b — discover a Python 3.10–3.12 interpreter for the venv
   bootstrap (decision Z). Returns null when none found → the caller degrades
   to per-OS manual instructions. Injectable runFn for tests. */
import { spawnSync } from 'node:child_process';

type ProbeResult = { status: number | null; stdout: string; stderr: string };
type RunFn = (cmd: string, args: string[]) => ProbeResult;

const defaultRunFn: RunFn = (cmd, args) => {
  const r = spawnSync(cmd, [...args, '--version'], { windowsHide: true, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

export function findPython311(opts?: { platform?: NodeJS.Platform; runFn?: RunFn }): { cmd: string; args: string[] } | null {
  const platform = opts?.platform ?? process.platform;
  const runFn = opts?.runFn ?? defaultRunFn;
  const candidates: { cmd: string; args: string[] }[] =
    platform === 'win32'
      ? [{ cmd: 'py', args: ['-3.11'] }, { cmd: 'python', args: [] }]
      : [{ cmd: 'python3.11', args: [] }, { cmd: 'python3', args: [] }];
  for (const c of candidates) {
    const r = runFn(c.cmd, c.args);
    if (r.status !== 0) continue;
    const m = /Python (\d+)\.(\d+)/.exec(r.stdout || r.stderr);
    if (!m) continue;
    const major = Number(m[1]); const minor = Number(m[2]);
    if (major === 3 && minor >= 10 && minor <= 12) return { cmd: c.cmd, args: c.args };
  }
  return null;
}
