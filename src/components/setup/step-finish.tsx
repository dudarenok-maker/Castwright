/* fs-21 wave 3 — Step: Finish.
   Final wizard step. Two-tier smoke test:
     Tier 1 — "Run smoke test" button → api.runSmokeTest() → audible clip + analyzer status.
     Tier 2 — optional "Hear the demo book" button (threaded from SetupRoute in S4).
   A "Finish setup" button closes the wizard. */

import { useState } from 'react';
import { PrimaryButton } from '../primitives';
import { api } from '../../lib/api';
import type { SetupReadiness, SmokeTestResult } from '../../lib/api';

// ── prop types ──────────────────────────────────────────────────────────────

interface Props {
  /** Passed by the wizard orchestrator for contract uniformity. */
  readiness: SetupReadiness;
  /** Called when the user clicks "Finish setup". */
  onFinish: () => void;
  /** Optional — renders the "Hear the demo book" button when provided. */
  onTryDemoBook?: () => void;
}

// ── component ───────────────────────────────────────────────────────────────

export function StepFinish({ readiness: _readiness, onFinish, onTryDemoBook }: Props) {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<SmokeTestResult | null>(null);

  const runSmoke = async () => {
    setPending(true);
    setResult(null);
    try {
      const r = await api.runSmokeTest();
      setResult(r);
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="space-y-6">
      <h2 className="text-lg font-semibold text-ink">Finish</h2>

      <p className="text-sm text-ink/60">
        Everything looks good. When you're ready, finish setup to go to your library.
      </p>

      {/* Smoke-test card */}
      <div className="rounded-2xl border border-ink/10 bg-canvas px-4 py-4 space-y-3">
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium text-ink">End-to-end smoke test</span>
        </div>
        <p className="text-xs text-ink/55">
          Generate a short sample sentence through your configured voice engine and confirm
          audio comes back correctly before you start on your first book.
        </p>

        <button
          type="button"
          data-testid="smoke-test-placeholder"
          disabled={pending}
          onClick={runSmoke}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-ink/20 text-sm text-ink hover:bg-ink/5 disabled:opacity-50 disabled:cursor-wait transition-colors"
        >
          {pending ? 'Testing…' : 'Run smoke test'}
        </button>

        {/* Success result */}
        {result?.ok && (
          <div className="space-y-2">
            <audio
              controls
              src={result.url}
              data-testid="smoke-audio"
              className="w-full"
            />
            {result.analyzerDetail && (
              <p className="text-xs text-ink/60">Analyzer: {result.analyzerDetail}</p>
            )}
          </div>
        )}

        {/* Failure result */}
        {result && !result.ok && (
          <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-3 space-y-1">
            <p className="text-sm font-semibold text-rose-900">
              Smoke test failed at {result.stage}: {result.error}
            </p>
            <p className="text-xs text-rose-800/70">Fix the issue above and try again.</p>
          </div>
        )}
      </div>

      {/* Tier 2 — demo book (optional) */}
      {onTryDemoBook && (
        <div className="rounded-2xl border border-ink/10 bg-canvas px-4 py-4 space-y-3">
          <div>
            <span className="text-sm font-medium text-ink">Bundled demo audiobook</span>
            <p className="mt-1 text-xs text-ink/55">
              Generate the bundled demo audiobook end-to-end.
            </p>
          </div>
          <button
            type="button"
            onClick={onTryDemoBook}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-ink/20 text-sm text-ink hover:bg-ink/5 transition-colors"
          >
            Hear the demo book
          </button>
        </div>
      )}

      <div className="flex justify-end">
        <PrimaryButton onClick={onFinish} icon={false}>
          Finish setup
        </PrimaryButton>
      </div>
    </section>
  );
}
