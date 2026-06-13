/* Advanced configuration view — tune model, generation, and QA knobs.
   Reached from Admin (#/admin → "Advanced configuration →") and from
   the Account view. URL: #/advanced.

   Shell mirrors model-manager.tsx: SectionLabel + MixedHeading + subtitle,
   max-w container, space-y body. The body is a SettingsAccordion over the
   server's group registry; each section holds OverrideRow cells or, for
   isPrompt knobs, a PromptRow. */

import { useEffect, useState } from 'react';
import { MixedHeading } from '../components/primitives';
import { SettingsAccordion, SettingsSection } from '../components/settings/settings-accordion';
import { OverrideRow } from '../components/settings/override-row';
import { RestartSidecarBanner } from '../components/settings/restart-sidecar-banner';
import { useAppDispatch, useAppSelector } from '../store';
import { uiActions } from '../store/ui-slice';
import {
  fetchConfig,
  saveOverride,
  resetKnob,
  resetGroup,
  resetAllConfig,
  restartSidecar,
  forkPrompt,
  revertPrompt,
  selectRestartPending,
  selectRestartServerPending,
} from '../store/config-slice';
import { api } from '../lib/api';
import type { KnobDescriptor, PromptState } from '../lib/types';

/* ── PromptRow ────────────────────────────────────────────────────────────── */

/* Inline (not a separate file) — it's only used once and < 80 lines. */

interface PromptRowProps {
  descriptor: KnobDescriptor;
}

function PromptRow({ descriptor }: PromptRowProps) {
  const dispatch = useAppDispatch();
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const load = () => {
    setLoadError(null);
    api
      .getPrompt(descriptor.key)
      .then((p) => {
        setPrompt(p);
      })
      .catch((e: Error) => setLoadError(e.message));
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [descriptor.key]);

  const handleEdit = () => {
    setDraft(prompt?.text ?? '');
    setEditing(true);
    setSaveError(null);
  };

  const handleSave = async () => {
    setBusy(true);
    setSaveError(null);
    try {
      await dispatch(forkPrompt({ id: descriptor.key, text: draft })).unwrap();
      setEditing(false);
      load();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleRevert = async () => {
    setBusy(true);
    setSaveError(null);
    try {
      await dispatch(revertPrompt(descriptor.key)).unwrap();
      setEditing(false);
      load();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="py-3 border-b border-ink/8 last:border-b-0">
      <div className="flex items-start gap-2 flex-wrap mb-1">
        <span className="text-sm font-medium text-ink flex-1">{descriptor.label}</span>
        {prompt?.isForked ? (
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-magenta/10 text-magenta">
            Using your fork
          </span>
        ) : (
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-ink/8 text-ink/55">
            Using shipped default
          </span>
        )}
      </div>
      <p className="text-xs text-ink/55 mb-2">{descriptor.help}</p>

      {loadError && <p className="text-xs text-rose-700 mb-2">Couldn't load prompt: {loadError}</p>}

      {!editing ? (
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={handleEdit}
            disabled={busy || !prompt}
            className="px-3 py-1.5 rounded-lg border border-ink/15 bg-white text-xs text-ink hover:bg-ink/4 min-h-[44px] sm:min-h-0 disabled:opacity-50"
          >
            Edit
          </button>
          {prompt?.isForked && (
            <button
              type="button"
              onClick={handleRevert}
              disabled={busy}
              className="px-3 py-1.5 rounded-lg border border-rose-200 bg-white text-xs text-rose-700 hover:bg-rose-50 min-h-[44px] sm:min-h-0 disabled:opacity-50"
            >
              {busy ? 'Reverting…' : 'Revert to default'}
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={6}
            className="w-full px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink font-mono focus:outline-hidden focus:ring-2 focus:ring-magenta/30 resize-y"
          />
          {saveError && <p className="text-xs text-rose-700">{saveError}</p>}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleSave}
              disabled={busy}
              className="px-4 py-2 rounded-xl bg-ink text-canvas text-sm font-medium hover:bg-ink-soft min-h-[44px] sm:min-h-0 disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              disabled={busy}
              className="px-4 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink/70 hover:bg-ink/5 min-h-[44px] sm:min-h-0 disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── AdvancedView ─────────────────────────────────────────────────────────── */

export function AdvancedView() {
  const dispatch = useAppDispatch();
  const { groups, descriptors, values, status, error, hydrated } = useAppSelector((s) => s.config);
  const restartPending = useAppSelector(selectRestartPending);
  const restartServerPending = useAppSelector(selectRestartServerPending);
  const [restarting, setRestarting] = useState(false);

  useEffect(() => {
    dispatch(fetchConfig());
  }, [dispatch]);

  const handleResetAll = () => {
    if (!window.confirm('Reset all advanced settings to their defaults?')) return;
    void dispatch(resetAllConfig());
  };

  const handleRestart = async () => {
    setRestarting(true);
    try {
      await dispatch(restartSidecar()).unwrap();
    } finally {
      setRestarting(false);
    }
  };

  return (
    <div className="max-w-[1200px] mx-auto px-4 sm:px-6 py-10">
      <div className="mb-8">
        <button
          type="button"
          data-testid="advanced-back-to-admin"
          onClick={() => dispatch(uiActions.openAdmin())}
          className="text-xs font-medium text-ink/60 hover:text-ink"
        >
          ← Admin
        </button>
        <div className="mt-4">
          <MixedHeading regular="Advanced" bold="configuration" level="h1" />
        </div>
        <p className="mt-3 text-ink/60 max-w-xl">
          Tune model, generation, and QA settings at your own risk. Changes persist on disk and
          survive server restarts.
        </p>
      </div>

      {/* Banners */}
      <div className="space-y-3 mb-6">
        <RestartSidecarBanner
          visible={restartPending}
          onRestart={handleRestart}
          restarting={restarting}
        />
        {restartServerPending && (
          <div className="flex items-center gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-5 py-3">
            <p className="text-sm text-amber-800">
              Some changes need an app restart to take effect.
            </p>
          </div>
        )}
      </div>

      {/* Loading / error states */}
      {!hydrated && status === 'loading' && (
        <p className="text-sm text-ink/60">Loading configuration…</p>
      )}
      {!hydrated && status === 'error' && (
        <section
          role="alert"
          className="rounded-2xl border border-rose-200 bg-rose-50 p-6 shadow-card"
        >
          <h2 className="text-base font-semibold text-rose-900">Couldn't load configuration</h2>
          {error && <p className="mt-2 text-sm text-rose-900/85 font-mono break-all">{error}</p>}
          <button
            type="button"
            onClick={() => dispatch(fetchConfig())}
            className="mt-4 px-4 py-2 rounded-xl bg-rose-700 text-white text-sm font-medium hover:bg-rose-800"
          >
            Retry
          </button>
        </section>
      )}

      {hydrated && (
        <div className="space-y-6">
          {/* Reset-all header */}
          <div className="flex items-center justify-end">
            <button
              type="button"
              onClick={handleResetAll}
              className="px-4 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink/70 hover:bg-ink/5 min-h-[44px] sm:min-h-0"
            >
              Reset all
            </button>
          </div>

          <SettingsAccordion
            sections={groups.map((g) => ({ id: g.id, label: g.label, risk: g.risk }))}
          >
            {groups.map((group) => {
              const groupDescriptors = descriptors.filter((d) => d.group === group.id);
              const overriddenCount = groupDescriptors.filter(
                (d) => values[d.key]?.overridden,
              ).length;

              return (
                <SettingsSection
                  key={group.id}
                  group={group}
                  overriddenCount={overriddenCount}
                  onResetSection={() => dispatch(resetGroup(group.id))}
                >
                  {groupDescriptors.map((d) =>
                    d.isPrompt ? (
                      <PromptRow key={d.key} descriptor={d} />
                    ) : (
                      <OverrideRow
                        key={d.key}
                        descriptor={d}
                        value={
                          values[d.key] ?? {
                            key: d.key,
                            effective: d.default,
                            source: 'default',
                            locked: false,
                            overridden: false,
                          }
                        }
                        onChange={(raw) => dispatch(saveOverride({ key: d.key, value: raw }))}
                        onRevert={() => dispatch(resetKnob(d.key))}
                      />
                    ),
                  )}
                </SettingsSection>
              );
            })}
          </SettingsAccordion>
        </div>
      )}
    </div>
  );
}
