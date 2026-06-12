/* fs-21 wave 2 — Step: Finish.
   Final wizard step. Shows a placeholder for the Wave-3 audible smoke test
   (arriving in the next release) and a "Finish setup" button that calls
   onFinish, which the orchestrator wires to completeSetup + navigate home. */

import { PrimaryButton } from '../primitives';
import type { SetupReadiness } from '../../lib/api';

// ── prop types ──────────────────────────────────────────────────────────────

interface Props {
  /** Passed by the wizard orchestrator for contract uniformity. */
  readiness: SetupReadiness;
  /** Called when the user clicks "Finish setup". */
  onFinish: () => void;
}

// ── component ───────────────────────────────────────────────────────────────

export function StepFinish({ readiness: _readiness, onFinish }: Props) {
  return (
    <section className="space-y-6">
      <h2 className="text-lg font-semibold text-ink">Finish</h2>

      <p className="text-sm text-ink/60">
        Everything looks good. When you're ready, finish setup to go to your library.
      </p>

      {/* Smoke-test placeholder — Wave 3 */}
      <div className="rounded-2xl border border-ink/10 bg-canvas px-4 py-4 space-y-3">
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium text-ink">End-to-end smoke test</span>
          <span className="inline-block px-2.5 py-0.5 rounded-full border border-ink/10 text-xs text-ink/50">
            Coming soon
          </span>
        </div>
        <p className="text-xs text-ink/55">
          The full audible end-to-end smoke test arrives in the next release. It will generate
          a short sample sentence through your configured voice engine and confirm audio
          comes back correctly before you start on your first book.
        </p>
        <button
          type="button"
          data-testid="smoke-test-placeholder"
          disabled
          className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-ink/15 text-sm text-ink/40 cursor-not-allowed"
          aria-disabled
        >
          Run smoke test
        </button>
      </div>

      <div className="flex justify-end">
        <PrimaryButton onClick={onFinish} icon={false}>
          Finish setup
        </PrimaryButton>
      </div>
    </section>
  );
}
