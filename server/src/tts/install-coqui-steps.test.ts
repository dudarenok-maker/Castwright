/* Regression coverage for the ordered pip-install steps install-coqui.mjs runs
   before the XTTS prefetch. The bug (side / #1586): coqui-tts 0.27.5 raises
   ImportError at package import on torch>=2.9 when torchcodec is absent (it
   presence-checks it via find_spec), so the opt-in installer MUST install
   torchcodec — after coqui-tts, before the `from TTS.api import TTS` prefetch —
   or `import TTS` fails on the torch 2.11 CVE-pinned venv and Coqui can't load.

   This asserts the pure step-plan directly (no venv, no network). The step-plan
   feeds main()'s loop, which runs each pip step before the prefetch, so the
   in-list order below is exactly the runtime order. The script ships no .d.ts;
   the guard runs only when invoked directly, so importing the helper is inert. */

import { describe, it, expect } from 'vitest';
// @ts-expect-error — standalone install helper ships no .d.ts; plain JS.
import { coquiPipInstallSteps } from '../../tts-sidecar/scripts/install-coqui.mjs';

const CONSTRAINTS = '/tmp/base-constraints.txt';

describe('coquiPipInstallSteps', () => {
  const steps = coquiPipInstallSteps(CONSTRAINTS);

  it('installs coqui-tts, then torchcodec, then the CJK phonemizers, in that order', () => {
    const pkgs = steps.map((s: { args: string[] }) => {
      const i = s.args.indexOf('install');
      return s.args[i + 1];
    });
    // First package named per step; the phonemizer step names pypinyin first.
    expect(pkgs).toEqual(['coqui-tts', 'torchcodec', 'pypinyin']);
  });

  it('installs torchcodec (without it, import TTS raises on torch>=2.9)', () => {
    const codec = steps.find((s: { args: string[] }) => s.args.includes('torchcodec'));
    expect(codec, 'torchcodec step must exist').toBeTruthy();
  });

  it('installs the XTTS CJK phonemizers (zh needs pypinyin; ja needs cutlet + unidic-lite dict)', () => {
    const cjk = steps.find((s: { args: string[] }) => s.args.includes('pypinyin'));
    expect(cjk, 'CJK phonemizer step must exist').toBeTruthy();
    // unidic-lite must be named explicitly — cutlet doesn't depend on it.
    expect(cjk!.args).toEqual(
      expect.arrayContaining(['pypinyin', 'cutlet', 'unidic-lite']),
    );
    // NOT --no-deps here: cutlet's transitive deps (fugashi/jaconv/mojimoji) are wanted.
    expect(cjk!.args).not.toContain('--no-deps');
  });

  it('never passes -U / --upgrade (must not perturb the pinned torch/coqui)', () => {
    for (const s of steps as { args: string[] }[]) {
      expect(s.args).not.toContain('-U');
      expect(s.args).not.toContain('--upgrade');
    }
  });

  it('installs torchcodec with --no-deps so it can never change the pinned torch', () => {
    const codec = steps.find((s: { args: string[] }) => s.args.includes('torchcodec'))!;
    expect(codec.args).toContain('--no-deps');
  });

  it('constrains coqui-tts by the passed constraints file', () => {
    const coqui = steps.find((s: { args: string[] }) => s.args.includes('coqui-tts'))!;
    expect(coqui.args).toContain('-c');
    expect(coqui.args).toContain(CONSTRAINTS);
  });
});
