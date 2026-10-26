/* #3084 wave 5 — Advanced settings → Analyzer request controls. Reasoning per
   engine and model (Ollama and Gemini both per model, P18). Saves a PARTIAL patch through
   the account save thunk; server-side validation messages are shown verbatim. */
import { useEffect, useMemo, useState } from 'react';
import { useAppDispatch, useAppSelector } from '../../store';
import { fetchAnalyzerCatalog, saveAccountSettings } from '../../store/account-slice';
import {
  REASONING_HELP,
  REASONING_LEVEL_LABELS,
  collectCatalogModels,
  normalizeOllamaReasoningMap,
  ollamaReasoningRows,
  type ReasoningLevel,
} from '../../lib/reasoning-levels';
import { settingsIssueMessages } from '../../lib/settings-issues';

const SELECT_CLASS =
  'w-full px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink focus:outline-hidden focus:ring-2 focus:ring-magenta/30 min-h-[44px] fine-pointer:min-h-0';
export function AnalyzerRequestControls() {
  const dispatch = useAppDispatch();
  const currentModel = useAppSelector((s) => s.account.defaultAnalysisModel);
  const savedOllama = useAppSelector((s) => s.account.analyzerReasoningByEngine?.ollama);
  const savedGemini = useAppSelector((s) => s.account.analyzerReasoningByEngine?.gemini);
  const catalog = useAppSelector((s) => s.account.analyzerCatalog);
  /* #3625 — while the settings file is unreadable the slice holds boot defaults; a save sends the whole
     analyzerReasoningByEngine key, which would replace the user's real maps. */
  const blocked = useAppSelector((s) => !!s.account.settingsFileUnreadable);
  const models = useMemo(() => collectCatalogModels(catalog), [catalog]);
  /* N10: saved levels are strings; N7: Ollama rows and their state are keyed by the normalised tag. */
  const [ollama, setOllama] = useState<Record<string, string>>(normalizeOllamaReasoningMap(savedOllama));
  const [gemini, setGemini] = useState<Record<string, string>>(savedGemini ?? {});
  const [errors, setErrors] = useState<string[]>([]);
  const [showSaved, setShowSaved] = useState(false);

  useEffect(() => setOllama(normalizeOllamaReasoningMap(savedOllama)), [savedOllama]);
  useEffect(() => setGemini(savedGemini ?? {}), [savedGemini]);
  useEffect(() => {
    if (catalog === null) void dispatch(fetchAnalyzerCatalog(undefined));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only: Layout, Test and endpoint saves refresh it
  }, []);

  /* P18: one row per Ollama model, each offering only ITS OWN levels; the current analysis model first. */
  const ollamaRows = useMemo(() => ollamaReasoningRows(models, currentModel, ollama), [models, currentModel, ollama]);
  const geminiModels = useMemo(
    () => models.filter((m) => m.kind === 'gemini' && m.offeredReasoningLevels.length > 1),
    [models],
  );

  const onSave = async () => {
    if (blocked) return;
    setErrors([]);
    const ollamaPatch = Object.fromEntries(Object.entries(ollama).filter(([, level]) => level !== 'off'));
    const geminiPatch = Object.fromEntries(Object.entries(gemini).filter(([, level]) => level !== 'model-default'));
    const action = await dispatch(saveAccountSettings({ analyzerReasoningByEngine: { ollama: ollamaPatch, gemini: geminiPatch } }));
    if (saveAccountSettings.rejected.match(action)) {
      setErrors(settingsIssueMessages(action.error.message ?? ''));
      return;
    }
    setShowSaved(true);
    setTimeout(() => setShowSaved(false), 2400);
  };

  return (
    <section
      data-testid="analyzer-request-controls"
      className="rounded-2xl border border-ink/10 bg-white p-6 shadow-card space-y-4"
    >
      <div>
        <h2 className="text-base font-semibold text-ink">Analyzer request controls</h2>
        <p className="mt-1 text-xs text-ink/55">{REASONING_HELP}</p>
      </div>

      <div className="space-y-3">
        <span className="block text-sm font-medium text-ink">Ollama reasoning, per model</span>
        <span className="block text-xs text-ink/55">
          Sent as &quot;think&quot;. Off is today&apos;s default. Low / Medium / High appear for a model once that model&apos;s own Test accepted them; a model that doesn&apos;t think rejects On and every level.
        </span>
        {ollamaRows.map((row) => (
          <label key={row.id} className="block">
            <span className="block text-xs text-ink/70">
              {row.label}
              {row.isCurrent ? ' (current analysis model)' : ''}
            </span>
            <select
              data-testid={`analyzer-reasoning-ollama-${row.id}`}
              data-model-id={row.id}
              value={ollama[row.id] ?? 'off'}
              onChange={(e) => setOllama((o) => ({ ...o, [row.id]: e.target.value }))}
              className={`mt-1 ${SELECT_CLASS}`}
            >
              {row.levels.map((l) => (
                <option key={l} value={l}>
                  {REASONING_LEVEL_LABELS[l as ReasoningLevel] ?? l}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>

      {geminiModels.length > 0 && (
        <div className="space-y-3">
          <span className="block text-sm font-medium text-ink">Gemini reasoning, per model</span>
          {geminiModels.map((m) => (
            <label key={m.id} className="block">
              <span className="block text-xs text-ink/70">{m.label}</span>
              <select
                data-testid={`analyzer-reasoning-gemini-${m.id}`}
                value={gemini[m.id] ?? 'model-default'}
                onChange={(e) => setGemini((g) => ({ ...g, [m.id]: e.target.value }))}
                className={`mt-1 ${SELECT_CLASS}`}
              >
                {m.offeredReasoningLevels.map((l) => (
                  <option key={l} value={l}>
                    {REASONING_LEVEL_LABELS[l]}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      )}

      {errors.length > 0 && (
        <ul data-testid="analyzer-request-controls-errors" className="text-xs text-rose-700 space-y-1">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-4">
        <button
          type="button"
          data-testid="analyzer-request-controls-save"
          disabled={blocked}
          onClick={() => void onSave()}
          className="px-4 py-2 rounded-xl bg-ink text-white text-sm font-medium min-h-[44px] fine-pointer:min-h-0 disabled:opacity-50"
        >
          Save request controls
        </button>
        {blocked && (
          <span data-testid="analyzer-request-controls-unreadable" className="text-xs text-rose-700">
            Your settings can&apos;t be read right now, so saving is off until they load.
          </span>
        )}
        {showSaved && <span className="text-xs text-magenta font-semibold">Saved.</span>}
      </div>
    </section>
  );
}
