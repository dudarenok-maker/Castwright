/* Account view — single page that centralises user-level defaults and
   non-secret server overrides. Reached via the top-bar avatar (#/account).

   Form pattern follows src/modals/profile-drawer.tsx: local state mirrors
   the slice, edits stay local until Save dispatches the thunk that PUTs to
   the server and re-hydrates the slice. */

import { useEffect, useMemo, useState } from 'react';
import { SectionLabel, MixedHeading, PrimaryButton } from '../components/primitives';
import type {
  BackupSnapshot,
  ConfigGroup,
  UserSettings,
  UserSettingsPatch,
} from '../lib/types';
import type { ThemePreference } from '../lib/use-theme';
import { api } from '../lib/api';
import { UpgradeCard } from '../components/upgrade-card';
import { selectLibraryBooks, libraryActions } from '../store/library-slice';
import { useAppDispatch, useAppSelector } from '../store';
import { uiActions } from '../store/ui-slice';
import { fetchAccountSettings, saveAccountSettings } from '../store/account-slice';
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
import { FieldRow, ReadOnlyRow } from '../components/account-forms';
import {
  SettingsAccordion,
  SettingsSection,
} from '../components/settings/settings-accordion';

/* Synthetic ConfigGroup descriptors for account sections — these are not
   registry knobs, so overriddenCount is always 0 and there's no reset. */
function acctGroup(id: string, label: string, help: string): ConfigGroup {
  return { id, label, help, risk: 'low', collapsedByDefault: false };
}

export function AccountView() {
  const dispatch = useAppDispatch();
  const account = useAppSelector((s) => s.account);

  /* Local form state — initialised from the slice and re-synced when the
     slice rehydrates (after Save or after the boot-time fetch lands). The
     workspaceDirOverride field is tracked separately so an "edited but not
     saved" diff can render the restart-required badge. */
  const [displayName, setDisplayName] = useState(account.displayName);
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
    setWorkspaceDirOverride(account.workspaceDirOverride ?? '');
    setMinorCastMinLines(account.minorCastMinLines);
    setCoverPickerDefaultTab(account.coverPickerDefaultTab ?? 'search');
    setDefaultThemePreference(account.defaultThemePreference ?? 'system');
    setBackupEnabled(account.backupEnabled ?? true);
    setBackupCadence(account.backupCadence ?? 'daily');
    setBackupRetention(account.backupRetention ?? 14);
  }, [
    account.hydrated,
    account.displayName,
    account.workspaceDirOverride,
    account.minorCastMinLines,
    account.coverPickerDefaultTab,
    account.defaultThemePreference,
    account.backupEnabled,
    account.backupCadence,
    account.backupRetention,
  ]);

  /* Persisted override vs draft. The "Restart required" badge fires the
     instant the user changes the override away from the persisted value —
     even before Save — because the server is still running with the old
     value. */
  const persistedOverride = account.workspaceDirOverride ?? '';
  const workspaceDirty = workspaceDirOverride !== persistedOverride;

  const dirty = useMemo(() => {
    return (
      displayName !== account.displayName ||
      minorCastMinLines !== account.minorCastMinLines ||
      coverPickerDefaultTab !== (account.coverPickerDefaultTab ?? 'search') ||
      defaultThemePreference !== (account.defaultThemePreference ?? 'system') ||
      workspaceDirty
    );
  }, [
    displayName,
    minorCastMinLines,
    coverPickerDefaultTab,
    defaultThemePreference,
    workspaceDirty,
    account,
  ]);

  const onSave = async () => {
    const patch: UserSettingsPatch = {
      displayName,
      workspaceDirOverride: workspaceDirOverride.trim() === '' ? null : workspaceDirOverride.trim(),
      minorCastMinLines,
      coverPickerDefaultTab,
      defaultThemePreference,
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

        <SettingsAccordion
          sections={[
            { id: 'acct-profile', label: 'Profile', risk: 'low' },
            { id: 'acct-cast-analysis', label: 'Cast analysis', risk: 'low' },
            { id: 'acct-covers', label: 'Covers', risk: 'low' },
            { id: 'acct-appearance', label: 'Appearance', risk: 'low' },
            { id: 'acct-backups', label: 'Backups', risk: 'low' },
            { id: 'acct-workspace', label: 'Workspace', risk: 'low' },
            { id: 'acct-device-local', label: 'Device-local', risk: 'low' },
          ]}
        >
          <SettingsSection
            group={acctGroup('acct-profile', 'Profile', 'How you appear in the top bar and the change log.')}
            overriddenCount={0}
          >
            <FieldRow label="Display name">
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Your name"
                className="w-full px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink focus:outline-hidden focus:ring-2 focus:ring-magenta/30"
              />
            </FieldRow>
          </SettingsSection>

          <SettingsSection
            group={acctGroup(
              'acct-cast-analysis',
              'Cast analysis',
              'How the analyzer decides which characters earn a dedicated voice profile vs. get folded into the generic Unknown male / Unknown female buckets.',
            )}
            overriddenCount={0}
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
          </SettingsSection>

          <SettingsSection
            group={acctGroup(
              'acct-covers',
              'Covers',
              'How the cover picker opens for new books. Plan 40 added local-disk upload alongside the OpenLibrary search.',
            )}
            overriddenCount={0}
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
          </SettingsSection>

          <SettingsSection
            group={acctGroup(
              'acct-appearance',
              'Appearance',
              "How the app looks. The sun/moon toggle in the top bar is a device-only override; this picker sets the default that any new device or fresh session inherits.",
            )}
            overriddenCount={0}
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
          </SettingsSection>

          <SettingsSection
            group={acctGroup(
              'acct-backups',
              'Backups',
              "Automatic snapshots of each book's state.json (cast, chapters, metadata) so an accidental edit or corrupt write can be rolled back. Snapshots live alongside the book in its workspace folder.",
            )}
            overriddenCount={0}
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
          </SettingsSection>

          <SettingsSection
            group={acctGroup(
              'acct-workspace',
              'Workspace',
              'Where this machine keeps your library on disk. Changing it needs a server restart.',
            )}
            overriddenCount={0}
          >
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
          </SettingsSection>

          <AdvancedCard />
        </SettingsAccordion>

        {/* fs-23 — model setup (engines, installers, sidecar, analyzer split,
            server config) now lives in the Model Manager, reached from Admin. */}
        <section className="rounded-2xl border border-ink/10 bg-white p-6 shadow-card flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-base font-semibold text-ink">Models &amp; engines</h2>
            <p className="mt-1 text-xs text-ink/55 max-w-prose">
              Installing models, picking the default Voice / analyzer engine, the Voice engine /
              Ollama URLs, and the Gemini key now live in the Model Manager.
            </p>
          </div>
          <button
            type="button"
            onClick={() => dispatch(uiActions.openModelManager())}
            data-testid="account-model-manager-pointer"
            className="shrink-0 min-h-[44px] sm:min-h-0 px-4 py-2 rounded-xl bg-ink text-canvas text-sm font-medium hover:bg-ink-soft"
          >
            Open Model Manager →
          </button>
        </section>

        <section className="rounded-2xl border border-ink/10 bg-white p-6 shadow-card flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-base font-semibold text-ink">Advanced configuration</h2>
            <p className="mt-1 text-xs text-ink/55 max-w-prose">
              Tune model, generation, and QA settings at your own risk.
            </p>
          </div>
          <button
            type="button"
            onClick={() => dispatch(uiActions.openAdvanced())}
            data-testid="account-advanced-pointer"
            className="shrink-0 min-h-[44px] sm:min-h-0 px-4 py-2 rounded-xl bg-ink text-canvas text-sm font-medium hover:bg-ink-soft"
          >
            Open Advanced settings →
          </button>
        </section>

        <section className="rounded-2xl border border-ink/10 bg-white p-6 shadow-card flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-base font-semibold text-ink">Help &amp; troubleshooting</h2>
            <p className="mt-1 text-xs text-ink/55 max-w-prose">
              FAQs, engine setup guides, and troubleshooting steps for common issues.
            </p>
          </div>
          <a
            href="#/help"
            data-testid="account-help-pointer"
            className="shrink-0 min-h-[44px] sm:min-h-0 px-4 py-2 rounded-xl bg-ink text-canvas text-sm font-medium hover:bg-ink-soft inline-flex items-center"
          >
            Open Help →
          </a>
        </section>

        <section className="rounded-2xl border border-ink/10 bg-white p-6 shadow-card flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-base font-semibold text-ink">First-run setup</h2>
            <p className="mt-1 text-xs text-ink/55 max-w-prose">
              Re-open the setup wizard to check model installation, workspace, and engine readiness.
            </p>
          </div>
          <button
            type="button"
            onClick={() => dispatch(uiActions.openSetup())}
            data-testid="account-rerun-setup"
            className="shrink-0 min-h-[44px] sm:min-h-0 px-4 py-2 rounded-xl bg-ink text-canvas text-sm font-medium hover:bg-ink-soft"
          >
            Re-run setup →
          </button>
        </section>

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
    <SettingsSection
      group={acctGroup(
        'acct-device-local',
        'Device-local (this browser only)',
        'Device-local tuning — applies to this browser only and saves instantly (no Save needed).',
      )}
      overriddenCount={0}
    >
      <div
        data-testid="account-advanced-card"
        className="space-y-6"
      >
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
    </SettingsSection>
  );
}
