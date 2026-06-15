/* POST /api/accelerator/profile — switch the GPU accelerator profile (AMD phase 2).

   Switching the profile changes which torch / ONNX-runtime stack the sidecar runs
   on, which means a DIFFERENT Python venv. The seamless in-place "build-new-then-
   swap" rebuild was intentionally descoped (plan re-scope — Phase 1 ships
   detect-and-reinstall, not the resumable rebuild), so this route does NOT rebuild
   the venv itself. It:
     1. refuses while a generation / voice-design / analysis job is in flight (a
        reinstall must not race the write path or evict a model mid-job), and
     2. persists the ACCELERATOR override (or clears it for 'auto' → hardware
        detection), then
     3. reports rebuildRequired: true — the next sidecar bootstrap classifies the
        venv as needs-reinstall (the stamped profile no longer matches) and the
        existing reinstall flow rebuilds it fresh. Books + voices are untouched
        (the workspace is external to the venv). */

import { Router } from 'express';
import { writeConfigOverride, clearConfigOverride } from '../workspace/user-settings.js';
import { activeGenerationBooks } from './generation.js';
import { isAnyDesignBusy, isAnyAnalysisBusy } from '../tts/design-lock.js';

const PROFILES = ['auto', 'nvidia', 'amd', 'cpu'] as const;
const ACCELERATOR_KNOB_KEY = 'tts.accelerator';

export const acceleratorProfileRouter = Router();

acceleratorProfileRouter.post('/profile', async (req, res) => {
  const profile = (req.body ?? {}).profile;
  if (typeof profile !== 'string' || !(PROFILES as readonly string[]).includes(profile)) {
    res.status(400).json({ error: 'profile must be one of auto | nvidia | amd | cpu' });
    return;
  }

  // Job coordination: a profile switch reinstalls the venv + restarts the sidecar.
  const busyBooks = activeGenerationBooks();
  if (busyBooks.length > 0 || isAnyDesignBusy() || isAnyAnalysisBusy()) {
    res.status(409).json({
      error:
        'A generation, voice-design, or analysis job is running — switch the ' +
        'accelerator when the queue is idle.',
      busyBooks,
    });
    return;
  }

  // 'auto' clears the override so hardware detection drives the next build.
  if (profile === 'auto') await clearConfigOverride(ACCELERATOR_KNOB_KEY);
  else await writeConfigOverride(ACCELERATOR_KNOB_KEY, profile);

  res.json({ ok: true, profile, rebuildRequired: true });
});
