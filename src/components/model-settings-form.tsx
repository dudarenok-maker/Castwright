/* fs-23 — the model-flavored settings moved out of the Account view into the
   Model Manager: new-book defaults, the two-model analyzer split, TTS sidecar
   preferences, the server-config plumbing (sidecar/ollama URLs + analyzer
   engine + Gemini key), and the in-app installers. Self-contained: owns local
   form state for ONLY these fields, hydrates from the account slice, and Saves
   a PARTIAL UserSettingsPatch — so it coexists safely with the Account view's
   own Save (the server merges partial patches). The workspace-dir field
   deliberately stays in Account (a user-library concern, not a model one). */

import { useEffect, useMemo, useState } from 'react';
import { PrimaryButton } from './primitives';
import { FieldRow, GeminiKeyField, analyzerModelLabel } from './account-forms';
import {
  SettingsAccordion,
  SettingsSection,
  type SectionNavItem,
} from './settings/settings-accordion';
import { buildLocalModelOptions, buildModelOptionGroups } from '../lib/models';
import { TTS_ENGINES, type TtsEngineId } from '../lib/tts-models';
import type { ConfigGroup, TtsModelKey, UserSettingsPatch } from '../lib/types';
import { useAppDispatch, useAppSelector } from '../store';
import {
  saveAccountSettings,
  saveGeminiApiKey,
  fetchAnalyzerModels,
} from '../store/account-slice';
import { api } from '../lib/api';
import { isPrivateHostUrl } from '../lib/sidecar-url';
import { OllamaInstall } from './ollama-install';
import { ModelPullStatus } from './model-pull-status';

/* Synthetic ConfigGroup descriptors — these sections have no per-knob
   override tracking, so overriddenCount is always 0 and risk is 'low'.
   All sections default open (collapsedByDefault: false). */
const GROUP_DEFAULTS: ConfigGroup = {
  id: 'model-defaults',
  label: 'Defaults for new books',
  help: "Used the first time you open a book that hasn't been touched yet. Per-book choices override these and persist.",
  risk: 'low',
  collapsedByDefault: false,
};
const GROUP_ANALYZER_SPLIT: ConfigGroup = {
  id: 'model-analyzer-split',
  label: 'Two-model analyzer split (advanced)',
  help: 'Optional. By default both analysis passes run on your default analysis model. Pick a model for EACH phase to split the work: Phase 0 (cast detection) and Phase 1 (sentence attribution) then run on different models concurrently, with Phase 1 starting a few chapters behind Phase 0 (the minimum chapter lag below). This spreads load across two free-tier rate-limit buckets — e.g. Gemma 4 31B (1,500/day) for cast detection and Gemini 3.1 Flash Lite (500/day) for attribution — and finishes sooner. Leave both blank for the single-model default. Server env vars (ANALYZER_PHASE{0,1}_MODEL / ANALYZER_PHASE1_MIN_LAG_CHAPTERS) still override for ops triage.',
  risk: 'low',
  collapsedByDefault: false,
};
const GROUP_VOICE_ENGINE: ConfigGroup = {
  id: 'model-voice-engine',
  label: 'Voice engine',
  help: 'The local voice engine (a Python process) that runs Qwen3-TTS / Kokoro / Coqui XTTS. The Node server can launch it for you automatically.',
  risk: 'low',
  collapsedByDefault: false,
};
const GROUP_SERVER_CONFIG: ConfigGroup = {
  id: 'model-server-config',
  label: 'Server configuration',
  help: "Non-secret overrides for what's in server/.env. Voice engine URL and Ollama settings take effect on the next request.",
  risk: 'low',
  collapsedByDefault: false,
};
const GROUP_MODELS_INSTALL: ConfigGroup = {
  id: 'model-install',
  label: 'Install / update analyzer (Ollama)',
  help: 'Install the Ollama daemon and pull analyzer model weights without dropping to a terminal. The TTS / ASR models (Kokoro, Qwen, Coqui, Whisper) install from their rows in the inventory above.',
  risk: 'low',
  collapsedByDefault: false,
};

/* The form's sections, exported so a host view (the Model Manager) can fold
   them into a SINGLE side-nav rail instead of nesting a second accordion. */
export const MODEL_SETTINGS_SECTIONS: SectionNavItem[] = [
  { id: GROUP_DEFAULTS.id, label: GROUP_DEFAULTS.label, risk: GROUP_DEFAULTS.risk },
  {
    id: GROUP_ANALYZER_SPLIT.id,
    label: GROUP_ANALYZER_SPLIT.label,
    risk: GROUP_ANALYZER_SPLIT.risk,
  },
  { id: GROUP_VOICE_ENGINE.id, label: GROUP_VOICE_ENGINE.label, risk: GROUP_VOICE_ENGINE.risk },
  { id: GROUP_SERVER_CONFIG.id, label: GROUP_SERVER_CONFIG.label, risk: GROUP_SERVER_CONFIG.risk },
  {
    id: GROUP_MODELS_INSTALL.id,
    label: GROUP_MODELS_INSTALL.label,
    risk: GROUP_MODELS_INSTALL.risk,
  },
];

export function ModelSettingsForm({ embedded = false }: { embedded?: boolean } = {}) {
  const dispatch = useAppDispatch();
  const account = useAppSelector((s) => s.account);

  /* Dynamic curated ∪ live-Ollama-tag union for the three analyzer-model
     pickers (default + phase 0 + phase 1), so a pulled-but-uncurated tag is
     selectable. Populated by fetchAnalyzerModels on mount; empty (offline)
     falls back to the curated catalog. */
  const analyzerModelGroups = buildModelOptionGroups(
    buildLocalModelOptions(account.localAnalyzerModels),
  );
  useEffect(() => {
    void dispatch(fetchAnalyzerModels());
  }, [dispatch]);

  const [defaultAnalysisModel, setDefaultAnalysisModel] = useState(account.defaultAnalysisModel);
  const [defaultTtsEngine, setDefaultTtsEngine] = useState<TtsEngineId>(account.defaultTtsEngine);
  /* Picker shows the EFFECTIVE default (Qwen on a box with Qwen installed), not
     the stored key, so re-selecting a different engine is a real change. */
  const effectiveTtsModelKey = account.resolvedTtsModelKey ?? account.defaultTtsModelKey;
  const [defaultTtsModelKey, setDefaultTtsModelKey] = useState<TtsModelKey>(effectiveTtsModelKey);
  const [sidecarUrl, setSidecarUrl] = useState(account.sidecarUrl);
  const [analysisEngine, setAnalysisEngine] = useState<'local' | 'gemini'>(account.analysisEngine);
  const [ollamaUrl, setOllamaUrl] = useState(account.ollamaUrl);
  const [analyzerPhase0Model, setAnalyzerPhase0Model] = useState<string | null>(
    account.analyzerPhase0Model ?? null,
  );
  const [analyzerPhase1Model, setAnalyzerPhase1Model] = useState<string | null>(
    account.analyzerPhase1Model ?? null,
  );
  const [analyzerPhase1MinLagChapters, setAnalyzerPhase1MinLagChapters] = useState<number | null>(
    account.analyzerPhase1MinLagChapters ?? null,
  );
  const [autoStartSidecar, setAutoStartSidecar] = useState<boolean>(
    account.autoStartSidecar ?? true,
  );
  const [dualModelEnabled, setDualModelEnabled] = useState<boolean>(
    account.dualModelEnabled ?? false,
  );
  const [eagerLoadKokoro, setEagerLoadKokoro] = useState<boolean>(account.eagerLoadKokoro ?? true);
  const [eagerLoadQwen, setEagerLoadQwen] = useState<boolean>(account.eagerLoadQwen ?? true);
  const [generationWorkers, setGenerationWorkers] = useState<number>(
    account.generationWorkers ?? 1,
  );
  const [showSaved, setShowSaved] = useState(false);

  useEffect(() => {
    setDefaultAnalysisModel(account.defaultAnalysisModel);
    setDefaultTtsEngine(account.defaultTtsEngine);
    setDefaultTtsModelKey(account.resolvedTtsModelKey ?? account.defaultTtsModelKey);
    setSidecarUrl(account.sidecarUrl);
    setAnalysisEngine(account.analysisEngine);
    setOllamaUrl(account.ollamaUrl);
    setAnalyzerPhase0Model(account.analyzerPhase0Model ?? null);
    setAnalyzerPhase1Model(account.analyzerPhase1Model ?? null);
    setAnalyzerPhase1MinLagChapters(account.analyzerPhase1MinLagChapters ?? null);
    setAutoStartSidecar(account.autoStartSidecar ?? true);
    setDualModelEnabled(account.dualModelEnabled ?? false);
    setEagerLoadKokoro(account.eagerLoadKokoro ?? true);
    setEagerLoadQwen(account.eagerLoadQwen ?? true);
    setGenerationWorkers(account.generationWorkers ?? 1);
  }, [
    account.hydrated,
    account.defaultAnalysisModel,
    account.defaultTtsEngine,
    account.defaultTtsModelKey,
    account.resolvedTtsModelKey,
    account.sidecarUrl,
    account.analysisEngine,
    account.ollamaUrl,
    account.analyzerPhase0Model,
    account.analyzerPhase1Model,
    account.analyzerPhase1MinLagChapters,
    account.autoStartSidecar,
    account.dualModelEnabled,
    account.eagerLoadKokoro,
    account.eagerLoadQwen,
    account.generationWorkers,
  ]);

  /* When the engine switches, the selected modelKey may not belong to the new
     engine's group — default to the new group's first model. */
  const engineGroup = TTS_ENGINES.find((g) => g.id === defaultTtsEngine) ?? TTS_ENGINES[0];
  useEffect(() => {
    if (!engineGroup.models.some((m) => m.id === defaultTtsModelKey)) {
      setDefaultTtsModelKey(engineGroup.models[0].id);
    }
  }, [defaultTtsEngine, engineGroup, defaultTtsModelKey]);

  const persistedAutoStart = account.autoStartSidecar ?? true;
  const autoStartDirty = autoStartSidecar !== persistedAutoStart;
  const persistedEagerLoadKokoro = account.eagerLoadKokoro ?? true;
  const eagerLoadKokoroDirty = eagerLoadKokoro !== persistedEagerLoadKokoro;
  const persistedEagerLoadQwen = account.eagerLoadQwen ?? true;
  const eagerLoadQwenDirty = eagerLoadQwen !== persistedEagerLoadQwen;
  /* The eager-load toggle governs the DEFAULT engine only. */
  const eagerEngineIsQwen = defaultTtsModelKey === 'qwen3-tts-0.6b';

  /* srv-21 — block Save on a sidecar URL that isn't an http(s) private/loopback
     host (prevents pointing the server's outbound fetches at an arbitrary
     remote). Empty is allowed (falls back to the server default). */
  const sidecarUrlInvalid = sidecarUrl.trim() !== '' && !isPrivateHostUrl(sidecarUrl);

  const dirty = useMemo(() => {
    return (
      defaultAnalysisModel !== account.defaultAnalysisModel ||
      defaultTtsEngine !== account.defaultTtsEngine ||
      defaultTtsModelKey !== effectiveTtsModelKey ||
      sidecarUrl !== account.sidecarUrl ||
      analysisEngine !== account.analysisEngine ||
      ollamaUrl !== account.ollamaUrl ||
      analyzerPhase0Model !== (account.analyzerPhase0Model ?? null) ||
      analyzerPhase1Model !== (account.analyzerPhase1Model ?? null) ||
      analyzerPhase1MinLagChapters !== (account.analyzerPhase1MinLagChapters ?? null) ||
      dualModelEnabled !== (account.dualModelEnabled ?? false) ||
      generationWorkers !== (account.generationWorkers ?? 1) ||
      autoStartDirty ||
      eagerLoadKokoroDirty ||
      eagerLoadQwenDirty
    );
  }, [
    account,
    defaultAnalysisModel,
    defaultTtsEngine,
    defaultTtsModelKey,
    effectiveTtsModelKey,
    sidecarUrl,
    analysisEngine,
    ollamaUrl,
    analyzerPhase0Model,
    analyzerPhase1Model,
    analyzerPhase1MinLagChapters,
    dualModelEnabled,
    generationWorkers,
    autoStartDirty,
    eagerLoadKokoroDirty,
    eagerLoadQwenDirty,
  ]);

  const saving = account.status === 'saving';

  const onSave = async () => {
    if (sidecarUrlInvalid) return;
    const patch: UserSettingsPatch = {
      defaultAnalysisModel,
      defaultTtsEngine,
      defaultTtsModelKey,
      /* Pin the choice only when it differs from the resolved default — saving
         while the picker sits on the resolved default must not silently disable
         Qwen-when-installed. Preserve a prior explicit pin. */
      defaultTtsModelKeyExplicit:
        defaultTtsModelKey !== effectiveTtsModelKey ? true : account.defaultTtsModelKeyExplicit,
      sidecarUrl,
      analysisEngine,
      ollamaUrl,
      analyzerPhase0Model,
      analyzerPhase1Model,
      analyzerPhase1MinLagChapters,
      autoStartSidecar,
      dualModelEnabled,
      eagerLoadKokoro,
      eagerLoadQwen,
      generationWorkers,
    };
    const action = await dispatch(saveAccountSettings(patch));
    if (saveAccountSettings.fulfilled.match(action)) {
      setShowSaved(true);
      setTimeout(() => setShowSaved(false), 2400);
    }
  };

  const analyzerSplitOn = !!(analyzerPhase0Model || analyzerPhase1Model);

  const body = (
    <>
      <SettingsSection group={GROUP_DEFAULTS} overriddenCount={0}>
        <FieldRow label="Analysis model">
          <select
            value={defaultAnalysisModel}
            onChange={(e) => setDefaultAnalysisModel(e.target.value)}
            className="w-full px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink focus:outline-hidden focus:ring-2 focus:ring-magenta/30"
          >
            {analyzerModelGroups.map((g) => (
              <optgroup key={g.engine} label={g.label}>
                {g.models.map((m) => (
                  <option key={m.id} value={m.id} title={m.hint}>
                    {m.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </FieldRow>
        <FieldRow label="Voice engine">
          <select
            value={defaultTtsEngine}
            onChange={(e) => setDefaultTtsEngine(e.target.value as TtsEngineId)}
            className="w-full px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink focus:outline-hidden focus:ring-2 focus:ring-magenta/30"
          >
            {TTS_ENGINES.map((g) => (
              <option key={g.id} value={g.id} title={g.hint}>
                {g.label}
              </option>
            ))}
          </select>
        </FieldRow>
        <FieldRow label="Voice model">
          <select
            value={defaultTtsModelKey}
            onChange={(e) => setDefaultTtsModelKey(e.target.value as TtsModelKey)}
            className="w-full px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink focus:outline-hidden focus:ring-2 focus:ring-magenta/30"
          >
            {engineGroup.models.map((m) => (
              <option key={m.id} value={m.id} title={m.hint}>
                {m.label}
              </option>
            ))}
          </select>
        </FieldRow>
      </SettingsSection>

      <SettingsSection group={GROUP_ANALYZER_SPLIT} overriddenCount={0}>
        <p
          data-testid="analyzer-split-status"
          className="rounded-xl border border-ink/10 bg-ink/2 px-3 py-2 text-xs text-ink/70"
        >
          {analyzerSplitOn ? (
            <>
              <span className="font-semibold text-emerald-700">Currently ON</span> — Phase 0:{' '}
              <span className="font-medium text-ink">
                {analyzerModelLabel(analyzerPhase0Model)}
              </span>{' '}
              · Phase 1:{' '}
              <span className="font-medium text-ink">
                {analyzerModelLabel(analyzerPhase1Model)}
              </span>{' '}
              · lag {analyzerPhase1MinLagChapters ?? 10} chapter
              {(analyzerPhase1MinLagChapters ?? 10) === 1 ? '' : 's'}.
            </>
          ) : (
            <>
              <span className="font-semibold">Currently OFF</span> — both phases run on the default
              analysis model (
              <span className="font-medium text-ink">
                {analyzerModelLabel(defaultAnalysisModel)}
              </span>
              ).
            </>
          )}
        </p>
        <FieldRow
          label="Phase 0 model (cast detection)"
          sublabel="Drives the cast-roster pass. Gemma 4 31B is the recommended default — high free-tier headroom (1,500/day) and strong at character identification."
        >
          <select
            value={analyzerPhase0Model ?? ''}
            onChange={(e) => setAnalyzerPhase0Model(e.target.value === '' ? null : e.target.value)}
            data-testid="account-analyzer-phase0-model"
            className="w-full px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink focus:outline-hidden focus:ring-2 focus:ring-magenta/30"
          >
            <option value="">(use server default)</option>
            {analyzerModelGroups.map((g) => (
              <optgroup key={g.engine} label={g.label}>
                {g.models.map((m) => (
                  <option key={m.id} value={m.id} title={m.hint}>
                    {m.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </FieldRow>
        <FieldRow
          label="Phase 1 model (attribution)"
          sublabel="Drives the per-sentence speaker-attribution pass. Gemini 3.1 Flash Lite is the recommended default — fast, comfortably parses a novel in the 500/day free-tier bucket."
        >
          <select
            value={analyzerPhase1Model ?? ''}
            onChange={(e) => setAnalyzerPhase1Model(e.target.value === '' ? null : e.target.value)}
            data-testid="account-analyzer-phase1-model"
            className="w-full px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink focus:outline-hidden focus:ring-2 focus:ring-magenta/30"
          >
            <option value="">(use server default)</option>
            {analyzerModelGroups.map((g) => (
              <optgroup key={g.engine} label={g.label}>
                {g.models.map((m) => (
                  <option key={m.id} value={m.id} title={m.hint}>
                    {m.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </FieldRow>
        <FieldRow
          label="Phase 1 minimum chapter lag"
          sublabel="0 releases the lag; 10 anchors attribution to the roster-author model's interpretive baseline (recommended). Leave blank to use the server default."
        >
          <input
            type="number"
            min={0}
            max={50}
            step={1}
            value={
              analyzerPhase1MinLagChapters === null || analyzerPhase1MinLagChapters === undefined
                ? ''
                : analyzerPhase1MinLagChapters
            }
            onChange={(e) => {
              const raw = e.target.value;
              if (raw === '') {
                setAnalyzerPhase1MinLagChapters(null);
                return;
              }
              const parsed = parseInt(raw, 10);
              if (Number.isFinite(parsed)) {
                setAnalyzerPhase1MinLagChapters(Math.max(0, Math.min(50, parsed)));
              }
            }}
            placeholder="(use server default)"
            data-testid="account-analyzer-phase1-min-lag"
            className="w-32 px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink focus:outline-hidden focus:ring-2 focus:ring-magenta/30"
          />
        </FieldRow>
      </SettingsSection>

      <SettingsSection group={GROUP_VOICE_ENGINE} overriddenCount={0}>
        <FieldRow
          label="Auto-start with server"
          sublabel="When the analysis server starts (start-app.bat or `cd server && npm run dev`), automatically spawn the Python voice engine as a child process. Disable to run `npm run tts:sidecar` yourself, e.g. for debugging or to swap engines per-session. Takes effect on the next server restart."
        >
          <label className="inline-flex items-center gap-3 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={autoStartSidecar}
              onChange={(e) => setAutoStartSidecar(e.target.checked)}
              data-testid="account-auto-start-sidecar"
              className="h-4 w-4 rounded border-ink/30 text-magenta focus:ring-2 focus:ring-magenta/30"
            />
            <span className="text-sm text-ink">
              {autoStartSidecar
                ? 'Enabled — the server will spawn the sidecar at boot.'
                : 'Disabled — you manage the sidecar process yourself.'}
            </span>
          </label>
          {autoStartDirty && (
            <p className="mt-2 text-xs text-amber-800 bg-amber-100 rounded-full px-3 py-1 inline-block">
              Restart the server to apply this change.
            </p>
          )}
        </FieldRow>
        <FieldRow
          label="Keep both voice engines loaded (dual-model mode)"
          sublabel="Loads two voice engines into GPU memory at once so a book can mix engines (e.g. Kokoro + Qwen) without swap latency. Only enable if your GPU has headroom (~8 GB); the analyzer auto-evicts during generation. Off by default — when off, a mixed-engine book still generates but pays an engine-swap cost."
        >
          <label className="inline-flex items-center gap-3 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={dualModelEnabled}
              onChange={(e) => setDualModelEnabled(e.target.checked)}
              data-testid="account-dual-model-enabled"
              className="h-4 w-4 rounded border-ink/30 text-magenta focus:ring-2 focus:ring-magenta/30"
            />
            <span className="text-sm text-ink">
              {dualModelEnabled
                ? 'Enabled — both engines may stay resident; mixed-engine books skip the swap.'
                : 'Disabled — one engine at a time; mixed-engine books pay a swap cost.'}
            </span>
          </label>
        </FieldRow>
        {eagerEngineIsQwen ? (
          <FieldRow
            label="Eager-load Qwen at startup"
            sublabel="On by default while Qwen is your default engine — the voice engine preloads Qwen's synth model at boot so the first chapter doesn't wait on a cold load. Turn off to warm it lazily on first synth and keep that VRAM free until generation starts. Kokoro stays the on-demand fallback either way. Takes effect on the next voice-engine restart."
          >
            <label className="inline-flex items-center gap-3 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={eagerLoadQwen}
                onChange={(e) => setEagerLoadQwen(e.target.checked)}
                data-testid="account-eager-load-qwen"
                className="h-4 w-4 rounded border-ink/30 text-magenta focus:ring-2 focus:ring-magenta/30"
              />
              <span className="text-sm text-ink">
                {eagerLoadQwen
                  ? 'Enabled — the voice engine preloads Qwen at startup.'
                  : 'Disabled — Qwen warms on demand on first synth.'}
              </span>
            </label>
            {eagerLoadQwenDirty && (
              <p className="mt-2 text-xs text-amber-800 bg-amber-100 rounded-full px-3 py-1 inline-block">
                Restart the voice engine to apply this change.
              </p>
            )}
          </FieldRow>
        ) : (
          <FieldRow
            label="Eager-load Kokoro at startup"
            sublabel="On by default. Turn off if Qwen is your main engine — Kokoro then loads only when a Kokoro voice (e.g. the narrator) is synthesized, freeing ~1 GB VRAM. Takes effect on the next voice-engine restart."
          >
            <label className="inline-flex items-center gap-3 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={eagerLoadKokoro}
                onChange={(e) => setEagerLoadKokoro(e.target.checked)}
                data-testid="account-eager-load-kokoro"
                className="h-4 w-4 rounded border-ink/30 text-magenta focus:ring-2 focus:ring-magenta/30"
              />
              <span className="text-sm text-ink">
                {eagerLoadKokoro
                  ? 'Enabled — the voice engine preloads Kokoro at startup.'
                  : 'Disabled — Kokoro warms on demand on first synth.'}
              </span>
            </label>
            {eagerLoadKokoroDirty && (
              <p className="mt-2 text-xs text-amber-800 bg-amber-100 rounded-full px-3 py-1 inline-block">
                Restart the voice engine to apply this change.
              </p>
            )}
          </FieldRow>
        )}
        <FieldRow
          label="Generation workers"
          sublabel="How many chapters the generation queue synthesizes at once (1–4, default 2). Chapters are pulled from the queue across books. This is queue concurrency only — the GPU stays the limit on simultaneous synthesis, so raising this never risks running out of VRAM. Takes effect on the next generation run."
        >
          <input
            type="number"
            min={1}
            max={4}
            step={1}
            value={generationWorkers}
            onChange={(e) => {
              const parsed = parseInt(e.target.value, 10);
              if (Number.isFinite(parsed)) {
                setGenerationWorkers(Math.max(1, Math.min(4, parsed)));
              }
            }}
            data-testid="account-generation-workers"
            className="w-24 rounded-xl border border-ink/15 bg-white px-3 py-2 text-sm text-ink focus:outline-hidden focus:ring-2 focus:ring-magenta/30"
          />
        </FieldRow>
      </SettingsSection>

      <SettingsSection group={GROUP_SERVER_CONFIG} overriddenCount={0}>
        <FieldRow
          label="Voice engine URL"
          sublabel="Local voice engine endpoint. Default: http://localhost:9000"
        >
          <input
            type="text"
            value={sidecarUrl}
            onChange={(e) => setSidecarUrl(e.target.value)}
            placeholder="http://localhost:9000"
            data-testid="account-sidecar-url"
            className="w-full px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink focus:outline-hidden focus:ring-2 focus:ring-magenta/30"
          />
          {sidecarUrlInvalid && (
            <p
              data-testid="sidecar-url-invalid"
              className="mt-2 text-xs text-rose-700 bg-rose-50 rounded-full px-3 py-1 inline-block"
            >
              Must be an http(s) URL on a private / loopback host (localhost, 127.x, 10.x,
              192.168.x, etc.).
            </p>
          )}
        </FieldRow>
        <FieldRow
          label="Analyzer engine"
          sublabel={
            'Default — Gemini API sends every chapter straight to Google using the GEMINI_API_KEY in server/.env. Local routes analysis through the Ollama daemon on this machine instead (with Gemini as automatic fallback only when the daemon is unreachable, assuming GEMINI_API_KEY is configured). Pick Local only if you want analysis to run on-device.'
          }
        >
          <select
            value={analysisEngine}
            onChange={(e) => setAnalysisEngine(e.target.value as 'local' | 'gemini')}
            className="w-full px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink focus:outline-hidden focus:ring-2 focus:ring-magenta/30"
          >
            <option value="gemini">Gemini API (default — direct)</option>
            <option value="local">Local Ollama (on-device, with Gemini fallback)</option>
          </select>
        </FieldRow>
        <FieldRow
          label="Ollama URL"
          sublabel={
            'Local Ollama daemon endpoint. Default: http://localhost:11434. The Ollama model tag is whatever you pick above under "Analysis model" — pull it once with `ollama pull <tag>` before first run.'
          }
        >
          <input
            type="text"
            value={ollamaUrl}
            onChange={(e) => setOllamaUrl(e.target.value)}
            placeholder="http://localhost:11434"
            className="w-full px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink focus:outline-hidden focus:ring-2 focus:ring-magenta/30"
          />
        </FieldRow>
        <GeminiKeyField
          status={account.apiKeyStatus}
          onSave={(key) => dispatch(saveGeminiApiKey(key))}
        />
      </SettingsSection>

      <SettingsSection group={GROUP_MODELS_INSTALL} overriddenCount={0}>
        <ModelsCardBody />
      </SettingsSection>

      <div className="flex items-center gap-4 px-1">
        <PrimaryButton
          variant={dirty && !sidecarUrlInvalid ? 'dark' : 'ghost'}
          onClick={onSave}
          icon={false}
        >
          {saving ? 'Saving…' : 'Save changes'}
        </PrimaryButton>
        {showSaved && <span className="text-xs text-magenta font-semibold">Saved.</span>}
        {account.status === 'error' && account.error && (
          <span className="text-xs text-rose-700">{account.error}</span>
        )}
      </div>
    </>
  );

  /* Embedded: caller (Model Manager) owns the single side-nav rail, so render
     the sections bare. Standalone: wrap them in our own accordion nav. */
  if (embedded) return body;
  return <SettingsAccordion sections={MODEL_SETTINGS_SECTIONS}>{body}</SettingsAccordion>;
}

/* Plan 61 / Task 11a — Models card body. In-app installers (Ollama + analyzer
   pulls). Rendered inside a SettingsSection shell (GROUP_MODELS_INSTALL).
   Sources its pull rows from the server's curated allowlist via
   `account.pullableModels` (populated by `fetchAnalyzerModels`) and routes the
   health probe through the mockable api layer so it works under mocks / e2e.
   Re-fetches the model list after a pull completes so a just-pulled tag shows
   on disk without a remount. The data-testid is preserved for existing tests. */
function ModelsCardBody() {
  const dispatch = useAppDispatch();
  const pullableModels = useAppSelector((s) => s.account.pullableModels);
  const [health, setHealth] = useState<import('./model-pull-status').OllamaHealthEnvelope | null>(
    null,
  );

  useEffect(() => {
    void dispatch(fetchAnalyzerModels());
    let cancelled = false;
    void (async () => {
      const h = await api.getOllamaHealth();
      if (!cancelled) setHealth(h as unknown as import('./model-pull-status').OllamaHealthEnvelope);
    })();
    return () => {
      cancelled = true;
    };
  }, [dispatch]);

  return (
    <div data-testid="account-models-card" className="space-y-6">
      <div>
        <h3 className="text-sm font-medium text-ink">Local analyzer (Ollama)</h3>
        <p className="mt-1 mb-3 text-xs text-ink/55">
          Required when "Analyzer engine" above is set to Local.
        </p>
        <OllamaInstall />
      </div>

      <div>
        <h3 className="text-sm font-medium text-ink">Analyzer models</h3>
        <p className="mt-1 mb-3 text-xs text-ink/55">
          Pulled tags appear in the Analysis-model dropdown above. The configured default is
          highlighted.
        </p>
        <ModelPullStatus
          health={health}
          pullableModels={pullableModels}
          onPulled={() => dispatch(fetchAnalyzerModels())}
        />
      </div>
    </div>
  );
}
