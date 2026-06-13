/* fs-23 — In-app Model Manager. Consolidates every model install / inventory /
   residency control that used to be scattered across the Account view: a
   per-model inventory (present? · size · disk path · live residency) with
   Load/Unload actions, plus the model-flavored settings moved out of Account
   (defaults, analyzer split, TTS sidecar, server config). Reached only from the
   Admin view (#/models).

   The moved form sections land in step A7 (alongside the Account surgery). */

import { useCallback, useEffect, useState, type ComponentType } from 'react';
import { MixedHeading } from '../components/primitives';
import { DevicePanel } from '../components/device-panel';
import { useAppDispatch } from '../store';
import { uiActions } from '../store/ui-slice';
import {
  ModelControlPill,
  type ModelControlState,
  type ModelKind,
} from '../components/ModelControlPill';
import { api, type ModelInventoryItem, type ModelInventoryResponse } from '../lib/api';
import { formatBytes } from '../lib/bytes';
import { ModelSettingsForm, MODEL_SETTINGS_SECTIONS } from '../components/model-settings-form';
import { SettingsAccordion } from '../components/settings/settings-accordion';
import { CoquiInstall } from '../components/coqui-install';
import { KokoroInstall } from '../components/kokoro-install';
import { QwenInstall } from '../components/qwen-install';
import { WhisperInstall } from '../components/whisper-install';

const INVENTORY_POLL_MS = 30_000;

/* Inventory ids that map to a sidecar TTS engine the Load/Unload pill drives. */
const TTS_ENGINE_BY_ID: Partial<Record<string, 'coqui' | 'kokoro' | 'qwen'>> = {
  kokoro: 'kokoro',
  'qwen-base': 'qwen',
  coqui: 'coqui',
};

/* Inventory ids with an in-app installer, rendered inline under the row (fs-23
   follow-up — install lives with the model, not in a separate bottom section).
   As of fs-21 wave 1, kokoro has an in-app installer too — its ~330 MB weights
   are fetched at install time rather than bundled in the release zip.
   qwen-design is fetched at design time, and ollama models live in the analyzer
   section below — neither gets a row installer here. */
const INSTALLER_BY_ID: Partial<Record<string, ComponentType<{ onInstalled?: () => void }>>> = {
  kokoro: KokoroInstall,
  coqui: CoquiInstall,
  'qwen-base': QwenInstall,
  whisper: WhisperInstall,
};

export function ModelManagerView() {
  const dispatch = useAppDispatch();
  return (
    <div className="max-w-[1200px] mx-auto px-4 sm:px-6 py-10">
      <div className="mb-8">
        <button
          type="button"
          data-testid="model-manager-back-to-admin"
          onClick={() => dispatch(uiActions.openAdmin())}
          className="text-xs font-medium text-ink/60 hover:text-ink"
        >
          ← Admin
        </button>
        <div className="mt-4">
          <MixedHeading regular="Model" bold="Manager" level="h1" />
        </div>
        <p className="mt-3 text-ink/60 max-w-xl">
          Install, remove, and update your local models, see disk usage, and load or unload each
          into the GPU.
        </p>
      </div>

      {/* ONE side-nav rail over every section (mirrors Account / Advanced).
          The settings form is rendered embedded so it folds its own sections
          into this single rail instead of nesting a second nav. Scroll targets
          are id="cfg-section-<navId>" — Device/Installed wrap a div with the id;
          the form's SettingsSections already render their own. */}
      <SettingsAccordion
        sections={[
          { id: 'mm-device', label: 'Device', risk: 'low' },
          { id: 'mm-models', label: 'Installed models', risk: 'low' },
          ...MODEL_SETTINGS_SECTIONS,
        ]}
      >
        <div id="cfg-section-mm-device">
          <DevicePanel />
        </div>
        <div id="cfg-section-mm-models">
          <ModelInventory />
        </div>
        <ModelSettingsForm embedded />
      </SettingsAccordion>
    </div>
  );
}

function ModelInventory() {
  const [inv, setInv] = useState<ModelInventoryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmItem, setConfirmItem] = useState<ModelInventoryItem | null>(null);

  const refetch = useCallback(async () => {
    try {
      const next = await api.getModelInventory();
      setInv(next);
      setError(null);
    } catch (e) {
      /* Keep the last good board in place; just note the refresh failed. */
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refetch();
    const t = setInterval(() => void refetch(), INVENTORY_POLL_MS);
    return () => clearInterval(t);
  }, [refetch]);

  if (!inv) {
    return (
      <section className="rounded-2xl border border-ink/10 bg-white p-6 shadow-card">
        <p className="text-sm text-ink/60" data-testid="model-inventory-loading">
          {error ? `Couldn't load the model inventory: ${error}` : 'Loading model inventory…'}
        </p>
      </section>
    );
  }

  return (
    <section
      className="rounded-2xl border border-ink/10 bg-white p-5 sm:p-6 shadow-card"
      data-testid="model-inventory"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-ink">Installed models</h2>
        {!inv.sidecarReachable && (
          <span className="text-[11px] font-semibold text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-2.5 py-1">
            Voice engine unreachable — residency unknown
          </span>
        )}
      </div>
      <p className="mt-1 text-xs text-ink/55">
        Disk sizes are read directly from the model files. Load / Unload moves a model in and out of
        GPU memory.
      </p>
      {error && (
        <p className="mt-2 text-xs text-amber-700">
          Couldn't refresh just now — showing last known.
        </p>
      )}

      <ul className="mt-4 space-y-3">
        {inv.items.map((item) => (
          <ModelRow
            key={item.id}
            item={item}
            sidecarReachable={inv.sidecarReachable}
            busy={busyId === item.id}
            onAction={async (action) => {
              setBusyId(item.id);
              try {
                await action();
                await refetch();
              } finally {
                setBusyId(null);
              }
            }}
            onChanged={refetch}
            onRemove={() => setConfirmItem(item)}
          />
        ))}
      </ul>

      {confirmItem && (
        <ConfirmRemoveModal
          item={confirmItem}
          onClose={() => setConfirmItem(null)}
          onRemoved={async () => {
            setConfirmItem(null);
            await refetch();
          }}
        />
      )}
    </section>
  );
}

function ConfirmRemoveModal({
  item,
  onClose,
  onRemoved,
}: {
  item: ModelInventoryItem;
  onClose: () => void;
  onRemoved: () => Promise<void> | void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* The server enforces these guards with a 409; mirror them here so the user
     sees WHY before clicking, and disable Confirm rather than inviting a failed
     request. */
  const blockedReason = item.loaded
    ? 'It is loaded in GPU memory — unload it first.'
    : item.isFallbackEngine
      ? 'It is the universal fallback engine — removing it breaks audio fallback for every book.'
      : item.isDefaultEngine
        ? 'It is your current default engine — change the default first.'
        : null;

  const confirm = async () => {
    setBusy(true);
    setError(null);
    const result = await api.removeModel(item.id);
    setBusy(false);
    if (result.ok) {
      await onRemoved();
    } else {
      setError([result.error, result.remediation].filter(Boolean).join(' '));
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4"
      role="dialog"
      aria-modal="true"
      data-testid="model-remove-confirm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-ink/10 bg-white p-6 shadow-card"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-base font-semibold text-ink">Remove {item.label}?</h3>
        <p className="mt-2 text-sm text-ink/70">
          This deletes the model weights from disk
          {item.sizeBytes != null ? ` (frees ~${formatBytes(item.sizeBytes)})` : ''}. You can
          reinstall it later.
        </p>
        {blockedReason && (
          <p className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            {blockedReason}
          </p>
        )}
        {error && (
          <p className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
            {error}
          </p>
        )}
        <div className="mt-5 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="min-h-[44px] sm:min-h-0 px-4 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink/70 hover:bg-ink/5"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={confirm}
            disabled={busy || blockedReason !== null}
            data-testid="model-remove-confirm-button"
            className="min-h-[44px] sm:min-h-0 px-4 py-2 rounded-xl bg-rose-600 text-white text-sm font-medium hover:bg-rose-700 disabled:opacity-50 disabled:hover:bg-rose-600"
          >
            {busy ? 'Removing…' : 'Remove'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ResidencyBadge({ item }: { item: ModelInventoryItem }) {
  if (!item.present) {
    return (
      <span className="text-[11px] font-semibold text-ink/45 bg-ink/4 border border-ink/10 rounded-full px-2.5 py-1">
        Not installed
      </span>
    );
  }
  if (item.loaded) {
    return (
      <span className="text-[11px] font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-2.5 py-1">
        Loaded
      </span>
    );
  }
  return (
    <span className="text-[11px] font-semibold text-ink/60 bg-white border border-ink/15 rounded-full px-2.5 py-1">
      Installed
    </span>
  );
}

function ModelRow({
  item,
  sidecarReachable,
  busy,
  onAction,
  onChanged,
  onRemove,
}: {
  item: ModelInventoryItem;
  sidecarReachable: boolean;
  busy: boolean;
  onAction: (action: () => Promise<unknown>) => Promise<void>;
  onChanged: () => void;
  onRemove: () => void;
}) {
  const [installerOpen, setInstallerOpen] = useState(false);
  const Installer = INSTALLER_BY_ID[item.id];
  const engine = TTS_ENGINE_BY_ID[item.id];
  const isAnalyzer = item.kind === 'analyzer';
  /* A Load/Unload pill is meaningful for the sidecar TTS engines and for every
     installed Ollama analyzer model (all analyzer rows are Ollama; cloud Gemini
     is not a disk artifact and never appears in the inventory). */
  const hasControl = item.present && (engine !== undefined || isAnalyzer);

  /* Analyzer residency depends on the Ollama daemon, not the voice engine
     (sidecar) — an unreachable daemon already yields zero analyzer rows, so
     analyzer rows are never 'unreachable' here. Only TTS rows gate on sidecar
     reachability. */
  const reachable = isAnalyzer ? true : sidecarReachable;
  const controlState: ModelControlState = !reachable
    ? 'unreachable'
    : busy
      ? 'loading'
      : item.loaded
        ? 'ready'
        : 'idle';
  const controlKind: ModelKind = isAnalyzer ? 'analyzer' : 'tts';

  /* Ollama tags contain colons (ollama:qwen3.5:4b) — slice the prefix, never
     split(':'). Mirrors performRemoval in models-inventory.ts. */
  const analyzerModel = isAnalyzer ? item.id.slice('ollama:'.length) : undefined;
  const doLoad = () =>
    onAction(() =>
      engine
        ? api.loadSidecar({ engine })
        : api.loadAnalyzer(analyzerModel ? { model: analyzerModel } : undefined),
    );
  const doStop = () =>
    onAction(() =>
      engine
        ? api.unloadSidecar({ engine })
        : api.unloadAnalyzer(analyzerModel ? { model: analyzerModel } : undefined),
    );

  return (
    <li
      data-testid={`model-row-${item.id}`}
      data-present={item.present}
      data-loaded={item.loaded}
      className="rounded-xl border border-ink/10 bg-ink/2 p-3 flex flex-col gap-3"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-ink">{item.label}</span>
            {item.isDefaultEngine && (
              <span className="text-[10px] font-semibold uppercase tracking-wide text-magenta bg-magenta/10 rounded-full px-2 py-0.5">
                Default
              </span>
            )}
            {item.isFallbackEngine && (
              <span className="text-[10px] font-semibold uppercase tracking-wide text-ink/55 bg-ink/5 rounded-full px-2 py-0.5">
                Fallback
              </span>
            )}
            {item.integrity === 'verified' && (
              <span
                className="text-[10px] font-semibold text-emerald-700"
                title="On-disk size matches the pinned release (full SHA256 is verified at install time)"
              >
                ✓ verified
              </span>
            )}
            {item.integrity === 'mismatch' && (
              <span
                className="text-[10px] font-semibold text-rose-700"
                title="On-disk size differs from the pinned release — reinstall to restore integrity"
              >
                ⚠ size mismatch
              </span>
            )}
          </div>
          <div className="mt-1 text-xs text-ink/55">
            {item.present ? formatBytes(item.sizeBytes) : 'not installed'}
            {item.diskPath && (
              <>
                {' · '}
                <span className="font-mono break-all text-ink/45">{item.diskPath}</span>
              </>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0 flex-wrap">
          <ResidencyBadge item={item} />
          {hasControl && (
            <ModelControlPill
              kind={controlKind}
              state={controlState}
              engineLabel={item.label}
              onLoad={doLoad}
              onStop={doStop}
            />
          )}
          {Installer && (
            <button
              type="button"
              onClick={() => setInstallerOpen((o) => !o)}
              data-testid={`model-install-toggle-${item.id}`}
              aria-expanded={installerOpen}
              className="min-h-[44px] sm:min-h-0 px-3 py-1 rounded-full border border-ink/15 bg-white text-[11px] font-semibold text-ink/70 hover:bg-ink/5"
            >
              {item.present ? 'Update' : 'Install'} {installerOpen ? '▴' : '▾'}
            </button>
          )}
          {item.present && item.removable && (
            <button
              type="button"
              onClick={onRemove}
              data-testid={`model-remove-${item.id}`}
              className="min-h-[44px] sm:min-h-0 px-3 py-1 rounded-full border border-rose-200 bg-white text-[11px] font-semibold text-rose-700 hover:bg-rose-50"
            >
              Remove
            </button>
          )}
        </div>
      </div>

      {Installer && installerOpen && (
        <div data-testid={`model-installer-${item.id}`} className="border-t border-ink/10 pt-3">
          <Installer onInstalled={onChanged} />
        </div>
      )}
    </li>
  );
}
