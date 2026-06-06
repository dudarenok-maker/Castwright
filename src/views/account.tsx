/* Account view — single page that centralises user-level defaults and
   non-secret server overrides. Reached via the top-bar avatar (#/account).

   Form pattern follows src/modals/profile-drawer.tsx: local state mirrors
   the slice, edits stay local until Save dispatches the thunk that PUTs to
   the server and re-hydrates the slice. */

import { useEffect, useMemo, useState } from 'react';
import { SectionLabel, MixedHeading, PrimaryButton } from '../components/primitives';
import { MODEL_OPTION_GROUPS } from '../lib/models';
import { TTS_ENGINES, type TtsEngineId } from '../lib/tts-models';
import type {
  BackupSnapshot,
  TtsModelKey,
  UserSettings,
  UserSettingsPatch,
} from '../lib/types';
import type { ThemePreference } from '../lib/use-theme';
import { api } from '../lib/api';
import { UpgradeCard } from '../components/upgrade-card';
import { selectLibraryBooks, libraryActions } from '../store/library-slice';
import { useAppDispatch, useAppSelector } from '../store';
import { uiActions } from '../store/ui-slice';
import {
  fetchAccountSettings,
  saveAccountSettings,
  saveGeminiApiKey,
} from '../store/account-slice';
import {
  settingsActions,
  type KeyboardActionId,
  type TextScale,
  AUTOSAVE_DEBOUNCE_MIN_MS,
  AUTOSAVE_DEBOUNCE_MAX_MS,
  SKIP_SEC_MIN,
  SKIP_SEC_MAX,
} from '../store/settings-slice';
import { formatKeyLabel, normalizeKeyEvent } from '../lib/keybindings';
import { OllamaInstall } from '../components/ollama-install';
import { QwenInstall } from '../components/qwen-install';
import { WhisperInstall } from '../components/whisper-install';
import { CoquiInstall } from '../components/coqui-install';
import { ModelPullStatus } from '../components/model-pull-status';
import {
  analyzerModelLabel,
  FormCard,
  FieldRow,
  ReadOnlyRow,
  GeminiKeyField,
} from '../components/account-forms';

/* Plan 61 — mirror server/src/ollama/pull-bootstrap.ts DEFAULT_ALLOWED_MODELS.
   Centralised here so the Models card can render rows without re-fetching
   the allowlist from the backend (it's static per release). */
const PULLABLE_MODELS = ['qwen3.5:4b', 'qwen3.5:9b', 'llama3.1:8b', 'llama3.2:3b', 'gemma3:4b'] as const;

export function AccountView() {
  const dispatch = useAppDispatch();
  const account = useAppSelector((s) => s.account);

  /* Local form state — initialised from the slice and re-synced when the
     slice rehydrates (after Save or after the boot-time fetch lands). The
     workspaceDirOverride field is tracked separately so an "edited but not
     saved" diff can render the restart-required badge. */
  const [displayName, setDisplayName] = useState(account.displayName);
  const [defaultAnalysisModel, setDefaultAnalysisModel] = useState(account.defaultAnalysisModel);
  const [defaultTtsEngine, setDefaultTtsEngine] = useState<TtsEngineId>(account.defaultTtsEngine);
  /* The picker shows the EFFECTIVE default (resolvedTtsModelKey, which is Qwen
     on a box with Qwen installed), not the stored key — so the user sees what
     books will actually use, and re-selecting a different engine is a real
     change that pins it. Falls back to the stored key for an older server. */
  const effectiveTtsModelKey = account.resolvedTtsModelKey ?? account.defaultTtsModelKey;
  const [defaultTtsModelKey, setDefaultTtsModelKey] = useState<TtsModelKey>(effectiveTtsModelKey);
  const [sidecarUrl, setSidecarUrl] = useState(account.sidecarUrl);
  const [analysisEngine, setAnalysisEngine] = useState<'local' | 'gemini'>(account.analysisEngine);
  const [ollamaUrl, setOllamaUrl] = useState(account.ollamaUrl);
  const [workspaceDirOverride, setWorkspaceDirOverride] = useState<string>(
    account.workspaceDirOverride ?? '',
  );
  const [minorCastMinLines, setMinorCastMinLines] = useState<number>(account.minorCastMinLines);
  /* Plan 88 phase-2 — Account-tab Analyzer card. `null` means "fall
     through to env / hardcoded default"; the picker renders that as a
     "(use server default)" option at the top of each model select. */
  const [analyzerPhase0Model, setAnalyzerPhase0Model] = useState<string | null>(
    account.analyzerPhase0Model ?? null,
  );
  const [analyzerPhase1Model, setAnalyzerPhase1Model] = useState<string | null>(
    account.analyzerPhase1Model ?? null,
  );
  const [analyzerPhase1MinLagChapters, setAnalyzerPhase1MinLagChapters] = useState<number | null>(
    account.analyzerPhase1MinLagChapters ?? null,
  );
  const [coverPickerDefaultTab, setCoverPickerDefaultTab] = useState<
    NonNullable<UserSettings['coverPickerDefaultTab']>
  >(account.coverPickerDefaultTab ?? 'search');
  const [defaultThemePreference, setDefaultThemePreference] = useState<ThemePreference>(
    account.defaultThemePreference ?? 'system',
  );
  const [autoStartSidecar, setAutoStartSidecar] = useState<boolean>(
    account.autoStartSidecar ?? true,
  );
  const [dualModelEnabled, setDualModelEnabled] = useState<boolean>(
    account.dualModelEnabled ?? false,
  );
  const [eagerLoadKokoro, setEagerLoadKokoro] = useState<boolean>(
    account.eagerLoadKokoro ?? true,
  );
  const [eagerLoadQwen, setEagerLoadQwen] = useState<boolean>(account.eagerLoadQwen ?? true);
  const [generationWorkers, setGenerationWorkers] = useState<number>(
    account.generationWorkers ?? 2,
  );
  /* srv-2 — per-book state.json auto-backup preferences. */
  const [backupEnabled, setBackupEnabled] = useState<boolean>(account.backupEnabled ?? true);
  const [backupCadence, setBackupCadence] = useState<'daily' | 'weekly'>(
    account.backupCadence ?? 'daily',
  );
  const [backupRetention, setBackupRetention] = useState<number>(account.backupRetention ?? 14);
  const themeOverride = useAppSelector((s) => s.ui.themeOverride);
  const [showSaved, setShowSaved] = useState(false);

  useEffect(() => {
    setDisplayName(account.displayName);
    setDefaultAnalysisModel(account.defaultAnalysisModel);
    setDefaultTtsEngine(account.defaultTtsEngine);
    setDefaultTtsModelKey(account.resolvedTtsModelKey ?? account.defaultTtsModelKey);
    setSidecarUrl(account.sidecarUrl);
    setAnalysisEngine(account.analysisEngine);
    setOllamaUrl(account.ollamaUrl);
    setWorkspaceDirOverride(account.workspaceDirOverride ?? '');
    setMinorCastMinLines(account.minorCastMinLines);
    setAnalyzerPhase0Model(account.analyzerPhase0Model ?? null);
    setAnalyzerPhase1Model(account.analyzerPhase1Model ?? null);
    setAnalyzerPhase1MinLagChapters(account.analyzerPhase1MinLagChapters ?? null);
    setCoverPickerDefaultTab(account.coverPickerDefaultTab ?? 'search');
    setDefaultThemePreference(account.defaultThemePreference ?? 'system');
    setAutoStartSidecar(account.autoStartSidecar ?? true);
    setDualModelEnabled(account.dualModelEnabled ?? false);
    setEagerLoadKokoro(account.eagerLoadKokoro ?? true);
    setEagerLoadQwen(account.eagerLoadQwen ?? true);
    setGenerationWorkers(account.generationWorkers ?? 2);
    setBackupEnabled(account.backupEnabled ?? true);
    setBackupCadence(account.backupCadence ?? 'daily');
    setBackupRetention(account.backupRetention ?? 14);
  }, [
    account.hydrated,
    account.displayName,
    account.defaultAnalysisModel,
    account.defaultTtsEngine,
    account.defaultTtsModelKey,
    account.resolvedTtsModelKey,
    account.sidecarUrl,
    account.analysisEngine,
    account.ollamaUrl,
    account.workspaceDirOverride,
    account.minorCastMinLines,
    account.analyzerPhase0Model,
    account.analyzerPhase1Model,
    account.analyzerPhase1MinLagChapters,
    account.coverPickerDefaultTab,
    account.defaultThemePreference,
    account.autoStartSidecar,
    account.dualModelEnabled,
    account.eagerLoadKokoro,
    account.eagerLoadQwen,
    account.generationWorkers,
    account.backupEnabled,
    account.backupCadence,
    account.backupRetention,
  ]);

  /* When the engine switches, the selected modelKey may not belong to the
     new engine's group. Default to the new group's first model so the
     dropdown never shows a mismatched value. */
  const engineGroup = TTS_ENGINES.find((g) => g.id === defaultTtsEngine) ?? TTS_ENGINES[0];
  useEffect(() => {
    if (!engineGroup.models.some((m) => m.id === defaultTtsModelKey)) {
      setDefaultTtsModelKey(engineGroup.models[0].id);
    }
  }, [defaultTtsEngine, engineGroup, defaultTtsModelKey]);

  /* Persisted override vs draft. The "Restart required" badge fires the
     instant the user changes the override away from the persisted value —
     even before Save — because the server is still running with the old
     value. */
  const persistedOverride = account.workspaceDirOverride ?? '';
  const workspaceDirty = workspaceDirOverride !== persistedOverride;

  const persistedAutoStart = account.autoStartSidecar ?? true;
  const autoStartDirty = autoStartSidecar !== persistedAutoStart;

  /* Like autoStartDirty, this gates a "Restart required" badge: the
     PRELOAD_KOKORO env only changes when the sidecar is re-spawned, so a
     toggle here doesn't take effect until the next restart. */
  const persistedEagerLoadKokoro = account.eagerLoadKokoro ?? true;
  const eagerLoadKokoroDirty = eagerLoadKokoro !== persistedEagerLoadKokoro;

  /* Same restart-required gate for Qwen's preload (PRELOAD_QWEN). */
  const persistedEagerLoadQwen = account.eagerLoadQwen ?? true;
  const eagerLoadQwenDirty = eagerLoadQwen !== persistedEagerLoadQwen;

  /* The eager-load toggle governs the DEFAULT engine only — the other engine
     is the on-demand fallback (forced lazy in spawn-sidecar.ts). Track the
     form's selected model key so switching the engine picker in-session flips
     the toggle to match what the next sidecar restart will actually preload. */
  const eagerEngineIsQwen = defaultTtsModelKey === 'qwen3-tts-0.6b';

  const dirty = useMemo(() => {
    return (
      displayName !== account.displayName ||
      defaultAnalysisModel !== account.defaultAnalysisModel ||
      defaultTtsEngine !== account.defaultTtsEngine ||
      defaultTtsModelKey !== effectiveTtsModelKey ||
      sidecarUrl !== account.sidecarUrl ||
      analysisEngine !== account.analysisEngine ||
      ollamaUrl !== account.ollamaUrl ||
      minorCastMinLines !== account.minorCastMinLines ||
      analyzerPhase0Model !== (account.analyzerPhase0Model ?? null) ||
      analyzerPhase1Model !== (account.analyzerPhase1Model ?? null) ||
      analyzerPhase1MinLagChapters !== (account.analyzerPhase1MinLagChapters ?? null) ||
      coverPickerDefaultTab !== (account.coverPickerDefaultTab ?? 'search') ||
      defaultThemePreference !== (account.defaultThemePreference ?? 'system') ||
      dualModelEnabled !== (account.dualModelEnabled ?? false) ||
      generationWorkers !== (account.generationWorkers ?? 2) ||
      autoStartDirty ||
      eagerLoadKokoroDirty ||
      eagerLoadQwenDirty ||
      workspaceDirty
    );
  }, [
    displayName,
    defaultAnalysisModel,
    defaultTtsEngine,
    defaultTtsModelKey,
    effectiveTtsModelKey,
    sidecarUrl,
    analysisEngine,
    ollamaUrl,
    minorCastMinLines,
    analyzerPhase0Model,
    analyzerPhase1Model,
    analyzerPhase1MinLagChapters,
    coverPickerDefaultTab,
    defaultThemePreference,
    dualModelEnabled,
    generationWorkers,
    autoStartDirty,
    eagerLoadKokoroDirty,
    eagerLoadQwenDirty,
    workspaceDirty,
    account,
  ]);

  const onSave = async () => {
    const patch: UserSettingsPatch = {
      displayName,
      defaultAnalysisModel,
      defaultTtsEngine,
      defaultTtsModelKey,
      /* Pin the user's choice (so the server stops preferring Qwen) only when
         they picked something OTHER than the resolved default — saving an
         unrelated field while the picker sits on the resolved default must not
         silently disable Qwen-when-installed. Preserve a prior explicit pin. */
      defaultTtsModelKeyExplicit:
        defaultTtsModelKey !== effectiveTtsModelKey
          ? true
          : account.defaultTtsModelKeyExplicit,
      sidecarUrl,
      analysisEngine,
      ollamaUrl,
      workspaceDirOverride: workspaceDirOverride.trim() === '' ? null : workspaceDirOverride.trim(),
      minorCastMinLines,
      analyzerPhase0Model,
      analyzerPhase1Model,
      analyzerPhase1MinLagChapters,
      coverPickerDefaultTab,
      defaultThemePreference,
      autoStartSidecar,
      dualModelEnabled,
      eagerLoadKokoro,
      eagerLoadQwen,
      generationWorkers,
      backupEnabled,
      backupCadence,
      backupRetention,
    };
    const action = await dispatch(saveAccountSettings(patch));
    if (saveAccountSettings.fulfilled.match(action)) {
      setShowSaved(true);
      setTimeout(() => setShowSaved(false), 2400);
    }
  };

  const saving = account.status === 'saving';

  /* Hydration gate: until the server payload lands, rendering the form
     would silently show the FRONTEND_ACCOUNT_DEFAULTS instead of the
     user's persisted choices — we used to mislead users into thinking
     their saved value got reset (it hadn't; the backend was just down).
     Block the form on the unhydrated states and surface the actual
     reason. Once the slice has hydrated at least once (initial fetch or
     a successful save), keep rendering the form even on subsequent
     errors so a save failure doesn't blow the form away. */
  if (!account.hydrated) {
    return (
      <div className="max-w-[960px] mx-auto px-6 py-10">
        <div className="mb-8">
          <SectionLabel>Account</SectionLabel>
          <div className="mt-4">
            <MixedHeading regular="Your" bold="defaults" level="h1" />
          </div>
        </div>
        {account.status === 'error' ? (
          <section
            role="alert"
            className="rounded-2xl border border-rose-200 bg-rose-50 p-6 shadow-card"
          >
            <h2 className="text-base font-semibold text-rose-900">Couldn't load your settings</h2>
            <p className="mt-2 text-sm text-rose-900/85">
              The analysis backend at <code className="font-mono">/api/user/settings</code> isn't
              reachable. Your saved choices are still on disk in{' '}
              <code className="font-mono">server/user-settings.json</code> — the form is hidden so
              it doesn't render the built-in defaults as if they were your saved values.
            </p>
            <p className="mt-2 text-xs text-rose-900/70">
              Start the server with{' '}
              <code className="font-mono">cd server &amp;&amp; npm run dev</code>, then retry.
            </p>
            {account.error && (
              <p className="mt-3 text-xs font-mono text-rose-900/70 break-all">{account.error}</p>
            )}
            <div className="mt-4">
              <PrimaryButton
                variant="dark"
                icon={false}
                onClick={() => {
                  void dispatch(fetchAccountSettings());
                }}
              >
                Retry
              </PrimaryButton>
            </div>
          </section>
        ) : (
          <p className="text-sm text-ink/60">Loading your settings…</p>
        )}
      </div>
    );
  }

  return (
    <div className="max-w-[960px] mx-auto px-6 py-10">
      <div className="mb-8">
        <SectionLabel>Account</SectionLabel>
        <div className="mt-4">
          <MixedHeading regular="Your" bold="defaults" level="h1" />
        </div>
        <p className="mt-3 text-ink/60 max-w-xl">
          Workspace-wide preferences. Defaults seed new books — once you pick a model for a specific
          book, that choice sticks for that book.
        </p>
      </div>

      <div className="space-y-6">
        <UpgradeCard />
        <FormCard title="Profile" hint="How you appear in the top bar and the change log.">
          <FieldRow label="Display name">
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Your name"
              className="w-full px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink focus:outline-hidden focus:ring-2 focus:ring-magenta/30"
            />
          </FieldRow>
        </FormCard>

        <FormCard
          title="Defaults for new books"
          hint="Used the first time you open a book that hasn't been touched yet. Per-book choices override these and persist."
        >
          <FieldRow label="Analysis model">
            <select
              value={defaultAnalysisModel}
              onChange={(e) => setDefaultAnalysisModel(e.target.value)}
              className="w-full px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink focus:outline-hidden focus:ring-2 focus:ring-magenta/30"
            >
              {MODEL_OPTION_GROUPS.map((g) => (
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
          <FieldRow label="TTS engine">
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
          <FieldRow label="TTS model">
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
        </FormCard>

        <FormCard
          title="Two-model analyzer split (advanced)"
          hint="Optional. By default both analysis passes run on your default analysis model. Pick a model for EACH phase to split the work: Phase 0 (cast detection) and Phase 1 (sentence attribution) then run on different models concurrently, with Phase 1 starting a few chapters behind Phase 0 (the minimum chapter lag below). This spreads load across two free-tier rate-limit buckets — e.g. Gemma 4 31B (1,500/day) for cast detection and Gemini 3.1 Flash Lite (500/day) for attribution — and finishes sooner. Leave both blank for the single-model default. Server env vars (ANALYZER_PHASE{0,1}_MODEL / ANALYZER_PHASE1_MIN_LAG_CHAPTERS) still override for ops triage."
        >
          {(() => {
            const on = !!(analyzerPhase0Model || analyzerPhase1Model);
            return (
              <p
                data-testid="analyzer-split-status"
                className="rounded-xl border border-ink/10 bg-ink/2 px-3 py-2 text-xs text-ink/70"
              >
                {on ? (
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
                    <span className="font-semibold">Currently OFF</span> — both phases run on the
                    default analysis model (
                    <span className="font-medium text-ink">
                      {analyzerModelLabel(defaultAnalysisModel)}
                    </span>
                    ).
                  </>
                )}
              </p>
            );
          })()}
          <FieldRow
            label="Phase 0 model (cast detection)"
            sublabel='Drives the cast-roster pass. Gemma 4 31B is the recommended default — high free-tier headroom (1,500/day) and strong at character identification.'
          >
            <select
              value={analyzerPhase0Model ?? ''}
              onChange={(e) =>
                setAnalyzerPhase0Model(e.target.value === '' ? null : e.target.value)
              }
              data-testid="account-analyzer-phase0-model"
              className="w-full px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink focus:outline-hidden focus:ring-2 focus:ring-magenta/30"
            >
              <option value="">(use server default)</option>
              {MODEL_OPTION_GROUPS.map((g) => (
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
            sublabel='Drives the per-sentence speaker-attribution pass. Gemini 3.1 Flash Lite is the recommended default — fast, comfortably parses a novel in the 500/day free-tier bucket.'
          >
            <select
              value={analyzerPhase1Model ?? ''}
              onChange={(e) =>
                setAnalyzerPhase1Model(e.target.value === '' ? null : e.target.value)
              }
              data-testid="account-analyzer-phase1-model"
              className="w-full px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink focus:outline-hidden focus:ring-2 focus:ring-magenta/30"
            >
              <option value="">(use server default)</option>
              {MODEL_OPTION_GROUPS.map((g) => (
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
                  /* Clamp to schema [0, 50] so Save can't 400 on a fat-finger. */
                  setAnalyzerPhase1MinLagChapters(Math.max(0, Math.min(50, parsed)));
                }
              }}
              placeholder="(use server default)"
              data-testid="account-analyzer-phase1-min-lag"
              className="w-32 px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink focus:outline-hidden focus:ring-2 focus:ring-magenta/30"
            />
          </FieldRow>
        </FormCard>

        <FormCard
          title="Cast analysis"
          hint="How the analyzer decides which characters earn a dedicated voice profile vs. get folded into the generic Unknown male / Unknown female buckets."
        >
          <FieldRow
            label="Minor-cast threshold (sentences)"
            sublabel={
              'Characters with fewer than this many attributed sentences (each individual sentence the model assigns to that speaker counts as one — the same number shown as "Lines" on the cast roster, not word count) get folded into Unknown male / Unknown female at analysis time. Characters whose name begins with "Unknown" always fold regardless of this number. Set to 0 to disable the line-count trigger entirely. Default 3.'
            }
          >
            <input
              type="number"
              min={0}
              max={50}
              step={1}
              value={Number.isFinite(minorCastMinLines) ? minorCastMinLines : 3}
              onChange={(e) => {
                const parsed = parseInt(e.target.value, 10);
                /* Clamp to schema [0, 50] so the Save round-trip never
                   tips into a 400 on a user fat-finger. */
                if (Number.isFinite(parsed)) {
                  setMinorCastMinLines(Math.max(0, Math.min(50, parsed)));
                }
              }}
              className="w-32 px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink focus:outline-hidden focus:ring-2 focus:ring-magenta/30"
            />
          </FieldRow>
        </FormCard>

        <FormCard
          title="Covers"
          hint="How the cover picker opens for new books. Plan 40 added local-disk upload alongside the OpenLibrary search."
        >
          <FieldRow
            label="Default cover picker tab"
            sublabel="Which tab opens first when you click 'Cover image' on a book. Search (the default) shows OpenLibrary candidates; Upload jumps straight to the file picker for users who routinely bring their own art."
          >
            <select
              value={coverPickerDefaultTab}
              onChange={(e) => setCoverPickerDefaultTab(e.target.value as 'search' | 'upload')}
              className="w-full px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink focus:outline-hidden focus:ring-2 focus:ring-magenta/30"
            >
              <option value="search">Search OpenLibrary (default)</option>
              <option value="upload">Upload local</option>
            </select>
          </FieldRow>
        </FormCard>

        <FormCard
          title="Appearance"
          hint="How the app looks. The sun/moon toggle in the top bar is a device-only override; this picker sets the default that any new device or fresh session inherits."
        >
          <FieldRow
            label="Default theme"
            sublabel="System follows your OS's dark/light setting at runtime and auto-flips at sundown. Light or Dark pins one regardless of OS. Changes here are server-persisted; the top-bar toggle's per-device override always wins until you clear it below."
          >
            <select
              value={defaultThemePreference}
              onChange={(e) => setDefaultThemePreference(e.target.value as ThemePreference)}
              data-testid="account-default-theme"
              className="w-full px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink focus:outline-hidden focus:ring-2 focus:ring-magenta/30"
            >
              <option value="system">System (follows OS — default)</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </FieldRow>
          {themeOverride !== null && (
            <div
              data-testid="theme-override-pill"
              className="flex items-center justify-between gap-3 rounded-xl border border-magenta/30 bg-magenta/10 px-4 py-3"
            >
              <div className="text-xs text-ink/75">
                <span className="font-semibold text-magenta">This device is overridden</span> — the
                top-bar toggle is set to <span className="font-mono text-ink">{themeOverride}</span>
                . Clear the override to follow the account default again.
              </div>
              <PrimaryButton
                variant="ghost"
                icon={false}
                onClick={() => dispatch(uiActions.clearThemeOverride())}
              >
                Use account default
              </PrimaryButton>
            </div>
          )}
        </FormCard>

        <FormCard
          title="TTS sidecar"
          hint="The Python sidecar process that runs Qwen3-TTS / Kokoro / Coqui XTTS locally. The Node server can launch it for you automatically."
        >
          <FieldRow
            label="Auto-start with server"
            sublabel="When the analysis server starts (start-app.bat or `cd server && npm run dev`), automatically spawn the Python TTS sidecar as a child process. Disable to run `npm run tts:sidecar` yourself, e.g. for debugging or to swap engines per-session. Takes effect on the next server restart."
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
            label="Keep both TTS engines loaded (dual-model mode)"
            sublabel="Loads two TTS engines into GPU memory at once so a book can mix engines (e.g. Kokoro + Qwen) without swap latency. Only enable if your GPU has headroom (~8 GB); the analyzer auto-evicts during generation. Off by default — when off, a mixed-engine book still generates but pays an engine-swap cost."
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
              sublabel="On by default while Qwen is your default engine — the sidecar preloads Qwen's synth model at boot so the first chapter doesn't wait on a cold load. Turn off to warm it lazily on first synth and keep that VRAM free until generation starts. Kokoro stays the on-demand fallback either way. Takes effect on the next sidecar restart."
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
                    ? 'Enabled — the sidecar preloads Qwen at startup.'
                    : 'Disabled — Qwen warms on demand on first synth.'}
                </span>
              </label>
              {eagerLoadQwenDirty && (
                <p className="mt-2 text-xs text-amber-800 bg-amber-100 rounded-full px-3 py-1 inline-block">
                  Restart the sidecar to apply this change.
                </p>
              )}
            </FieldRow>
          ) : (
            <FieldRow
              label="Eager-load Kokoro at startup"
              sublabel="On by default. Turn off if Qwen is your main engine — Kokoro then loads only when a Kokoro voice (e.g. the narrator) is synthesized, freeing ~1 GB VRAM. Takes effect on the next sidecar restart."
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
                    ? 'Enabled — the sidecar preloads Kokoro at startup.'
                    : 'Disabled — Kokoro warms on demand on first synth.'}
                </span>
              </label>
              {eagerLoadKokoroDirty && (
                <p className="mt-2 text-xs text-amber-800 bg-amber-100 rounded-full px-3 py-1 inline-block">
                  Restart the sidecar to apply this change.
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
                  /* Clamp to schema [1, 4] so Save can't 400 on a fat-finger. */
                  setGenerationWorkers(Math.max(1, Math.min(4, parsed)));
                }
              }}
              data-testid="account-generation-workers"
              className="w-24 rounded-xl border border-ink/15 bg-white px-3 py-2 text-sm text-ink focus:outline-hidden focus:ring-2 focus:ring-magenta/30"
            />
          </FieldRow>
        </FormCard>

        <FormCard
          title="Backups"
          hint="Automatic snapshots of each book's state.json (cast, chapters, metadata) so an accidental edit or corrupt write can be rolled back. Snapshots live alongside the book in its workspace folder."
        >
          <FieldRow
            label="Automatic backups"
            sublabel="When on, the server snapshots a book's state.json on the cadence below, pruning to the retention count. Turn off to manage backups manually with 'Back up now'."
          >
            <label className="inline-flex items-center gap-3 cursor-pointer select-none min-h-[44px] sm:min-h-0">
              <input
                type="checkbox"
                checked={backupEnabled}
                onChange={(e) => setBackupEnabled(e.target.checked)}
                data-testid="account-backup-enabled"
                className="h-4 w-4 rounded border-ink/30 text-magenta focus:ring-2 focus:ring-magenta/30"
              />
              <span className="text-sm text-ink">
                {backupEnabled
                  ? 'Enabled — the server snapshots state.json automatically.'
                  : 'Disabled — snapshots only when you click "Back up now".'}
              </span>
            </label>
          </FieldRow>
          <FieldRow
            label="Cadence"
            sublabel="How often an automatic snapshot is taken when a book's state changes."
          >
            <select
              value={backupCadence}
              onChange={(e) => setBackupCadence(e.target.value as 'daily' | 'weekly')}
              data-testid="account-backup-cadence"
              className="w-full px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink focus:outline-hidden focus:ring-2 focus:ring-magenta/30"
            >
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
            </select>
          </FieldRow>
          <FieldRow
            label="Retention (snapshots to keep)"
            sublabel="Older snapshots beyond this count are pruned. 1–365."
          >
            <input
              type="number"
              min={1}
              max={365}
              step={1}
              value={backupRetention}
              onChange={(e) => {
                const parsed = parseInt(e.target.value, 10);
                if (Number.isFinite(parsed)) {
                  /* Clamp to schema [1, 365] so Save can't 400 on a fat-finger. */
                  setBackupRetention(Math.max(1, Math.min(365, parsed)));
                }
              }}
              data-testid="account-backup-retention"
              className="w-24 rounded-xl border border-ink/15 bg-white px-3 py-2 text-sm text-ink focus:outline-hidden focus:ring-2 focus:ring-magenta/30"
            />
          </FieldRow>
          <BackupRestoreSection />
        </FormCard>

        <FormCard
          title="Server configuration"
          hint="Non-secret overrides for what's in server/.env. Sidecar URL and Ollama settings take effect on the next request; workspace directory needs a server restart."
        >
          <FieldRow
            label="Sidecar URL"
            sublabel="Local TTS sidecar endpoint. Default: http://localhost:9000"
          >
            <input
              type="text"
              value={sidecarUrl}
              onChange={(e) => setSidecarUrl(e.target.value)}
              placeholder="http://localhost:9000"
              className="w-full px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink focus:outline-hidden focus:ring-2 focus:ring-magenta/30"
            />
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
          <FieldRow
            label="Workspace directory override"
            sublabel="Absolute or relative-to-server/ path. Leave empty to use WORKSPACE_DIR from server/.env."
          >
            <input
              type="text"
              value={workspaceDirOverride}
              onChange={(e) => setWorkspaceDirOverride(e.target.value)}
              placeholder="(leave empty to use server/.env)"
              className="w-full px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink focus:outline-hidden focus:ring-2 focus:ring-magenta/30"
            />
            {workspaceDirty && (
              <p className="mt-2 text-xs text-amber-800 bg-amber-100 rounded-full px-3 py-1 inline-block">
                Restart the server to apply this change.
              </p>
            )}
          </FieldRow>
          <ReadOnlyRow
            label="Active workspace root"
            value={account.workspaceRoot || '(unknown)'}
            sublabel={`Source: ${account.workspaceSource}`}
          />
          <GeminiKeyField
            status={account.apiKeyStatus}
            onSave={(key) => dispatch(saveGeminiApiKey(key))}
          />
        </FormCard>

        <ModelsCard />

        <AdvancedCard />

        <div className="flex items-center gap-4">
          <PrimaryButton variant={dirty ? 'dark' : 'ghost'} onClick={onSave} icon={false}>
            {saving ? 'Saving…' : 'Save changes'}
          </PrimaryButton>
          {showSaved && <span className="text-xs text-magenta font-semibold">Saved.</span>}
          {account.status === 'error' && account.error && (
            <span className="text-xs text-rose-700">{account.error}</span>
          )}
        </div>
      </div>
    </div>
  );
}

/* srv-2 — Restore-from-backup picker. Picks a book from the library,
   lists its on-disk snapshots, and offers "Back up now" + per-snapshot
   "Restore" (confirm-gated). Feedback is inline text — the Account view
   has no toast surface. */
function BackupRestoreSection() {
  const dispatch = useAppDispatch();
  const books = useAppSelector(selectLibraryBooks);
  const [bookId, setBookId] = useState<string>('');
  const [snapshots, setSnapshots] = useState<BackupSnapshot[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadSnapshots = async (id: string) => {
    if (!id) {
      setSnapshots([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setSnapshots(await api.listBookBackups(id));
    } catch (e) {
      setError((e as Error).message);
      setSnapshots([]);
    } finally {
      setLoading(false);
    }
  };

  const onPickBook = (id: string) => {
    setBookId(id);
    setStatus(null);
    setError(null);
    void loadSnapshots(id);
  };

  const onBackupNow = async () => {
    if (!bookId) return;
    setBusy(true);
    setStatus(null);
    setError(null);
    try {
      await api.backupBookNow(bookId);
      setStatus('Backup created.');
      await loadSnapshots(bookId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onRestore = async (file: string) => {
    if (!bookId) return;
    if (
      !window.confirm(
        `Restore this book from "${file}"? The current state.json will be overwritten.`,
      )
    )
      return;
    setBusy(true);
    setStatus(null);
    setError(null);
    try {
      await api.restoreBookBackup(bookId, file);
      setStatus(`Restored from ${file}.`);
      /* srv-2 (#424) — a restore overwrites state.json, so the library's
         cached metadata (title, cover, chapter counts) may now be stale.
         Re-hydrate from the authoritative server scan so the library view
         reflects the restored state. */
      const refreshed = await api.getLibrary().catch(() => null);
      if (refreshed) dispatch(libraryActions.hydrate(refreshed));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="block border-t border-ink/10 pt-4">
      <span className="block text-sm font-medium text-ink">Restore from backup</span>
      <span className="block text-xs text-ink/55 mt-0.5">
        Pick a book to list its snapshots, take a fresh one, or roll back to an earlier state.json.
      </span>
      <div className="mt-2">
        <select
          value={bookId}
          onChange={(e) => onPickBook(e.target.value)}
          data-testid="account-backup-book-picker"
          className="w-full px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink focus:outline-hidden focus:ring-2 focus:ring-magenta/30"
        >
          <option value="">Select a book…</option>
          {books.map((b) => (
            <option key={b.bookId} value={b.bookId}>
              {b.title}
            </option>
          ))}
        </select>
      </div>

      {bookId && (
        <div className="mt-3 flex items-center gap-3">
          <PrimaryButton variant="dark" icon={false} onClick={onBackupNow}>
            {busy ? 'Working…' : 'Back up now'}
          </PrimaryButton>
        </div>
      )}

      {bookId && (
        <div className="mt-3 space-y-2">
          {loading ? (
            <p className="text-xs text-ink/55">Loading snapshots…</p>
          ) : snapshots.length === 0 ? (
            <p className="text-xs text-ink/55">No snapshots yet for this book.</p>
          ) : (
            snapshots.map((s) => (
              <div
                key={s.file}
                data-testid="account-backup-snapshot"
                className="flex items-center justify-between gap-3 rounded-xl border border-ink/10 bg-ink/2 px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="text-xs font-mono text-ink truncate">{s.file}</div>
                  <div className="text-[11px] text-ink/55">
                    {new Date(s.createdAt).toLocaleString()} · {Math.round(s.sizeBytes / 1024)} KB
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => onRestore(s.file)}
                  disabled={busy}
                  className="shrink-0 min-h-[44px] sm:min-h-0 px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink/70 hover:bg-ink/4 disabled:opacity-50"
                >
                  Restore
                </button>
              </div>
            ))
          )}
        </div>
      )}

      {status && <p className="mt-2 text-xs text-magenta font-semibold">{status}</p>}
      {error && <p className="mt-2 text-xs text-rose-700">{error}</p>}
    </div>
  );
}

/* Plan 61 — Models card. Hosts the in-app Install Ollama affordance +
   per-model Pull controls. The card sits below the server-config card
   so the user lands on it after seeing their analyzer-engine + Ollama
   URL choices.

   On mount, GETs /api/ollama/health directly (bypassing the mock
   layer) so the ModelPullStatus row list reflects current on-disk
   state. The "Refresh available models" button inside ModelPullStatus
   re-probes via POST /refresh without going through this card.

   Direct-fetch is deliberate: in mock mode the api.getOllamaHealth
   mock returns the model as already pulled, which would make the
   Pull buttons permanently disabled. The Models card needs the real
   health envelope from the server (or whatever the e2e route-mock
   provides). */
function ModelsCard() {
  const [health, setHealth] = useState<import('../components/model-pull-status').OllamaHealthEnvelope | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/ollama/health');
        if (!res.ok) return;
        const body = await res.json();
        if (!cancelled) setHealth(body);
      } catch {
        /* Best-effort probe — leave health null and let ModelPullStatus
           render the "daemon unreachable" banner. */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section
      data-testid="account-models-card"
      className="rounded-2xl border border-ink/10 bg-white p-6 shadow-card"
    >
      <h2 className="text-base font-semibold text-ink">Models</h2>
      <p className="mt-1 text-xs text-ink/55">
        Install Ollama, pull analyzer model weights, and pre-fetch Coqui XTTS — all without
        dropping to a terminal. Kokoro v1 ships pre-installed via the release bundle, so
        nothing on this page applies to it.
      </p>

      <div className="mt-4 space-y-6">
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
          <ModelPullStatus health={health} pullableModels={PULLABLE_MODELS} />
        </div>

        <div className="space-y-2">
          <h3 className="text-sm font-medium text-ink">Coqui XTTS v2 (alternate cloning engine)</h3>
          <p className="text-xs text-ink/55">
            The alternate engine — zero-shot voice cloning from a reference clip, plus ~30 baked
            multilingual voices. Optional: Kokoro and Qwen cover the defaults. Install it here to
            pre-fetch the model; the CLI (
            <code className="font-mono">install-coqui.ps1</code> / <code className="font-mono">.sh</code>)
            stays available for scripted / offline setups, and the sidecar still auto-downloads on
            first synth if you skip this.
          </p>
          <CoquiInstall />
        </div>

        <div className="space-y-2">
          <h3 className="text-sm font-medium text-ink">Qwen3-TTS (bespoke per-character voices)</h3>
          <p className="text-xs text-ink/55">
            Qwen3-TTS designs a unique voice per character — the headline TTS engine. Install it
            here to make it the default for new books; the CLI
            (`node server/tts-sidecar/scripts/install-qwen3.mjs`) stays available for scripted /
            offline setups.
          </p>
          <QwenInstall />
        </div>

        <div className="space-y-2">
          <h3 className="text-sm font-medium text-ink">Whisper ASR (per-sentence content QA)</h3>
          <p className="text-xs text-ink/55">
            Transcribes each generated sentence and re-records "fluent but wrong words" takes the
            signal checks can't catch (srv-31). Install it here, then enable the gate with
            `SEG_ASR_ENABLED=1` (`ASR_DEVICE=cpu|cuda`); the CLI
            (`node server/tts-sidecar/scripts/install-whisper.mjs`) stays available.
          </p>
          <WhisperInstall />
        </div>
      </div>
    </section>
  );
}

/* fe-2 — power-user tuning. Device-local preferences (settings slice,
   localStorage via redux-persist): a rebindable play/pause shortcut,
   accessibility toggles (high-contrast + larger text), and the autosave
   debounce. These apply instantly and per-browser, so — unlike the account
   settings above — there's no Save button; each control dispatches directly. */
const TEXT_SCALE_OPTIONS: { value: TextScale; label: string }[] = [
  { value: 'normal', label: 'Normal' },
  { value: 'large', label: 'Large' },
  { value: 'larger', label: 'Larger' },
];

function AdvancedCard() {
  const dispatch = useAppDispatch();
  const keybindings = useAppSelector((s) => s.settings.keybindings);
  const highContrast = useAppSelector((s) => s.settings.highContrast);
  const textScale = useAppSelector((s) => s.settings.textScale);
  const autosaveDebounceMs = useAppSelector((s) => s.settings.autosaveDebounceMs);
  const autoAdvance = useAppSelector((s) => s.settings.autoAdvance);
  const skipForwardSec = useAppSelector((s) => s.settings.skipForwardSec);
  const skipBackSec = useAppSelector((s) => s.settings.skipBackSec);

  const [capturing, setCapturing] = useState<KeyboardActionId | null>(null);
  /* Local mirror so partial typing (e.g. clearing the field) doesn't clamp
     mid-edit; commit (clamped) on blur / Enter. */
  const [debounceDraft, setDebounceDraft] = useState(String(autosaveDebounceMs));
  useEffect(() => {
    setDebounceDraft(String(autosaveDebounceMs));
  }, [autosaveDebounceMs]);
  /* fe-24 — same draft-then-clamp pattern for the two skip deltas. */
  const [skipForwardDraft, setSkipForwardDraft] = useState(String(skipForwardSec));
  const [skipBackDraft, setSkipBackDraft] = useState(String(skipBackSec));
  useEffect(() => {
    setSkipForwardDraft(String(skipForwardSec));
  }, [skipForwardSec]);
  useEffect(() => {
    setSkipBackDraft(String(skipBackSec));
  }, [skipBackSec]);

  /* Rebind capture — while armed, the next keydown is swallowed and bound.
     Capture phase so it preempts any other global shortcut; Escape cancels;
     unbindable keys (Enter, arrows…) are ignored so capture keeps waiting. */
  useEffect(() => {
    if (!capturing) return;
    const action = capturing;
    function onKey(e: KeyboardEvent) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        setCapturing(null);
        return;
      }
      const key = normalizeKeyEvent(e);
      if (!key) return;
      dispatch(settingsActions.setKeybinding({ action, key }));
      setCapturing(null);
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [capturing, dispatch]);

  const commitDebounce = () => {
    const n = Number(debounceDraft);
    dispatch(settingsActions.setAutosaveDebounceMs(Number.isFinite(n) ? n : autosaveDebounceMs));
  };
  const commitSkipForward = () => {
    const n = Number(skipForwardDraft);
    dispatch(settingsActions.setSkipForwardSec(Number.isFinite(n) ? n : skipForwardSec));
  };
  const commitSkipBack = () => {
    const n = Number(skipBackDraft);
    dispatch(settingsActions.setSkipBackSec(Number.isFinite(n) ? n : skipBackSec));
  };

  return (
    <section
      data-testid="account-advanced-card"
      className="rounded-2xl border border-ink/10 bg-white p-6 shadow-card"
    >
      <h2 className="text-base font-semibold text-ink">Advanced (power-user)</h2>
      <p className="mt-1 text-xs text-ink/55">
        Device-local tuning — applies to this browser only and saves instantly (no Save needed).
      </p>

      <div className="mt-4 space-y-6">
        {/* Keyboard shortcut — play/pause */}
        <div>
          <span className="block text-sm font-medium text-ink">Keyboard shortcut — play / pause</span>
          <span className="block text-xs text-ink/55 mt-0.5">
            Toggles the mini-player on the Listen view. Default is Space; rebind to any letter or
            Space.
          </span>
          <div className="mt-2 flex items-center gap-3">
            <kbd
              data-testid="account-play-pause-binding"
              className="px-2.5 py-1 rounded-lg border border-ink/15 bg-ink/4 text-xs font-mono text-ink min-w-12 text-center"
            >
              {formatKeyLabel(keybindings['play-pause'])}
            </kbd>
            <button
              type="button"
              onClick={() => setCapturing('play-pause')}
              data-testid="account-rebind-play-pause"
              aria-pressed={capturing === 'play-pause'}
              className="px-3 py-1.5 min-h-[36px] rounded-full border border-ink/15 bg-white text-xs text-ink hover:bg-ink/4"
            >
              {capturing === 'play-pause' ? 'Press a key… (Esc to cancel)' : 'Rebind'}
            </button>
            <button
              type="button"
              onClick={() => dispatch(settingsActions.resetKeybinding('play-pause'))}
              data-testid="account-reset-play-pause"
              className="px-3 py-1.5 min-h-[36px] rounded-full text-xs text-ink/60 hover:text-ink"
            >
              Reset
            </button>
          </div>
        </div>

        {/* fe-24 — keyboard shortcut — skip back */}
        <div>
          <span className="block text-sm font-medium text-ink">Keyboard shortcut — skip back</span>
          <span className="block text-xs text-ink/55 mt-0.5">
            Rewinds the mini-player by the skip-back delta below. Default is J (mirrors YouTube).
          </span>
          <div className="mt-2 flex items-center gap-3">
            <kbd
              data-testid="account-skip-back-binding"
              className="px-2.5 py-1 rounded-lg border border-ink/15 bg-ink/4 text-xs font-mono text-ink min-w-12 text-center"
            >
              {formatKeyLabel(keybindings['skip-back'])}
            </kbd>
            <button
              type="button"
              onClick={() => setCapturing('skip-back')}
              data-testid="account-rebind-skip-back"
              aria-pressed={capturing === 'skip-back'}
              className="px-3 py-1.5 min-h-[36px] rounded-full border border-ink/15 bg-white text-xs text-ink hover:bg-ink/4"
            >
              {capturing === 'skip-back' ? 'Press a key… (Esc to cancel)' : 'Rebind'}
            </button>
            <button
              type="button"
              onClick={() => dispatch(settingsActions.resetKeybinding('skip-back'))}
              className="px-3 py-1.5 min-h-[36px] rounded-full text-xs text-ink/60 hover:text-ink"
            >
              Reset
            </button>
          </div>
        </div>

        {/* fe-24 — keyboard shortcut — skip forward */}
        <div>
          <span className="block text-sm font-medium text-ink">Keyboard shortcut — skip forward</span>
          <span className="block text-xs text-ink/55 mt-0.5">
            Fast-forwards the mini-player by the skip-forward delta below. Default is L (mirrors
            YouTube).
          </span>
          <div className="mt-2 flex items-center gap-3">
            <kbd
              data-testid="account-skip-forward-binding"
              className="px-2.5 py-1 rounded-lg border border-ink/15 bg-ink/4 text-xs font-mono text-ink min-w-12 text-center"
            >
              {formatKeyLabel(keybindings['skip-forward'])}
            </kbd>
            <button
              type="button"
              onClick={() => setCapturing('skip-forward')}
              data-testid="account-rebind-skip-forward"
              aria-pressed={capturing === 'skip-forward'}
              className="px-3 py-1.5 min-h-[36px] rounded-full border border-ink/15 bg-white text-xs text-ink hover:bg-ink/4"
            >
              {capturing === 'skip-forward' ? 'Press a key… (Esc to cancel)' : 'Rebind'}
            </button>
            <button
              type="button"
              onClick={() => dispatch(settingsActions.resetKeybinding('skip-forward'))}
              className="px-3 py-1.5 min-h-[36px] rounded-full text-xs text-ink/60 hover:text-ink"
            >
              Reset
            </button>
          </div>
        </div>

        {/* fe-24 — skip deltas (seconds) */}
        <div className="flex flex-wrap gap-x-8 gap-y-4">
          <div>
            <label htmlFor="account-skip-back-sec" className="block text-sm font-medium text-ink">
              Skip-back amount (s)
            </label>
            <span className="block text-xs text-ink/55 mt-0.5">
              {SKIP_SEC_MIN}–{SKIP_SEC_MAX} s.
            </span>
            <input
              id="account-skip-back-sec"
              type="number"
              min={SKIP_SEC_MIN}
              max={SKIP_SEC_MAX}
              step={5}
              value={skipBackDraft}
              onChange={(e) => setSkipBackDraft(e.target.value)}
              onBlur={commitSkipBack}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commitSkipBack();
                }
              }}
              data-testid="account-skip-back-sec"
              className="mt-2 w-24 rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm tabular-nums text-ink focus:ring-2 focus:ring-magenta/30"
            />
          </div>
          <div>
            <label htmlFor="account-skip-forward-sec" className="block text-sm font-medium text-ink">
              Skip-forward amount (s)
            </label>
            <span className="block text-xs text-ink/55 mt-0.5">
              {SKIP_SEC_MIN}–{SKIP_SEC_MAX} s.
            </span>
            <input
              id="account-skip-forward-sec"
              type="number"
              min={SKIP_SEC_MIN}
              max={SKIP_SEC_MAX}
              step={5}
              value={skipForwardDraft}
              onChange={(e) => setSkipForwardDraft(e.target.value)}
              onBlur={commitSkipForward}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commitSkipForward();
                }
              }}
              data-testid="account-skip-forward-sec"
              className="mt-2 w-24 rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm tabular-nums text-ink focus:ring-2 focus:ring-magenta/30"
            />
          </div>
        </div>

        {/* fe-23 — auto-advance to next chapter */}
        <div>
          <span className="block text-sm font-medium text-ink">Auto-advance chapters</span>
          <span className="block text-xs text-ink/55 mt-0.5">
            When a chapter finishes, automatically start the next one (continuous playback). The
            sleep timer's "end of chapter" mode still stops playback.
          </span>
          <label className="mt-2 inline-flex items-center gap-3 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={autoAdvance}
              onChange={(e) => dispatch(settingsActions.setAutoAdvance(e.target.checked))}
              data-testid="account-auto-advance"
              className="h-4 w-4 rounded border-ink/30 text-magenta focus:ring-2 focus:ring-magenta/30"
            />
            <span className="text-sm text-ink">
              {autoAdvance
                ? 'On — plays continuously through the book.'
                : 'Off — stops at the end of each chapter.'}
            </span>
          </label>
        </div>

        {/* High-contrast */}
        <div>
          <span className="block text-sm font-medium text-ink">High-contrast theme</span>
          <span className="block text-xs text-ink/55 mt-0.5">
            Maximises text + border contrast for low-vision use. Composes with light or dark.
          </span>
          <label className="mt-2 inline-flex items-center gap-3 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={highContrast}
              onChange={(e) => dispatch(settingsActions.setHighContrast(e.target.checked))}
              data-testid="account-high-contrast"
              className="h-4 w-4 rounded border-ink/30 text-magenta focus:ring-2 focus:ring-magenta/30"
            />
            <span className="text-sm text-ink">
              {highContrast ? 'On — high-contrast palette active.' : 'Off — standard palette.'}
            </span>
          </label>
        </div>

        {/* Text size */}
        <div>
          <label htmlFor="account-text-scale" className="block text-sm font-medium text-ink">
            Text size
          </label>
          <span className="block text-xs text-ink/55 mt-0.5">
            Scales the whole interface. Larger steps help readability on high-DPI displays.
          </span>
          <select
            id="account-text-scale"
            value={textScale}
            onChange={(e) => dispatch(settingsActions.setTextScale(e.target.value as TextScale))}
            data-testid="account-text-scale"
            className="mt-2 rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm text-ink focus:ring-2 focus:ring-magenta/30"
          >
            {TEXT_SCALE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        {/* Autosave debounce */}
        <div>
          <label htmlFor="account-autosave-debounce" className="block text-sm font-medium text-ink">
            Autosave debounce (ms)
          </label>
          <span className="block text-xs text-ink/55 mt-0.5">
            How long edits (cast, manuscript, notes) wait before writing to disk. Higher coalesces
            more; lower saves sooner. {AUTOSAVE_DEBOUNCE_MIN_MS}–{AUTOSAVE_DEBOUNCE_MAX_MS} ms.
          </span>
          <input
            id="account-autosave-debounce"
            type="number"
            min={AUTOSAVE_DEBOUNCE_MIN_MS}
            max={AUTOSAVE_DEBOUNCE_MAX_MS}
            step={100}
            value={debounceDraft}
            onChange={(e) => setDebounceDraft(e.target.value)}
            onBlur={commitDebounce}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitDebounce();
              }
            }}
            data-testid="account-autosave-debounce"
            className="mt-2 w-32 rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm tabular-nums text-ink focus:ring-2 focus:ring-magenta/30"
          />
        </div>
      </div>
    </section>
  );
}
