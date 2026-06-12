/* fs-21 — SetupView. Thin wrapper that renders the five-step first-run wizard
   (SetupWizard) once readiness has loaded. The route owner (SetupRoute, C6)
   supplies mode (guided for a fresh setup, checklist for re-entry), onRefetch
   (re-probe readiness), and onFinish (completeSetup + navigate home).

   mode/onRefetch/onFinish carry safe defaults so the Wave 0 callers that pass
   only `readiness` keep compiling. */
import type { SetupReadiness } from '../lib/api';
import { SetupWizard } from '../components/setup/setup-wizard';

export function SetupView({
  readiness,
  mode = 'guided',
  onRefetch = () => {},
  onFinish = () => {},
}: {
  readiness: SetupReadiness | null;
  mode?: 'guided' | 'checklist';
  onRefetch?: () => void;
  onFinish?: () => void;
}) {
  if (readiness == null) {
    return (
      <main className="mx-auto max-w-2xl p-6">
        <h1 className="text-2xl font-semibold text-ink">Set up Castwright</h1>
        <p className="mt-2 text-ink/60 text-sm" data-testid="setup-checking">
          Checking…
        </p>
      </main>
    );
  }

  return (
    <SetupWizard
      readiness={readiness}
      mode={mode}
      onRefetch={onRefetch}
      onFinish={onFinish}
    />
  );
}
