/* #2192 / #3039 — put the venv's ONNX runtime back after an in-app pip install.
 *
 * `pip install qwen-tts` declares a plain `onnxruntime` dependency. On a healthy
 * NVIDIA venv the ORT marker (plan 282, install-ort.mjs) satisfies it and pip
 * touches nothing; on a venv without the marker — or one already half-clobbered
 * — pip lands the CPU build over `onnxruntime-gpu`'s files, and nothing else
 * would ever notice (the 2026-06-16 regression, re-found on-box in
 * docs/testing/onbox-a29-results/step-2-genuine-install.md). This is the
 * same swap install-ort.mjs's CLI, bootstrap-venv.mjs and upgrade/apply.ts
 * run, with the same three-part marker invariant:
 *   1. delete the marker BEFORE the first pip call — a stale marker present
 *      when `pip uninstall onnxruntime` runs makes pip resolve the name against
 *      TWO same-name dist-infos and can no-op the uninstall, leaving the plain
 *      build in place (and ensureOrtMarker at the next boot would then trust a
 *      marker that certifies a clobbered venv);
 *   2. delete it again if any step fails, then rethrow — never leave a marker
 *      that certifies a swap that did not complete;
 *   3. write it LAST, only after every step succeeded.
 * Unlike those three callers this runs on a venv that usually needs NOTHING:
 * when the GPU build already owns the namespace with no stray plain dist-info
 * (the exact state ensureOrtMarker treats as healthy), the force-reinstall is
 * skipped and the marker is only re-certified.
 *
 * Pure orchestration over an injected async `runPip` — the caller owns the
 * subprocess (and MUST run this with the sidecar held down: the swap replaces
 * the very DLLs the sidecar maps). Never spawns anything itself. */

// @ts-expect-error — standalone install script ships no .d.ts; helpers are plain JS.
import { planOrtSwap, applyOrtMarkerDelete, applyOrtMarkerWrite, ensureOrtMarker, sitePackagesDir, detectOrtOwner, findPlainOrtDistInfos } from '../../tts-sidecar/scripts/install-ort.mjs';

export type OrtRestoreOutcome =
  /** The profile wants plain onnxruntime — nothing to swap; any marker of ours is removed. */
  | 'not-needed'
  /** The GPU build already cleanly owns the namespace — no pip; marker re-certified. */
  | 'already-in-place'
  /** The swap steps ran and the marker was written. */
  | 'swapped';

export interface OrtRestoreDeps {
  venvDir: string;
  /** Accelerator profile to restore FOR — resolve it the way the sidecar
      itself will (spawn-sidecar.ts's resolveVenvRuntimeProfile), never from
      an env var only the sidecar child carries. */
  profile: string;
  platform: NodeJS.Platform;
  /** Run one `pip <args>` step with the venv python; resolves on exit 0,
      rejects otherwise. Async — a swap can take minutes and must not block
      the event loop. */
  runPip: (args: readonly string[]) => Promise<void>;
  log?: (msg: string) => void;
}

export async function restoreOrtRuntime(deps: OrtRestoreDeps): Promise<OrtRestoreOutcome> {
  const { venvDir, profile, platform, runPip, log = () => {} } = deps;
  const plan = planOrtSwap(profile, platform);
  if (plan.action === 'skip') {
    applyOrtMarkerDelete(venvDir, plan);
    return 'not-needed';
  }
  const sp = sitePackagesDir(venvDir);
  if (sp && detectOrtOwner(sp) === 'swap' && findPlainOrtDistInfos(sp).length === 0) {
    ensureOrtMarker(venvDir, log);
    return 'already-in-place';
  }
  applyOrtMarkerDelete(venvDir, plan);
  try {
    for (const step of plan.steps) {
      log(`[ort-restore] pip ${step.join(' ')}`);
      await runPip(step);
    }
  } catch (err) {
    applyOrtMarkerDelete(venvDir, plan);
    throw err;
  }
  applyOrtMarkerWrite(venvDir, plan);
  return 'swapped';
}
