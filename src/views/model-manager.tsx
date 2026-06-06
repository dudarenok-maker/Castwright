/* fs-23 — In-app Model Manager. Consolidates every model install / inventory /
   residency control that used to be scattered across the Account view: a
   per-model inventory (present? · size · disk path · live residency) with
   Load/Unload actions, plus the model-flavored settings moved out of Account
   (defaults, analyzer split, TTS sidecar, server config). Reached only from the
   Admin view (#/models).

   The moved form sections land in step A7 (alongside the Account surgery). */

import { useCallback, useEffect, useRef, useState } from 'react';
import { SectionLabel, MixedHeading } from '../components/primitives';
import {
  ModelControlPill,
  type ModelControlState,
  type ModelKind,
} from '../components/ModelControlPill';
import { api, type ModelInventoryItem, type ModelInventoryResponse } from '../lib/api';
import { formatBytes } from '../lib/bytes';

const INVENTORY_POLL_MS = 30_000;

/* Inventory ids that map to a sidecar TTS engine the Load/Unload pill drives. */
const TTS_ENGINE_BY_ID: Partial<Record<string, 'coqui' | 'kokoro' | 'qwen'>> = {
  kokoro: 'kokoro',
  'qwen-base': 'qwen',
  coqui: 'coqui',
};

export function ModelManagerView() {
  return (
    <div className="max-w-[960px] mx-auto px-4 sm:px-6 py-10">
      <div className="mb-8">
        <SectionLabel>Admin</SectionLabel>
        <div className="mt-4">
          <MixedHeading regular="Model" bold="Manager" level="h1" />
        </div>
        <p className="mt-3 text-ink/60 max-w-xl">
          Install, remove, and update your local models, see disk usage, and load or unload each into
          the GPU.
        </p>
      </div>

      <div className="space-y-6">
        <ModelInventory />
      </div>
    </div>
  );
}

function ModelInventory() {
  const [inv, setInv] = useState<ModelInventoryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

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
            Sidecar unreachable — residency unknown
          </span>
        )}
      </div>
      <p className="mt-1 text-xs text-ink/55">
        Disk sizes are read directly from the model files. Load / Unload moves a model in and out of
        GPU memory.
      </p>
      {error && (
        <p className="mt-2 text-xs text-amber-700">Couldn't refresh just now — showing last known.</p>
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
          />
        ))}
      </ul>
    </section>
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
}: {
  item: ModelInventoryItem;
  sidecarReachable: boolean;
  busy: boolean;
  onAction: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const engine = TTS_ENGINE_BY_ID[item.id];
  const isAnalyzerDefault = item.kind === 'analyzer' && item.isDefaultEngine;
  /* A Load/Unload pill is meaningful only for the sidecar TTS engines and the
     default analyzer model (Ollama). Qwen VoiceDesign / Whisper load
     transiently or lazily, and non-default Ollama models aren't load targets. */
  const hasControl = item.present && (engine !== undefined || isAnalyzerDefault);

  const controlState: ModelControlState = !sidecarReachable
    ? 'unreachable'
    : busy
      ? 'loading'
      : item.loaded
        ? 'ready'
        : 'idle';
  const controlKind: ModelKind = item.kind === 'analyzer' ? 'analyzer' : 'tts';

  const doLoad = () =>
    onAction(() => (engine ? api.loadSidecar({ engine }) : api.loadAnalyzer()));
  const doStop = () =>
    onAction(() => (engine ? api.unloadSidecar({ engine }) : api.unloadAnalyzer()));

  return (
    <li
      data-testid={`model-row-${item.id}`}
      data-present={item.present}
      data-loaded={item.loaded}
      className="rounded-xl border border-ink/10 bg-ink/2 p-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
    >
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
            <span className="text-[10px] font-semibold text-emerald-700" title="Checksum verified">
              ✓ verified
            </span>
          )}
          {item.integrity === 'mismatch' && (
            <span className="text-[10px] font-semibold text-rose-700" title="Checksum mismatch">
              ⚠ checksum mismatch
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

      <div className="flex items-center gap-2 shrink-0">
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
      </div>
    </li>
  );
}
