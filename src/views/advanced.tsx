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
import { OverrideRow, beginConfigAction, describeConfigSaveError } from '../components/settings/override-row';
import { RestartSidecarBanner } from '../components/settings/restart-sidecar-banner';
import { EnvCleanupNotice } from '../components/env-cleanup-notice';
import { useAppDispatch, useAppSelector } from '../store';
import { uiActions } from '../store/ui-slice';
import { notificationsActions } from '../store/notifications-slice';
import {
  fetchConfig,
  saveOverride,
  resetKnob,
  resetGroup,
  resetAllConfig,
  restartSidecar,
  cleanupEnvKnobs,
  forkPrompt,
  revertPrompt,
  selectRestartPending,
  selectRestartServerPending,
} from '../store/config-slice';
import { api } from '../lib/api';
import type {
  GpuDevice,
  KnobDescriptor,
  KnobValue,
  PromptState,
  StaleReason,
  AnalyzerDeviceResponse,
  AnalyzerGpuSplitResponse,
} from '../lib/types';

/* #2221 — extracts a displayable message from a rejected restartSidecar
   promise WITHOUT going through describeConfigSaveError: that parser is
   specifically for /api/config's `{error}` JSON envelope
   (configApiErrorMessage, lib/api.ts), and restartSidecar hits a
   different route (/api/sidecar/restart, realRestartSidecar) with no such
   guarantee — forcing it through the config parser would either coerce an
   unrelated shape onto it or (more likely) just fall through to raw-
   message-as-is, which happens to work today only by accident. `.unwrap()`
   re-throws RTK's SerializedError — a plain object, never a real Error
   instance — so this reads `.message` off either shape. */
function restartFailureMessage(reason: unknown): string {
  if (reason instanceof Error && reason.message) return reason.message;
  if (typeof reason === 'object' && reason !== null && 'message' in reason) {
    const message = (reason as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }
  return 'Failed to restart the sidecar.';
}

/* ── per-device-knob staleReason derivation ──────────────────────────────── */

/* Which sidecar engine a device knob's key pins. */
function engineForDeviceKnob(key: string): string | null {
  if (key === 'tts.qwen.device') return 'qwen';
  if (key === 'tts.coqui.device') return 'coqui';
  if (key === 'tts.kokoro.device') return 'kokoro';
  return null;
}

/* Task 12 already sets `value.staleReason` server-side (uuid_unresolved via
   resolveKnob) — that always wins. Otherwise, for a device knob, check whether
   ITS engine shows up in any GET /api/gpu/devices entry's resident[] with
   stale_reason:'cpu_fallback' (merged in server-side from the sidecar's /health,
   Task 13). Only 'cpu_fallback' is derived here — a global-shadow fact surfaces
   as its own Advanced Configuration banner, not a per-knob reason. */
function deriveStaleReason(
  descriptor: KnobDescriptor,
  value: KnobValue,
  gpuDevices: GpuDevice[],
): StaleReason | undefined {
  if (value.staleReason) return value.staleReason;
  const engine = engineForDeviceKnob(descriptor.key);
  if (!engine) return undefined;
  for (const d of gpuDevices) {
    const entry = d.resident?.find((r) => r.engine === engine);
    if (entry?.stale_reason === 'cpu_fallback') return 'cpu_fallback';
  }
  return undefined;
}

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
            className="px-3 py-1.5 rounded-lg border border-ink/15 bg-white text-xs text-ink hover:bg-ink/4 min-h-[44px] fine-pointer:min-h-0 disabled:opacity-50"
          >
            Edit
          </button>
          {prompt?.isForked && (
            <button
              type="button"
              onClick={handleRevert}
              disabled={busy}
              className="px-3 py-1.5 rounded-lg border border-rose-200 bg-white text-xs text-rose-700 hover:bg-rose-50 min-h-[44px] fine-pointer:min-h-0 disabled:opacity-50"
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
              className="px-4 py-2 rounded-xl bg-ink text-canvas text-sm font-medium hover:bg-ink-soft min-h-[44px] fine-pointer:min-h-0 disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              disabled={busy}
              className="px-4 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink/70 hover:bg-ink/5 min-h-[44px] fine-pointer:min-h-0 disabled:opacity-50"
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
  const {
    groups,
    descriptors,
    values,
    status,
    error,
    hydrated,
    cudaEnvShadow,
    envCleanupCandidates,
  } = useAppSelector((s) => s.config);
  const restartPending = useAppSelector(selectRestartPending);
  const restartServerPending = useAppSelector(selectRestartServerPending);
  const [restarting, setRestarting] = useState(false);
  const [cleaningUpEnv, setCleaningUpEnv] = useState(false);
  const [gpuDevices, setGpuDevices] = useState<GpuDevice[]>([]);
  const [analyzerDevice, setAnalyzerDevice] = useState<AnalyzerDeviceResponse['device'] | null>(
    null,
  );
  const [gpuSplit, setGpuSplit] = useState<AnalyzerGpuSplitResponse | null>(null);

  useEffect(() => {
    dispatch(fetchConfig());
    // Best-effort: an unreachable sidecar just means device knobs fall back
    // to the auto/cpu-only dropdown (see override-row.tsx).
    api
      .getGpuDevices()
      .then((res) => setGpuDevices(res.devices))
      .catch(() => setGpuDevices([]));
    // Best-effort: a request that never lands (network error, not just a
    // non-2xx from Ollama) reads the same as a genuinely unreachable daemon.
    api
      .getAnalyzerDevice()
      .then((res) => setAnalyzerDevice(res.device))
      .catch(() => setAnalyzerDevice('unreachable'));
    // #2367 Task 3 — same best-effort contract as the device probe above:
    // degrade to a "reachable: false" shape rather than throwing into the
    // view, since a failed split probe must not sink the whole row.
    api
      .getAnalyzerGpuSplit()
      .then((res) => setGpuSplit(res))
      .catch(() =>
        setGpuSplit({
          reachable: false,
          split: false,
          deviceIndices: [],
          totalUsedMb: 0,
          wouldFitSingleDevice: false,
          dataUnavailable: false,
        }),
      );
  }, [dispatch]);

  /* Plan 2 §2.4 — the analyzer-device row is only meaningful when the
     analyzer is actually dispatching through the local Ollama daemon;
     under ANALYZER=gemini there's no local device to report. Reuses the
     `analyzer.engine` knob's live value already hydrated into `values` by
     fetchConfig(), rather than adding a second endpoint/state slice for
     the same fact. */
  const analyzerEngine = values['analyzer.engine']?.effective;

  /* #2367 Task 4 — expectedDevice is a declared, advisory expectation (see
     the knob's help text: this app cannot pin the Ollama daemon's device).
     A non-empty declaration that the detected split contradicts sharpens
     Task 3's warning into a named mismatch, independent of whether the
     split would fit on one device — the operator said "GPU N only", so a
     split onto any other combination is worth calling out even when it's
     unavoidable. Distinguish between two distinct cases: (1) a genuine split
     onto devices that include one outside expectedDevice, and (2) no split,
     but the single resident device is the wrong one — they need different
     wording. */
  const expectedDeviceRaw = values['analyzer.ollama.expectedDevice']?.effective as
    | string
    | undefined;
  const expectedDevice = expectedDeviceRaw?.trim() ?? '';
  const expectedDeviceNum = expectedDevice === '' ? NaN : Number(expectedDevice);

  // Case 1: Genuine split (split=true) with at least one device not matching
  const expectedDeviceSplitMismatch =
    expectedDevice !== '' &&
    !Number.isNaN(expectedDeviceNum) &&
    !!gpuSplit &&
    gpuSplit.split &&
    gpuSplit.deviceIndices.length > 0 &&
    !gpuSplit.deviceIndices.every((idx) => idx === expectedDeviceNum);

  // Case 2: No split (split=false), but the single device is wrong
  // With 2+ resident PIDs (e.g., analyzer + design model), deviceIndices.length > 1,
  // so expectedDeviceWrongSingle remains false — ambiguous which model expectedDevice
  // refers to, so we don't show a mismatch warning (fail-closed behavior).
  const expectedDeviceWrongSingle =
    expectedDevice !== '' &&
    !Number.isNaN(expectedDeviceNum) &&
    !!gpuSplit &&
    !gpuSplit.split &&
    gpuSplit.deviceIndices.length === 1 &&
    gpuSplit.deviceIndices[0] !== expectedDeviceNum;

  const handleResetAll = () => {
    if (!window.confirm('Reset all advanced settings to their defaults?')) return;
    // #2209 — "Reset all" has no single row to attribute a rejection to
    // (it can touch every knob at once), so a rejection here is the toast
    // half of the "both" decision rather than an OverrideRow inline error.
    dispatch(resetAllConfig())
      .unwrap()
      .catch((reason: unknown) => {
        dispatch(
          notificationsActions.pushToast({
            kind: 'error',
            message: `Couldn't reset all settings: ${describeConfigSaveError(reason).message}`,
            // #2209 review "also fix" — every other pushToast site
            // (layout.tsx) dedupes; without it, repeated Reset-all
            // failures (e.g. a user retrying the same button) stack.
            dedupeKey: 'config-reset-all-failed',
          }),
        );
      });
  };

  const handleRestart = async () => {
    setRestarting(true);
    try {
      await dispatch(restartSidecar()).unwrap();
    } catch (reason) {
      // #2221 — this button's own row-vs-page distinction: a restart is
      // page-level (there's no single OverrideRow it's attributable to),
      // so it toasts, the same pattern handleResetAll/onResetSection
      // already use — NOT describeConfigSaveError, which is specifically
      // for /api/config's `{error}` JSON envelope. restartSidecar hits
      // /api/sidecar/restart, a different route with no such guarantee;
      // this reads the rejection's own message with a plain fallback.
      dispatch(
        notificationsActions.pushToast({
          kind: 'error',
          message: `Couldn't restart the sidecar: ${restartFailureMessage(reason)}`,
          dedupeKey: 'sidecar-restart-failed',
        }),
      );
    } finally {
      // Runs on EITHER outcome — restarting must clear so Restart sidecar
      // is clickable again either way; the toast above is what tells the
      // two outcomes apart, since the banner itself (RestartSidecarBanner)
      // reverts to the same "Restart sidecar" idle state regardless.
      setRestarting(false);
    }
  };

  const handleCleanupEnv = async () => {
    setCleaningUpEnv(true);
    try {
      await dispatch(cleanupEnvKnobs()).unwrap();
      // Refetch so envCleanupCandidates reflects the post-cleanup state —
      // ideally [], which is what makes the notice never nag once resolved.
      await dispatch(fetchConfig());
    } catch (reason: unknown) {
      dispatch(
        notificationsActions.pushToast({
          kind: 'error',
          message: `Couldn't clean up leftover settings: ${describeConfigSaveError(reason).message}`,
          dedupeKey: 'env-cleanup-failed',
        }),
      );
    } finally {
      setCleaningUpEnv(false);
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
        <EnvCleanupNotice
          candidateCount={envCleanupCandidates.length}
          onCleanup={() => {
            void handleCleanupEnv();
          }}
          busy={cleaningUpEnv}
        />
        {cudaEnvShadow && (
          <div className="flex items-center gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-5 py-3">
            <p className="text-sm text-amber-800">
              <code className="font-mono">CUDA_VISIBLE_DEVICES</code>/
              <code className="font-mono">CUDA_DEVICE_ORDER</code> is set in{' '}
              <code className="font-mono">server/.env</code> — it overrides every device pin
              below. See{' '}
              <a href="/docs/local-llm.md" className="underline">
                docs/local-llm.md
              </a>{' '}
              to switch to per-engine pins.
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
              /* See override-row.tsx's beginConfigAction/isConfigActionTarget
                 — abandons, rather than commits, whatever's mid-edit in the
                 currently-focused knob input, whether reached by mouse or
                 by Tab. */
              data-config-action
              onMouseDown={() => beginConfigAction()}
              onClick={handleResetAll}
              className="px-4 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink/70 hover:bg-ink/5 min-h-[44px] fine-pointer:min-h-0"
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
                  onResetSection={() => {
                    // #2209 — same toast rationale as "Reset all": a
                    // section reset spans every knob in the group, so
                    // there's no single row to show the rejection inline.
                    dispatch(resetGroup(group.id))
                      .unwrap()
                      .catch((reason: unknown) => {
                        dispatch(
                          notificationsActions.pushToast({
                            kind: 'error',
                            message: `Couldn't reset "${group.label}": ${describeConfigSaveError(reason).message}`,
                            // Keyed per-group — a different group's failure
                            // must not collapse into (or be collapsed by)
                            // this one's toast.
                            dedupeKey: `config-reset-section-${group.id}-failed`,
                          }),
                        );
                      });
                  }}
                >
                  {groupDescriptors.map((d) => {
                    if (d.isPrompt) return <PromptRow key={d.key} descriptor={d} />;
                    const value = values[d.key] ?? {
                      key: d.key,
                      effective: d.default,
                      source: 'default',
                      locked: false,
                      overridden: false,
                    };
                    return (
                      <OverrideRow
                        key={d.key}
                        descriptor={d}
                        value={{ ...value, staleReason: deriveStaleReason(d, value, gpuDevices) }}
                        onChange={(raw) => dispatch(saveOverride({ key: d.key, value: raw })).unwrap()}
                        // #2209 follow-up — Revert is a config save too
                        // (POST /api/config/reset), and is attributable to
                        // this exact row, so its rejection surfaces inline
                        // via OverrideRow the same way onChange's does.
                        onRevert={() => dispatch(resetKnob(d.key)).unwrap()}
                        gpuDevices={gpuDevices}
                      />
                    );
                  })}
                  {group.id === 'analyzer-models' && analyzerEngine === 'local' && (
                    <div className="py-3 border-b border-ink/8">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-sm font-medium text-ink flex-1">
                          Analyzer (Ollama) device
                        </span>
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-ink/8 text-ink/60 text-[11px] font-semibold">
                          read-only
                        </span>
                      </div>
                      <p className="text-xs text-ink/55 mb-1">
                        {analyzerDevice === 'cuda'
                          ? 'GPU'
                          : analyzerDevice === 'cpu'
                            ? 'CPU'
                            : analyzerDevice === 'idle'
                              ? 'Idle (no model currently loaded)'
                              : analyzerDevice === 'unreachable'
                                ? 'Unreachable'
                                : 'Checking…'}{' '}
                        — not app-pinnable; the analyzer connects to a user/OS-managed Ollama
                        daemon.
                      </p>
                      {gpuSplit && gpuSplit.dataUnavailable && (
                        <p className="text-xs text-slate-600 mb-1">
                          Can't determine GPU split status — your driver doesn't expose per-process GPU
                          memory. Run{' '}
                          <code className="text-slate-700 font-mono">nvidia-smi --query-compute-apps=used_memory --format=csv</code> to
                          check if <code className="text-slate-700 font-mono">used_memory</code> shows{' '}
                          <code className="text-slate-700 font-mono">[N/A]</code> or{' '}
                          <code className="text-slate-700 font-mono">[Not Supported]</code>.
                        </p>
                      )}
                      {gpuSplit &&
                        !gpuSplit.dataUnavailable &&
                        ((gpuSplit.split && gpuSplit.wouldFitSingleDevice) ||
                          expectedDeviceSplitMismatch ||
                          expectedDeviceWrongSingle) && (
                          <p className="text-xs text-amber-800 mb-1">
                            {expectedDeviceSplitMismatch ? (
                              <>
                                Model split across GPUs {gpuSplit.deviceIndices.join(', ')} —
                                expected GPU {expectedDevice} only. See{' '}
                                <a href="/docs/local-llm.md" className="underline">
                                  docs/local-llm.md
                                </a>
                                .
                              </>
                            ) : expectedDeviceWrongSingle ? (
                              <>
                                Analyzer model is on GPU {gpuSplit.deviceIndices[0]} —
                                expected GPU {expectedDevice} only. See{' '}
                                <a href="/docs/local-llm.md" className="underline">
                                  docs/local-llm.md
                                </a>
                                .
                              </>
                            ) : (
                              <>
                                Model split across GPUs {gpuSplit.deviceIndices.join(', ')} despite
                                fitting on one device — see{' '}
                                <a href="/docs/local-llm.md" className="underline">
                                  docs/local-llm.md
                                </a>
                                .
                              </>
                            )}
                          </p>
                        )}
                      <a
                        href="/docs/local-llm.md"
                        className="text-xs text-magenta hover:underline"
                      >
                        Change the analyzer&apos;s device (documented OS-env steps)
                      </a>
                    </div>
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
