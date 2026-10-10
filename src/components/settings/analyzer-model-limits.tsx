/* #3084 — Advanced Settings → Analyzer rate limits: per-model RPM/TPM/RPD for Gemini
   and endpoint models (whole-map save of analyzerRateLimitsByModel) plus the Test
   action for every catalog model. Blank = default: Gemini env → built-in table;
   endpoints unlimited. Ollama has no limiter, so its rows only offer Test. */
import { useEffect, useState } from 'react';
import { useAppDispatch, useAppSelector } from '../../store';
import { fetchAnalyzerCatalog, saveAccountSettings } from '../../store/account-slice';
import { modelLabel } from '../../lib/model-label';
import type { UserSettings } from '../../lib/types';
import { ModelTestButton } from './model-test-button';

type LimitsMap = NonNullable<UserSettings['analyzerRateLimitsByModel']>;
type Field = 'rpm' | 'tpm' | 'rpd';
const FIELDS: readonly Field[] = ['rpm', 'tpm', 'rpd'];
const EMPTY: LimitsMap = {};

export function AnalyzerModelLimits() {
  const dispatch = useAppDispatch();
  const catalog = useAppSelector((s) => s.account.analyzerCatalog);
  const saved = useAppSelector((s) => s.account.analyzerRateLimitsByModel) ?? EMPTY;
  const [draft, setDraft] = useState<LimitsMap>(saved);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  useEffect(() => {
    void dispatch(fetchAnalyzerCatalog(undefined));
  }, [dispatch]);
  useEffect(() => {
    setDraft(saved);
  }, [saved]);

  const setField = (id: string, field: Field, raw: string) => {
    setDraft((prev) => {
      const nextEntry = { ...(prev[id] ?? {}) };
      const n = Number.parseInt(raw, 10);
      if (raw.trim() === '' || !Number.isFinite(n)) delete nextEntry[field];
      else nextEntry[field] = Math.max(field === 'tpm' ? 0 : 1, n);
      const next = { ...prev };
      if (Object.keys(nextEntry).length === 0) delete next[id];
      else next[id] = nextEntry;
      return next;
    });
  };

  const save = async () => {
    setStatus('saving');
    const action = await dispatch(saveAccountSettings({ analyzerRateLimitsByModel: draft }));
    setStatus(saveAccountSettings.fulfilled.match(action) ? 'saved' : 'error');
  };

  const groups = (catalog?.groups ?? []).filter((g) => g.models.length > 0);

  return (
    <div data-testid="analyzer-model-limits" className="py-3 space-y-4">
      <p className="text-xs text-ink/55">
        Leave a field blank to use the default: Gemini models use the GEMINI_RPM/TPM/RPD_&lt;model&gt; env vars, then the
        built-in free-tier limits; OpenAI-compatible endpoint models are unlimited. TPM 0 means unlimited. Local Ollama
        models have no rate limit and only offer Test.
      </p>
      {groups.map((g) => (
        <section key={`${g.kind}:${g.id}`}>
          <h4 className="text-xs font-semibold text-ink/70 mb-2">{g.label}</h4>
          {g.models.map((m) => {
            const label = modelLabel(m.id, catalog);
            return (
              <div key={m.id} data-testid={`model-limits-row-${m.id}`} className="flex flex-wrap items-center gap-2 py-1.5">
                <span className="text-sm text-ink flex-1 min-w-[10rem]">{label}</span>
                {g.kind !== 'ollama' &&
                  FIELDS.map((f) => (
                    <label key={f} className="inline-flex items-center gap-1 text-[11px] text-ink/60">
                      {f.toUpperCase()}
                      <input
                        type="number"
                        min={f === 'tpm' ? 0 : 1}
                        step={1}
                        value={draft[m.id]?.[f] ?? ''}
                        placeholder="default"
                        aria-label={`${label} ${f.toUpperCase()}`}
                        onChange={(e) => setField(m.id, f, e.target.value)}
                        className="w-24 px-2 py-1 rounded-lg border border-ink/15 bg-white text-sm text-ink min-h-[44px] fine-pointer:min-h-0"
                      />
                    </label>
                  ))}
                <ModelTestButton entry={m} label={label} />
              </div>
            );
          })}
        </section>
      ))}
      <div className="flex items-center gap-3">
        <button
          type="button"
          data-testid="model-limits-save"
          onClick={() => void save()}
          disabled={status === 'saving'}
          className="px-4 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink hover:bg-ink/5 min-h-[44px] fine-pointer:min-h-0"
        >
          {status === 'saving' ? 'Saving…' : 'Save rate limits'}
        </button>
        {status === 'saved' && <span className="text-xs text-magenta font-semibold">Saved.</span>}
        {status === 'error' && <span className="text-xs text-rose-700">Could not save rate limits.</span>}
      </div>
    </div>
  );
}
