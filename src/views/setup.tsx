/* fs-21 Wave 0 — SetupView STUB. Renders the readiness summary so the gated
   #/setup route is real and testable. Wave 2 replaces this body with the
   five-step guided/checklist wizard; the props contract (readiness) stays. */
import type { SetupReadiness } from '../lib/api';

export function SetupView({ readiness }: { readiness: SetupReadiness | null }) {
  return (
    <main className="mx-auto max-w-2xl p-6">
      <h1 className="text-2xl font-semibold text-ink">Set up Castwright</h1>
      <p className="mt-2 text-ink/60 text-sm">
        We're checking that everything needed to produce an audiobook is in place.
      </p>
      <ul className="mt-6 space-y-2">
        {readiness &&
          Object.entries(readiness.blockers).map(([id, status]) => (
            <li
              key={id}
              className="flex items-center justify-between rounded-2xl border border-ink/10 bg-canvas px-4 py-3"
            >
              <span className="text-sm font-medium text-ink uppercase">{id}</span>
              <span className={status === 'pass' ? 'text-emerald-600' : 'text-amber-600'}>
                {status === 'pass' ? 'Ready' : 'Needs attention'}
              </span>
            </li>
          ))}
      </ul>
    </main>
  );
}
