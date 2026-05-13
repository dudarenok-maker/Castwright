/* Account view — single page that centralises user-level defaults and
   non-secret server overrides. Reached via the top-bar avatar (#/account).

   Form pattern follows src/modals/profile-drawer.tsx: local state mirrors
   the slice, edits stay local until Save dispatches the thunk that PUTs to
   the server and re-hydrates the slice. */

import { useEffect, useMemo, useState } from 'react';
import { SectionLabel, MixedHeading, PrimaryButton } from '../components/primitives';
import { MODEL_OPTIONS } from '../lib/models';
import { TTS_ENGINES, type TtsEngineId } from '../lib/tts-models';
import type { TtsModelKey, UserSettingsPatch } from '../lib/types';
import { useAppDispatch, useAppSelector } from '../store';
import { saveAccountSettings } from '../store/account-slice';

type AnalyzerMode = 'manual' | 'gemini';

export function AccountView() {
  const dispatch = useAppDispatch();
  const account = useAppSelector(s => s.account);

  /* Local form state — initialised from the slice and re-synced when the
     slice rehydrates (after Save or after the boot-time fetch lands). The
     workspaceDirOverride field is tracked separately so an "edited but not
     saved" diff can render the restart-required badge. */
  const [displayName,           setDisplayName]           = useState(account.displayName);
  const [defaultAnalysisModel,  setDefaultAnalysisModel]  = useState(account.defaultAnalysisModel);
  const [defaultTtsEngine,      setDefaultTtsEngine]      = useState<TtsEngineId>(account.defaultTtsEngine);
  const [defaultTtsModelKey,    setDefaultTtsModelKey]    = useState<TtsModelKey>(account.defaultTtsModelKey);
  const [analyzerMode,          setAnalyzerMode]          = useState<AnalyzerMode>(account.analyzerMode);
  const [sidecarUrl,            setSidecarUrl]            = useState(account.sidecarUrl);
  const [workspaceDirOverride,  setWorkspaceDirOverride]  = useState<string>(account.workspaceDirOverride ?? '');
  const [showSaved,             setShowSaved]             = useState(false);

  useEffect(() => {
    setDisplayName(account.displayName);
    setDefaultAnalysisModel(account.defaultAnalysisModel);
    setDefaultTtsEngine(account.defaultTtsEngine);
    setDefaultTtsModelKey(account.defaultTtsModelKey);
    setAnalyzerMode(account.analyzerMode);
    setSidecarUrl(account.sidecarUrl);
    setWorkspaceDirOverride(account.workspaceDirOverride ?? '');
  }, [account.hydrated, account.displayName, account.defaultAnalysisModel,
      account.defaultTtsEngine, account.defaultTtsModelKey, account.analyzerMode,
      account.sidecarUrl, account.workspaceDirOverride]);

  /* When the engine switches, the selected modelKey may not belong to the
     new engine's group. Default to the new group's first model so the
     dropdown never shows a mismatched value. */
  const engineGroup = TTS_ENGINES.find(g => g.id === defaultTtsEngine) ?? TTS_ENGINES[0];
  useEffect(() => {
    if (!engineGroup.models.some(m => m.id === defaultTtsModelKey)) {
      setDefaultTtsModelKey(engineGroup.models[0].id);
    }
  }, [defaultTtsEngine, engineGroup, defaultTtsModelKey]);

  /* Persisted override vs draft. The "Restart required" badge fires the
     instant the user changes the override away from the persisted value —
     even before Save — because the server is still running with the old
     value. */
  const persistedOverride = account.workspaceDirOverride ?? '';
  const workspaceDirty = workspaceDirOverride !== persistedOverride;

  const dirty = useMemo(() => {
    return displayName           !== account.displayName
        || defaultAnalysisModel  !== account.defaultAnalysisModel
        || defaultTtsEngine      !== account.defaultTtsEngine
        || defaultTtsModelKey    !== account.defaultTtsModelKey
        || analyzerMode          !== account.analyzerMode
        || sidecarUrl            !== account.sidecarUrl
        || workspaceDirty;
  }, [displayName, defaultAnalysisModel, defaultTtsEngine, defaultTtsModelKey,
      analyzerMode, sidecarUrl, workspaceDirty, account]);

  const onSave = async () => {
    const patch: UserSettingsPatch = {
      displayName,
      defaultAnalysisModel,
      defaultTtsEngine,
      defaultTtsModelKey,
      analyzerMode,
      sidecarUrl,
      workspaceDirOverride: workspaceDirOverride.trim() === '' ? null : workspaceDirOverride.trim(),
    };
    const action = await dispatch(saveAccountSettings(patch));
    if (saveAccountSettings.fulfilled.match(action)) {
      setShowSaved(true);
      setTimeout(() => setShowSaved(false), 2400);
    }
  };

  const saving = account.status === 'saving';

  return (
    <div className="max-w-[960px] mx-auto px-6 py-10">
      <div className="mb-8">
        <SectionLabel>Account</SectionLabel>
        <div className="mt-4">
          <MixedHeading regular="Your" bold="defaults" level="h1"/>
        </div>
        <p className="mt-3 text-ink/60 max-w-xl">
          Workspace-wide preferences. Defaults seed new books — once you
          pick a model for a specific book, that choice sticks for that book.
        </p>
      </div>

      <div className="space-y-6">
        <FormCard title="Profile" hint="How you appear in the top bar and the change log.">
          <FieldRow label="Display name">
            <input type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Your name"
              className="w-full px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink focus:outline-none focus:ring-2 focus:ring-magenta/30"/>
          </FieldRow>
        </FormCard>

        <FormCard title="Defaults for new books"
          hint="Used the first time you open a book that hasn't been touched yet. Per-book choices override these and persist.">
          <FieldRow label="Analysis model">
            <select
              value={defaultAnalysisModel}
              onChange={(e) => setDefaultAnalysisModel(e.target.value)}
              className="w-full px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink focus:outline-none focus:ring-2 focus:ring-magenta/30">
              {MODEL_OPTIONS.map(m => (
                <option key={m.id} value={m.id} title={m.hint}>{m.label}</option>
              ))}
            </select>
          </FieldRow>
          <FieldRow label="TTS engine">
            <select
              value={defaultTtsEngine}
              onChange={(e) => setDefaultTtsEngine(e.target.value as TtsEngineId)}
              className="w-full px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink focus:outline-none focus:ring-2 focus:ring-magenta/30">
              {TTS_ENGINES.map(g => (
                <option key={g.id} value={g.id} title={g.hint}>{g.label}</option>
              ))}
            </select>
          </FieldRow>
          <FieldRow label="TTS model">
            <select
              value={defaultTtsModelKey}
              onChange={(e) => setDefaultTtsModelKey(e.target.value as TtsModelKey)}
              className="w-full px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink focus:outline-none focus:ring-2 focus:ring-magenta/30">
              {engineGroup.models.map(m => (
                <option key={m.id} value={m.id} title={m.hint}>{m.label}</option>
              ))}
            </select>
          </FieldRow>
        </FormCard>

        <FormCard title="Server configuration"
          hint="Non-secret overrides for what's in server/.env. Analyzer mode and sidecar URL take effect on the next request; workspace directory needs a server restart.">
          <FieldRow label="Analyzer mode"
            sublabel="Manual writes a prompt for you to drop into a separate window; Gemini calls the API directly.">
            <select
              value={analyzerMode}
              onChange={(e) => setAnalyzerMode(e.target.value as AnalyzerMode)}
              className="w-full px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink focus:outline-none focus:ring-2 focus:ring-magenta/30">
              <option value="manual">Manual (file-drop handoff)</option>
              <option value="gemini">Gemini (live API)</option>
            </select>
          </FieldRow>
          <FieldRow label="Sidecar URL"
            sublabel="Local TTS sidecar endpoint. Default: http://localhost:9000">
            <input type="text"
              value={sidecarUrl}
              onChange={(e) => setSidecarUrl(e.target.value)}
              placeholder="http://localhost:9000"
              className="w-full px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink focus:outline-none focus:ring-2 focus:ring-magenta/30"/>
          </FieldRow>
          <FieldRow label="Workspace directory override"
            sublabel="Absolute or relative-to-server/ path. Leave empty to use WORKSPACE_DIR from server/.env.">
            <input type="text"
              value={workspaceDirOverride}
              onChange={(e) => setWorkspaceDirOverride(e.target.value)}
              placeholder="(leave empty to use server/.env)"
              className="w-full px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink focus:outline-none focus:ring-2 focus:ring-magenta/30"/>
            {workspaceDirty && (
              <p className="mt-2 text-xs text-amber-800 bg-amber-100 rounded-full px-3 py-1 inline-block">
                Restart the server to apply this change.
              </p>
            )}
          </FieldRow>
          <ReadOnlyRow label="Active workspace root"
            value={account.workspaceRoot || '(unknown)'}
            sublabel={`Source: ${account.workspaceSource}`}/>
          <ReadOnlyRow label="Gemini API key">
            <ApiKeyPill status={account.apiKeyStatus}/>
          </ReadOnlyRow>
        </FormCard>

        <div className="flex items-center gap-4">
          <PrimaryButton variant={dirty ? 'dark' : 'ghost'} onClick={onSave} icon={false}>
            {saving ? 'Saving…' : 'Save changes'}
          </PrimaryButton>
          {showSaved && (
            <span className="text-xs text-magenta font-semibold">Saved.</span>
          )}
          {account.status === 'error' && account.error && (
            <span className="text-xs text-rose-700">{account.error}</span>
          )}
        </div>
      </div>
    </div>
  );
}

function FormCard({ title, hint, children }: {
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

function FieldRow({ label, sublabel, children }: {
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

function ReadOnlyRow({ label, sublabel, value, children }: {
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
        <span className="w-2 h-2 rounded-full bg-emerald-600"/>
        Set in server/.env
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-amber-100 text-amber-800 text-xs font-semibold">
      <span className="w-2 h-2 rounded-full bg-amber-600"/>
      Not set — add GEMINI_API_KEY to server/.env
    </span>
  );
}
