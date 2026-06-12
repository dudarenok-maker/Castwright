/* fs-21 wave 2 — Step 1: Environment.
   Informational step: shows detected hardware via DevicePanel plus the
   readiness.info.gpu summary. Never blocks wizard progression. */

import type { SetupReadiness } from '../../lib/api';
import { DevicePanel } from '../device-panel';

interface Props {
  readiness: SetupReadiness;
  onRefetch: () => void;
}

export function StepEnvironment({ readiness, onRefetch }: Props) {
  return (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold text-ink">Environment</h2>

      <DevicePanel />

      <div className="rounded-2xl border border-ink/10 bg-canvas px-4 py-3 flex items-center justify-between gap-4">
        <p className="text-sm text-ink/70">
          <span className="text-ink/50">Detected:</span>{' '}
          <span className="font-medium text-ink">{readiness.info.gpu}</span>
        </p>
        <button
          type="button"
          onClick={onRefetch}
          className="shrink-0 px-3 py-1.5 rounded-full border border-ink/20 bg-white text-xs text-ink hover:bg-ink/5"
        >
          Re-check
        </button>
      </div>
    </section>
  );
}
