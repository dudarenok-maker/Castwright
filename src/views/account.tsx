/* Account view — single page that centralises user-level defaults and
   non-secret server overrides. Reached via the top-bar avatar (#/account).

   Form pattern follows src/modals/profile-drawer.tsx: local state mirrors
   the slice, edits stay local until Save dispatches the thunk that PUTs to
   the server and re-hydrates the slice. */

import { useEffect, useMemo, useState } from 'react';
import { SectionLabel, MixedHeading, PrimaryButton } from '../components/primitives';
import { MODEL_OPTION_GROUPS } from '../lib/models';
import { TTS_ENGINES, type TtsEngineId } from '../lib/tts-models';
import type { TtsModelKey, UserSettings, UserSettingsPatch } from '../lib/types';
import type { ThemePreference } from '../lib/use-theme';
import { useAppDispatch, useAppSelector } from '../store';
import { uiActions } from '../store/ui-slice';
import {
  fetchAccountSettings,
  saveAccountSettings,
  saveGeminiApiKey,
} from '../store/account-slice';
import { OllamaInstall } from '../components/ollama-install';
import { ModelPullStatus } from '../components/model-pull-status';

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
  const [defaultTtsModelKey, setDefaultTtsModelKey] = useState<TtsModelKey>(
    account.defaultTtsModelKey,
  );
  const [sidecarUrl, setSidecarUrl] = useState(account.sidecarUrl);
  const [analysisEngine, setAnalysisEngine] = useState<'local' | 'gemini'>(account.analysisEngine);
  const [ollamaUrl, setOllamaUrl] = useState(account.ollamaUrl);
  const [workspaceDirOverride, setWorkspaceDirOverride] = useState<string>(
    account.workspaceDirOverride ?? '',
  );
  const [minorCastMinLines, setMinorCastMinLines] = useState<number>(account.minorCastMinLines);
  const [coverPickerDefaultTab, setCoverPickerDefaultTab] = useState<
    NonNullable<UserSettings['coverPickerDefaultTab']>
  >(account.coverPickerDefaultTab ?? 'search');
  const [defaultThemePreference, setDefaultThemePreference] = useState<ThemePreference>(
    account.defaultThemePreference ?? 'system',
  );
  const [autoStartSidecar, setAutoStartSidecar] = useState<boolean>(
    account.autoStartSidecar ?? true,
  );
  const themeOverride = useAppSelector((s) => s.ui.themeOverride);
  const [showSaved, setShowSaved] = useState(false);

  useEffect(() => {
    setDisplayName(account.displayName);
    setDefaultAnalysisModel(account.defaultAnalysisModel);
    setDefaultTtsEngine(account.defaultTtsEngine);
    setDefaultTtsModelKey(account.defaultTtsModelKey);
    setSidecarUrl(account.sidecarUrl);
    setAnalysisEngine(account.analysisEngine);
    setOllamaUrl(account.ollamaUrl);
    setWorkspaceDirOverride(account.workspaceDirOverride ?? '');
    setMinorCastMinLines(account.minorCastMinLines);
    setCoverPickerDefaultTab(account.coverPickerDefaultTab ?? 'search');
    setDefaultThemePreference(account.defaultThemePreference ?? 'system');
    setAutoStartSidecar(account.autoStartSidecar ?? true);
  }, [
    account.hydrated,
    account.displayName,
    account.defaultAnalysisModel,
    account.defaultTtsEngine,
    account.defaultTtsModelKey,
    account.sidecarUrl,
    account.analysisEngine,
    account.ollamaUrl,
    account.workspaceDirOverride,
    account.minorCastMinLines,
    account.coverPickerDefaultTab,
    account.defaultThemePreference,
    account.autoStartSidecar,
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

  const dirty = useMemo(() => {
    return (
      displayName !== account.displayName ||
      defaultAnalysisModel !== account.defaultAnalysisModel ||
      defaultTtsEngine !== account.defaultTtsEngine ||
      defaultTtsModelKey !== account.defaultTtsModelKey ||
      sidecarUrl !== account.sidecarUrl ||
      analysisEngine !== account.analysisEngine ||
      ollamaUrl !== account.ollamaUrl ||
      minorCastMinLines !== account.minorCastMinLines ||
      coverPickerDefaultTab !== (account.coverPickerDefaultTab ?? 'search') ||
      defaultThemePreference !== (account.defaultThemePreference ?? 'system') ||
      autoStartDirty ||
      workspaceDirty
    );
  }, [
    displayName,
    defaultAnalysisModel,
    defaultTtsEngine,
    defaultTtsModelKey,
    sidecarUrl,
    analysisEngine,
    ollamaUrl,
    minorCastMinLines,
    coverPickerDefaultTab,
    defaultThemePreference,
    autoStartDirty,
    workspaceDirty,
    account,
  ]);

  const onSave = async () => {
    const patch: UserSettingsPatch = {
      displayName,
      defaultAnalysisModel,
      defaultTtsEngine,
      defaultTtsModelKey,
      sidecarUrl,
      analysisEngine,
      ollamaUrl,
      workspaceDirOverride: workspaceDirOverride.trim() === '' ? null : workspaceDirOverride.trim(),
      minorCastMinLines,
      coverPickerDefaultTab,
      defaultThemePreference,
      autoStartSidecar,
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
        <FormCard title="Profile" hint="How you appear in the top bar and the change log.">
          <FieldRow label="Display name">
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Your name"
              className="w-full px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink focus:outline-none focus:ring-2 focus:ring-magenta/30"
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
              className="w-full px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink focus:outline-none focus:ring-2 focus:ring-magenta/30"
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
              className="w-full px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink focus:outline-none focus:ring-2 focus:ring-magenta/30"
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
              className="w-full px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink focus:outline-none focus:ring-2 focus:ring-magenta/30"
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
              className="w-32 px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink focus:outline-none focus:ring-2 focus:ring-magenta/30"
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
              className="w-full px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink focus:outline-none focus:ring-2 focus:ring-magenta/30"
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
              className="w-full px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink focus:outline-none focus:ring-2 focus:ring-magenta/30"
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
          hint="The Python sidecar process that runs Kokoro / Coqui XTTS locally. The Node server can launch it for you automatically."
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
              className="w-full px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink focus:outline-none focus:ring-2 focus:ring-magenta/30"
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
              className="w-full px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink focus:outline-none focus:ring-2 focus:ring-magenta/30"
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
              className="w-full px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink focus:outline-none focus:ring-2 focus:ring-magenta/30"
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
              className="w-full px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink focus:outline-none focus:ring-2 focus:ring-magenta/30"
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

function FormCard({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-ink/10 bg-white p-6 shadow-card">
      <h2 className="text-base font-semibold text-ink">{title}</h2>
      {hint && <p className="mt-1 text-xs text-ink/55">{hint}</p>}
      <div className="mt-4 space-y-4">{children}</div>
    </section>
  );
}

function FieldRow({
  label,
  sublabel,
  children,
}: {
  label: string;
  sublabel?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-ink">{label}</span>
      {sublabel && <span className="block text-xs text-ink/55 mt-0.5">{sublabel}</span>}
      <div className="mt-2">{children}</div>
    </label>
  );
}

function ReadOnlyRow({
  label,
  sublabel,
  value,
  children,
}: {
  label: string;
  sublabel?: string;
  value?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="block">
      <span className="block text-sm font-medium text-ink">{label}</span>
      {sublabel && <span className="block text-xs text-ink/55 mt-0.5">{sublabel}</span>}
      <div className="mt-2">
        {children ?? (
          <div className="w-full px-3 py-2 rounded-xl border border-ink/10 bg-ink/[0.03] text-sm text-ink/70 font-mono break-all">
            {value}
          </div>
        )}
      </div>
    </div>
  );
}

function ApiKeyPill({ status }: { status: 'set' | 'unset' }) {
  if (status === 'set') {
    return (
      <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-emerald-100 text-emerald-800 text-xs font-semibold">
        <span className="w-2 h-2 rounded-full bg-emerald-600" />
        Set
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-amber-100 text-amber-800 text-xs font-semibold">
      <span className="w-2 h-2 rounded-full bg-amber-600" />
      Not set
    </span>
  );
}

/* Plan 49 — writable Gemini API key field. The server's apiKeyStatus is a
   redacted boolean: 'set' iff a key is reachable (either env var or the
   UI-saved value in server/user-settings.json). The plaintext NEVER comes
   back from GET — that's by design. So the field renders as an empty input
   with placeholder when 'unset', and as a masked-eight-dot placeholder
   when 'set' (the user can type to overwrite, or hit Clear to wipe). */
function GeminiKeyField({
  status,
  onSave,
}: {
  status: 'set' | 'unset';
  onSave: (key: string | null) => Promise<unknown> | unknown;
}) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<'save' | 'clear' | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 2500);
    return () => clearTimeout(t);
  }, [flash]);

  const handleSave = async () => {
    if (draft.trim().length === 0) return;
    setBusy('save');
    try {
      await onSave(draft.trim());
      setDraft('');
      setFlash('Saved.');
    } finally {
      setBusy(null);
    }
  };

  const handleClear = async () => {
    setBusy('clear');
    try {
      await onSave(null);
      setDraft('');
      setFlash('Cleared.');
    } finally {
      setBusy(null);
    }
  };

  const placeholder = status === 'set' ? '••••••••  (key on file — type to overwrite)' : 'Paste your Gemini API key';

  return (
    <div className="block">
      <span className="block text-sm font-medium text-ink">Gemini API key</span>
      <span className="block text-xs text-ink/55 mt-0.5">
        Stored plaintext in server/user-settings.json (gitignored). The env-var GEMINI_API_KEY still
        wins when present (CI / power-user override).
      </span>
      <div className="mt-2 flex items-center gap-2">
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={placeholder}
          aria-label="Gemini API key"
          className="flex-1 px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink focus:outline-none focus:ring-2 focus:ring-magenta/30"
        />
        <ApiKeyPill status={status} />
      </div>
      <div className="mt-2 flex items-center gap-2">
        <PrimaryButton
          variant={draft.trim().length > 0 ? 'dark' : 'ghost'}
          onClick={handleSave}
          icon={false}
        >
          {busy === 'save' ? 'Saving…' : 'Save key'}
        </PrimaryButton>
        {status === 'set' && (
          <button
            type="button"
            onClick={handleClear}
            disabled={busy !== null}
            className="px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink/70 hover:bg-ink/[0.04] disabled:opacity-50"
          >
            {busy === 'clear' ? 'Clearing…' : 'Clear'}
          </button>
        )}
        {flash && <span className="text-xs text-magenta font-semibold">{flash}</span>}
      </div>
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

        <div>
          <h3 className="text-sm font-medium text-ink">Coqui XTTS v2 (optional TTS engine)</h3>
          <p className="mt-1 text-xs text-ink/55">
            XTTS v2 is downloaded on first synth (~1.8 GB), or pre-fetched via{' '}
            <code className="font-mono">install-coqui</code> in the release bundle:
          </p>
          <pre
            data-testid="account-coqui-install-cmd"
            className="mt-2 rounded-xl bg-ink/[0.04] p-3 text-xs font-mono text-ink/80 overflow-x-auto"
          >{`# Windows
pwsh server/tts-sidecar/scripts/install-coqui.ps1

# macOS / Linux
bash server/tts-sidecar/scripts/install-coqui.sh`}</pre>
          <p className="mt-2 text-xs text-ink/55">
            One-shot pre-fetch is optional; the sidecar auto-downloads on first synth call.
          </p>
        </div>
      </div>
    </section>
  );
}
