/* #3084 — Settings "Test" for one analyzer model: confirms the request count (and the
   Gemini quota cost), routes through the forward GPU guard, runs POST
   /api/analyzer/models/test, then refreshes the catalog so the outcome shows. */
import { useState } from 'react';
import { useAppDispatch } from '../../store';
import { fetchAnalyzerCatalog } from '../../store/account-slice';
import { useLocalAnalyzerGuard } from '../../hooks/use-local-analyzer-guard';
import { ConfirmDialog } from '../../modals/confirm-dialog';
import { api } from '../../lib/api';
import type { AnalyzerCatalogEntry } from '../../lib/types';

export function describeTestOutcome(entry: AnalyzerCatalogEntry): string | null {
  /* A failed control or an inconclusive test saves no record (P7); its 502 message is shown
     through `error` below instead, and the previous outcome keeps showing here. */
  const record = entry.capability;
  if (!record) return null;
  /* `structuredOutput.label` never says "rejected" by design (P7) — it answers "does this
     mode need the schema adapter", not "did the last Test pass". A rejected configured
     mode must say so here, or the line reads identically to a pass and the next analysis
     refuses on a verdict this line never showed. `outcome` is the record's verdict for the
     configured mode at the level a run sends: absent means that mode was never probed (a
     'configured'-scope Test, then the endpoint switched mode), so the line must not claim
     it was — `tested` here is the record's date, not the mode's. */
  const { mode, outcome, label } = entry.structuredOutput;
  const testedAt = record.testedAt.slice(0, 10);
  if (!outcome) return `${mode} · not tested in this mode · last test ${testedAt}`;
  return `${outcome === 'rejected' ? `${mode} · rejected` : label} · tested ${testedAt}`;
}

export function ModelTestButton({ entry, label }: { entry: AnalyzerCatalogEntry; label: string }) {
  const dispatch = useAppDispatch();
  const { guard, modal } = useLocalAnalyzerGuard({ modelId: entry.id });
  const [confirming, setConfirming] = useState(false);
  const [scopeAll, setScopeAll] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requests = scopeAll ? entry.testPlan.all : entry.testPlan.configured;
  /* N6: a 500/502/503/504 is retried by the transport (3 attempts on Gemini and endpoints,
     1 on Ollama), so the count above is the minimum; the dialog states the maximum too. */
  const maxRequests = requests * entry.testPlan.attempts;
  const outcome = describeTestOutcome(entry);

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      await api.testAnalyzerModel({ modelId: entry.id, scope: scopeAll ? 'all' : 'configured' });
      await dispatch(fetchAnalyzerCatalog({ refresh: false }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        type="button"
        data-testid={`model-test-${entry.id}`}
        disabled={running}
        onClick={() => setConfirming(true)}
        className="px-3 py-1 rounded-full border border-ink/15 bg-white text-xs text-ink hover:bg-ink/5 disabled:opacity-50 min-h-[44px] fine-pointer:min-h-0"
      >
        {running ? 'Testing…' : 'Test'}
      </button>
      {outcome && (
        <span data-testid={`model-test-result-${entry.id}`} className="text-xs text-ink/60">
          {outcome}
        </span>
      )}
      {error && (
        <span role="alert" className="text-xs text-rose-700">
          {error}
        </span>
      )}
      <ConfirmDialog
        open={confirming}
        eyebrow="Test model"
        title={`Test ${label}?`}
        body={
          <>
            <p>
              This sends <b data-testid="model-test-request-count">{requests}</b> request{requests === 1 ? '' : 's'} to the
              model
              {maxRequests > requests ? (
                <>
                  {' '}
                  — up to <b data-testid="model-test-max-requests">{maxRequests}</b> if the server answers with an error
                  Castwright retries
                </>
              ) : null}
              {entry.engine === 'gemini' ? ", and they count against today's Gemini quota" : ''}.
            </p>
            <label className="mt-3 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={scopeAll}
                onChange={(e) => setScopeAll(e.target.checked)}
                data-testid="model-test-scope-all"
              />
              Test every structured-output mode
            </label>
          </>
        }
        confirmLabel="Run test"
        cancelLabel="Cancel"
        variant="default"
        onConfirm={() => {
          setConfirming(false);
          guard(() => void run());
        }}
        onClose={() => setConfirming(false)}
      />
      {modal}
    </span>
  );
}
