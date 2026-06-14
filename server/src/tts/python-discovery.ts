/* fs-21 wave 1b / AMD-GPU Phase 1 — discover EXACTLY a Python 3.12 interpreter
   for the venv bootstrap (decision Z). Phase 1 pins the sidecar to 3.12
   (server/tts-sidecar/python-tag.txt = cp312), and bootstrap-venv.mjs stamps the
   REAL interpreter's tag — so the live finder must accept ONLY 3.12. A 3.11 or
   3.13 interpreter is REJECTED: building a venv with it would stamp cp311/cp313,
   which a subsequent detect/classify flags as needs-reinstall (a broken loop).
   Returns null when no 3.12 is found → the caller degrades to per-OS manual
   Python-3.12 acquisition guidance (see ensure-python312.mjs). Injectable runFn
   for tests. */
import { spawnSync } from 'node:child_process';

type ProbeResult = { status: number | null; stdout: string; stderr: string };
type RunFn = (cmd: string, args: string[]) => ProbeResult;

const defaultRunFn: RunFn = (cmd, args) => {
  const r = spawnSync(cmd, [...args, '--version'], { windowsHide: true, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

export function findPython312(opts?: { platform?: NodeJS.Platform; runFn?: RunFn }): { cmd: string; args: string[] } | null {
  const platform = opts?.platform ?? process.platform;
  const runFn = opts?.runFn ?? defaultRunFn;
  const candidates: { cmd: string; args: string[] }[] =
    platform === 'win32'
      ? [{ cmd: 'py', args: ['-3.12'] }, { cmd: 'python', args: [] }, { cmd: 'py', args: [] }]
      : [{ cmd: 'python3.12', args: [] }, { cmd: 'python3', args: [] }];
  for (const c of candidates) {
    const r = runFn(c.cmd, c.args);
    if (r.status !== 0) continue;
    const m = /Python (\d+)\.(\d+)/.exec(r.stdout || r.stderr);
    if (!m) continue;
    const major = Number(m[1]); const minor = Number(m[2]);
    // Accept ONLY 3.12 — a 3.11/3.13 interpreter would stamp a non-cp312 tag.
    if (major === 3 && minor === 12) return { cmd: c.cmd, args: c.args };
  }
  return null;
}
