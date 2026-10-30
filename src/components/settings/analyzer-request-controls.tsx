/* #3084 wave 5 — Advanced settings → Analyzer request controls. Reasoning per
   engine and model (Ollama and Gemini both per model, P18). Saves a PARTIAL patch through
   the account save thunk; server-side validation messages are shown verbatim. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppDispatch, useAppSelector } from '../../store';
import { fetchAnalyzerCatalog, saveAccountSettings } from '../../store/account-slice';
import {
  REASONING_HELP,
  REASONING_LEVEL_LABELS,
  collectCatalogModels,
  normalizeOllamaReasoningMap,
  normalizeOllamaTag,
  ollamaReasoningRows,
  type ReasoningLevel,
} from '../../lib/reasoning-levels';
import { settingsIssueMessages } from '../../lib/settings-issues';
import { parseExtraParamsText, payloadSetsOutputCap, type PayloadKind } from '../../lib/extra-params';

const SELECT_CLASS =
  'w-full px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink focus:outline-hidden focus:ring-2 focus:ring-magenta/30 min-h-[44px] fine-pointer:min-h-0';
export function AnalyzerRequestControls() {
  const dispatch = useAppDispatch();
  const currentModel = useAppSelector((s) => s.account.defaultAnalysisModel);
  const savedOllama = useAppSelector((s) => s.account.analyzerReasoningByEngine?.ollama);
  const savedGemini = useAppSelector((s) => s.account.analyzerReasoningByEngine?.gemini);
  const catalog = useAppSelector((s) => s.account.analyzerCatalog);
  const stage = useAppSelector((s) => s.ui.stage);
  const reasoningFocus = stage.kind === 'advanced' ? stage.reasoningFocus : undefined;
  const scrolledForRef = useRef<string | undefined>(undefined);
  /* Holds the pending highlight-removal timer (with its element) across re-runs of the highlight effect. */
  const highlightTimerRef = useRef<{ el: HTMLElement; timer: ReturnType<typeof setTimeout> } | null>(null);
  /* #3625 — while the settings file is unreadable the slice holds boot defaults; a save sends the whole
     analyzerReasoningByEngine key, which would replace the user's real maps. Likewise before the first
     hydration (boot fetch failed or pending): the rows show defaults, not the saved levels. */
  const unreadable = useAppSelector((s) => !!s.account.settingsFileUnreadable);
  const hydrated = useAppSelector((s) => s.account.hydrated);
  const blocked = unreadable || !hydrated;
  const models = useMemo(() => collectCatalogModels(catalog), [catalog]);
  /* N10: saved levels are strings; N7: Ollama rows and their state are keyed by the normalised tag. */
  const [ollama, setOllama] = useState<Record<string, string>>(normalizeOllamaReasoningMap(savedOllama));
  const [gemini, setGemini] = useState<Record<string, string>>(savedGemini ?? {});
  const [errors, setErrors] = useState<string[]>([]);
  const [showSaved, setShowSaved] = useState(false);

  /* Keyed on each engine's saved value, not its map: every settings save replaces the maps by reference, which
     would wipe an unsaved pick for reasoning that did not change. */
  const savedOllamaKey = JSON.stringify(savedOllama ?? {});
  const savedGeminiKey = JSON.stringify(savedGemini ?? {});
  useEffect(() => setOllama(normalizeOllamaReasoningMap(savedOllama)), [savedOllamaKey]); // eslint-disable-line react-hooks/exhaustive-deps -- keyed on the value
  useEffect(() => setGemini(savedGemini ?? {}), [savedGeminiKey]); // eslint-disable-line react-hooks/exhaustive-deps -- keyed on the value
  const savedPayloads = useAppSelector((s) => s.account.analyzerExtraParamsByEngine);
  /* Keyed on each engine's saved text, not the map: every settings save replaces the map by reference, which
     would wipe unsaved editor text for a payload that did not change. */
  const savedOllamaText = savedPayloads?.ollama ? JSON.stringify(savedPayloads.ollama, null, 2) : '';
  const savedGeminiText = savedPayloads?.gemini ? JSON.stringify(savedPayloads.gemini, null, 2) : '';
  const [payloadText, setPayloadText] = useState<Record<'ollama' | 'gemini', string>>({
    ollama: savedOllamaText,
    gemini: savedGeminiText,
  });
  useEffect(() => setPayloadText((t) => ({ ...t, ollama: savedOllamaText })), [savedOllamaText]);
  useEffect(() => setPayloadText((t) => ({ ...t, gemini: savedGeminiText })), [savedGeminiText]);
  const parsedPayloads = {
    ollama: parseExtraParamsText(payloadText.ollama),
    gemini: parseExtraParamsText(payloadText.gemini),
  };
  useEffect(() => {
    if (catalog === null) void dispatch(fetchAnalyzerCatalog(undefined));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only: Layout, Test and endpoint saves refresh it
  }, []);

  /* P18: one row per Ollama model, each offering only ITS OWN levels; the current analysis model first. */
  const ollamaRows = useMemo(() => ollamaReasoningRows(models, currentModel, ollama), [models, currentModel, ollama]);
  /* A row per Gemini model offering more than one level, plus one for every saved key (a stale level must
     stay visible and changeable even when the model now offers none, or has left the catalog). The saved
     value joins its row's options, like an Ollama row's. */
  const geminiModels = useMemo(() => {
    const listed = models.filter((m) => m.kind === 'gemini');
    const rows = [
      ...listed.filter((m) => m.offeredReasoningLevels.length > 1 || m.id in gemini),
      ...Object.keys(gemini)
        .filter((id) => !listed.some((m) => m.id === id))
        .map((id) => ({ id, label: id, kind: 'gemini' as const, offeredReasoningLevels: ['model-default'] as ReasoningLevel[] })),
    ];
    return rows.map((m) => {
      const saved = gemini[m.id] as ReasoningLevel | undefined;
      const levels: string[] = [...m.offeredReasoningLevels];
      if (saved !== undefined && !levels.includes(saved)) levels.push(saved);
      return { id: m.id, label: m.label, levels };
    });
  }, [models, gemini]);

  /* F7 deep link: scroll to and briefly highlight the row a reasoning-overflow fix names, once per focus value.
     The rows arrive after the catalog loads, so this re-runs when they do. No cleanup here: it would run before
     every re-run and cancel the removal timer; the timer is cleared on unmount only (next effect). */
  useEffect(() => {
    if (!reasoningFocus) return;
    const key = `${reasoningFocus.engine}:${reasoningFocus.model}`;
    if (scrolledForRef.current === key) return;
    const targetId =
      reasoningFocus.engine === 'ollama'
        ? `analyzer-reasoning-ollama-${normalizeOllamaTag(reasoningFocus.model)}`
        : `analyzer-reasoning-gemini-${reasoningFocus.model}`;
    const el = document.getElementById(targetId);
    if (!el) return;
    scrolledForRef.current = key;
    el.scrollIntoView?.({ block: 'center' });
    /* A second deep link inside the window must not strand the first row lit. */
    if (highlightTimerRef.current) {
      clearTimeout(highlightTimerRef.current.timer);
      highlightTimerRef.current.el.classList.remove('ring-2', 'ring-magenta/60');
    }
    el.classList.add('ring-2', 'ring-magenta/60');
    const timer = setTimeout(() => {
      el.classList.remove('ring-2', 'ring-magenta/60');
    }, 2400);
    highlightTimerRef.current = { el, timer };
  }, [reasoningFocus, ollamaRows, geminiModels]);

  useEffect(() => {
    return () => {
      if (highlightTimerRef.current) {
        clearTimeout(highlightTimerRef.current.timer);
        highlightTimerRef.current.el.classList.remove('ring-2', 'ring-magenta/60');
      }
    };
  }, []);

  const onSave = async () => {
    if (blocked) return;
    setErrors([]);
    if (!parsedPayloads.ollama.ok || !parsedPayloads.gemini.ok) return;
    const ollamaPatch = Object.fromEntries(Object.entries(ollama).filter(([, level]) => level !== 'off'));
    const geminiPatch = Object.fromEntries(Object.entries(gemini).filter(([, level]) => level !== 'model-default'));
    /* The whole map is sent every save (openapi: a PUT replaces it), so a blank editor clears that engine. */
    const analyzerExtraParamsByEngine: Record<string, Record<string, unknown>> = {};
    if (parsedPayloads.ollama.value) analyzerExtraParamsByEngine.ollama = parsedPayloads.ollama.value;
    if (parsedPayloads.gemini.value) analyzerExtraParamsByEngine.gemini = parsedPayloads.gemini.value;
    const action = await dispatch(
      saveAccountSettings({ analyzerReasoningByEngine: { ollama: ollamaPatch, gemini: geminiPatch }, analyzerExtraParamsByEngine }),
    );
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
          <label key={row.id} id={`analyzer-reasoning-ollama-${row.id}`} className="block">
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
            <label key={m.id} id={`analyzer-reasoning-gemini-${m.id}`} className="block">
              <span className="block text-xs text-ink/70">{m.label}</span>
              <select
                data-testid={`analyzer-reasoning-gemini-${m.id}`}
                value={gemini[m.id] ?? 'model-default'}
                onChange={(e) => setGemini((g) => ({ ...g, [m.id]: e.target.value }))}
                className={`mt-1 ${SELECT_CLASS}`}
              >
                {m.levels.map((l) => (
                  <option key={l} value={l}>
                    {REASONING_LEVEL_LABELS[l as ReasoningLevel] ?? l}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      )}

      {(['ollama', 'gemini'] as const).map((engine) => {
        const kind: PayloadKind = engine;
        const parsed = parsedPayloads[engine];
        const label = engine === 'ollama' ? 'Ollama' : 'Gemini';
        return (
          <label key={engine} className="block">
            <span className="block text-sm font-medium text-ink">{label} custom parameters</span>
            <span className="block text-xs text-ink/55 mt-0.5">
              {engine === 'ollama'
                ? 'JSON merged last into every Ollama request, e.g. {"options": {"min_p": 0.05}}. "options" merges key by key; null removes a key. A temperature here sets the first attempt only.'
                : 'JSON with a "config" object merged key by key into every Gemini request, e.g. {"config": {"topK": 40}}. Only temperature, topP, topK, maxOutputTokens, presencePenalty, frequencyPenalty, seed and safetySettings are accepted. A temperature here sets the first attempt only.'}{' '}
              Keys Castwright controls are refused on save. Never logged; long string values are hidden in provider errors. Not a place for credentials: keys belong in their own fields (the endpoint API key field, or the Gemini API key).
            </span>
            <textarea
              data-testid={`analyzer-extra-params-${engine}`}
              value={payloadText[engine]}
              onChange={(e) => setPayloadText((t) => ({ ...t, [engine]: e.target.value }))}
              rows={4}
              spellCheck={false}
              className="mt-2 w-full px-3 py-2 rounded-xl border border-ink/15 bg-white font-mono text-xs text-ink focus:outline-hidden focus:ring-2 focus:ring-magenta/30 min-h-[44px] fine-pointer:min-h-0"
            />
            {!parsed.ok && (
              <span data-testid={`analyzer-extra-params-${engine}-error`} className="block text-xs text-rose-700 mt-1">
                {parsed.error}
              </span>
            )}
            {parsed.ok && payloadSetsOutputCap(kind, parsed.value) && (
              <span data-testid={`analyzer-extra-params-${engine}-cap-note`} className="block text-xs text-amber-800 mt-1">
                This sets the output cap: {engine === 'ollama' ? 'Ollama num_predict' : 'Gemini max output tokens'} is not used for {label}, and the run label says so.
              </span>
            )}
          </label>
        );
      })}

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
            {unreadable
              ? 'Your settings can’t be read right now, so saving is off until they load.'
              : 'Your settings haven’t loaded yet, so saving is off until they do.'}
          </span>
        )}
        {showSaved && <span className="text-xs text-magenta font-semibold">Saved.</span>}
      </div>
    </section>
  );
}
