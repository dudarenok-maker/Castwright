/* fs-21 wave 2 — Step: Defaults.
   Informational step: pre-fills the four key defaults (voice engine, TTS
   model, analysis model, theme) from the account slice and dispatches
   saveAccountSettings on every change. Never blocks wizard progression. */

import { useEffect, useState } from 'react';
import { TTS_ENGINES, type TtsEngineId } from '../../lib/tts-models';
import { buildLocalModelOptions, buildModelOptionGroups } from '../../lib/models';
import type { TtsModelKey } from '../../lib/types';
import type { ThemePreference } from '../../lib/use-theme';
import { useAppDispatch, useAppSelector } from '../../store';
import { saveAccountSettings, fetchAnalyzerModels } from '../../store/account-slice';
import type { SetupReadiness } from '../../lib/api';

// ── prop types ──────────────────────────────────────────────────────────────

interface Props {
  /** Passed by the wizard orchestrator for contract uniformity. */
  readiness: SetupReadiness;
}

// ── shared select class ─────────────────────────────────────────────────────

const SELECT_CLS =
  'w-full px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink focus:outline-hidden focus:ring-2 focus:ring-magenta/30';

// ── component ───────────────────────────────────────────────────────────────

export function StepDefaults({ readiness: _readiness }: Props) {
  const dispatch = useAppDispatch();
  const account = useAppSelector((s) => s.account);

  /* Local mirror of the four persisted defaults. Re-syncs whenever the
     account slice rehydrates (e.g. after a successful save). */
  const effectiveTtsModelKey = account.resolvedTtsModelKey ?? account.defaultTtsModelKey;
  const [engine, setEngine] = useState<TtsEngineId>(account.defaultTtsEngine);
  const [ttsModel, setTtsModel] = useState<TtsModelKey>(effectiveTtsModelKey);
  const [analysisModel, setAnalysisModel] = useState<string>(account.defaultAnalysisModel);
  const [theme, setTheme] = useState<ThemePreference>(account.defaultThemePreference ?? 'system');

  /* Dynamic curated ∪ live-Ollama-tag union for the analysis-model picker, so a
     pulled-but-uncurated tag is selectable. Populated by fetchAnalyzerModels on
     mount; empty (offline) falls back to the curated catalog. */
  const analysisModelGroups = buildModelOptionGroups(
    buildLocalModelOptions(account.localAnalyzerModels),
  );
  useEffect(() => {
    void dispatch(fetchAnalyzerModels());
  }, [dispatch]);

  useEffect(() => {
    setEngine(account.defaultTtsEngine);
    setTtsModel(account.resolvedTtsModelKey ?? account.defaultTtsModelKey);
    setAnalysisModel(account.defaultAnalysisModel);
    setTheme(account.defaultThemePreference ?? 'system');
  }, [
    account.hydrated,
    account.defaultTtsEngine,
    account.defaultTtsModelKey,
    account.resolvedTtsModelKey,
    account.defaultAnalysisModel,
    account.defaultThemePreference,
  ]);

  /* When the engine switches, default to the new group's first model if the
     current model doesn't belong to it (mirrors model-settings-form). */
  const engineGroup = TTS_ENGINES.find((g) => g.id === engine) ?? TTS_ENGINES[0];
  useEffect(() => {
    if (!engineGroup.models.some((m) => m.id === ttsModel)) {
      setTtsModel(engineGroup.models[0].id);
    }
  }, [engine, engineGroup, ttsModel]);

  // ── change handlers ───────────────────────────────────────────────────────

  const handleEngineChange = (next: TtsEngineId) => {
    setEngine(next);
    void dispatch(saveAccountSettings({ defaultTtsEngine: next }));
  };

  const handleTtsModelChange = (next: TtsModelKey) => {
    setTtsModel(next);
    void dispatch(
      saveAccountSettings({
        defaultTtsModelKey: next,
        /* Pin the explicit flag so the saved choice isn't silently
           overridden by a future resolved default. Mirrors model-settings-form. */
        defaultTtsModelKeyExplicit: true,
      }),
    );
  };

  const handleAnalysisModelChange = (next: string) => {
    setAnalysisModel(next);
    void dispatch(saveAccountSettings({ defaultAnalysisModel: next }));
  };

  const handleThemeChange = (next: ThemePreference) => {
    setTheme(next);
    void dispatch(saveAccountSettings({ defaultThemePreference: next }));
  };

  // ── render ────────────────────────────────────────────────────────────────

  return (
    <section className="space-y-6">
      <h2 className="text-lg font-semibold text-ink">Defaults</h2>

      <p className="text-sm text-ink/60">
        These defaults are used the first time you open a new book. You can change
        them per-book later — this is just your starting point.
      </p>

      <div className="space-y-4">
        {/* Voice engine */}
        <div>
          <label htmlFor="setup-defaults-engine" className="block text-sm font-medium text-ink mb-1">
            Voice engine
          </label>
          <select
            id="setup-defaults-engine"
            value={engine}
            onChange={(e) => handleEngineChange(e.target.value as TtsEngineId)}
            className={SELECT_CLS}
          >
            {TTS_ENGINES.map((g) => (
              <option key={g.id} value={g.id} title={g.hint}>
                {g.label}
              </option>
            ))}
          </select>
        </div>

        {/* TTS model (filtered to selected engine) */}
        <div>
          <label htmlFor="setup-defaults-tts-model" className="block text-sm font-medium text-ink mb-1">
            Voice model
          </label>
          <select
            id="setup-defaults-tts-model"
            value={ttsModel}
            onChange={(e) => handleTtsModelChange(e.target.value as TtsModelKey)}
            className={SELECT_CLS}
          >
            {engineGroup.models.map((m) => (
              <option key={m.id} value={m.id} title={m.hint}>
                {m.label}
              </option>
            ))}
          </select>
        </div>

        {/* Analysis model */}
        <div>
          <label htmlFor="setup-defaults-analysis-model" className="block text-sm font-medium text-ink mb-1">
            Analysis model
          </label>
          <select
            id="setup-defaults-analysis-model"
            value={analysisModel}
            onChange={(e) => handleAnalysisModelChange(e.target.value)}
            className={SELECT_CLS}
          >
            {analysisModelGroups.map((g) => (
              <optgroup key={g.engine} label={g.label}>
                {g.models.map((m) => (
                  <option key={m.id} value={m.id} title={m.hint}>
                    {m.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>

        {/* Theme */}
        <div>
          <label htmlFor="setup-defaults-theme" className="block text-sm font-medium text-ink mb-1">
            Theme
          </label>
          <select
            id="setup-defaults-theme"
            value={theme}
            onChange={(e) => handleThemeChange(e.target.value as ThemePreference)}
            className={SELECT_CLS}
          >
            <option value="system">System (follow OS setting)</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </div>
      </div>
    </section>
  );
}
