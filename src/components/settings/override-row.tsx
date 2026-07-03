/* Presentational row component for a single server/sidecar config knob in
   the Advanced Settings UI. Pure props-and-callbacks — no slice access.
   The parent view wires this to the knob registry + change dispatch. */

import { useState } from 'react';
import { Checkbox } from '../primitives';
import type { GpuDevice, KnobDescriptor, KnobValue, StaleReason } from '../../lib/types';

// Peak VRAM footprint per device-typed engine (MB) — first-cut estimates per
// the design spec's §2.2 text, not measured; a false-positive warning here is
// low-cost (it's advisory, doesn't block the change) so precision isn't critical.
const ENGINE_PEAK_MB: Record<string, number> = {
  'tts.qwen.device': 6500,
  'tts.coqui.device': 3000,
  'tts.kokoro.device': 1000,
};

/* ── apply-mode pill label ───────────────────────────────────────────────── */

function applyLabel(apply: KnobDescriptor['apply']): string {
  switch (apply) {
    case 'live':
      return 'live';
    case 'restart-sidecar':
      return 'restart';
    case 'restart-server':
      return 'restart · app';
    case 'rebuild':
      return 'rebuilds env';
  }
}

/* Colour the apply pill: live = emerald, restart variants = amber, rebuild =
   rose (heaviest — it reinstalls the Python environment, not just a restart). */
function applyPillClasses(apply: KnobDescriptor['apply']): string {
  if (apply === 'live') {
    return 'bg-emerald-100 text-emerald-800';
  }
  if (apply === 'rebuild') {
    return 'bg-rose-100 text-rose-800';
  }
  return 'bg-amber-100 text-amber-800';
}

/* Text label for a device-knob stale_reason — carries the meaning itself so
   the badge isn't distinguished by colour alone (a11y §2.2). */
function staleReasonLabel(reason: StaleReason): string {
  switch (reason) {
    case 'cpu_fallback':
      return 'fell back to CPU';
    case 'uuid_unresolved':
      return 'card no longer found';
  }
}

/* ── editable input controls ─────────────────────────────────────────────── */

interface ControlProps {
  descriptor: KnobDescriptor;
  value: KnobValue;
  onChange: (raw: number | boolean | string) => void;
  disabled: boolean;
  gpuDevices?: GpuDevice[];
}

function KnobControl({ descriptor, value, onChange, disabled, gpuDevices }: ControlProps) {
  const [footprintWarning, setFootprintWarning] = useState<string | null>(null);

  const base =
    'px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink ' +
    'focus:outline-hidden focus:ring-2 focus:ring-magenta/30 ' +
    'disabled:bg-ink/3 disabled:text-ink/50 disabled:cursor-not-allowed ' +
    'min-h-[44px] sm:min-h-0';

  if (descriptor.type === 'boolean') {
    return (
      <Checkbox
        checked={Boolean(value.effective)}
        disabled={disabled}
        onChange={onChange}
        label={value.effective ? 'Enabled' : 'Disabled'}
      />
    );
  }

  if (descriptor.type === 'enum') {
    return (
      <select
        aria-label={descriptor.label}
        value={String(value.effective)}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className={`w-full ${base}`}
      >
        {(descriptor.options ?? []).map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    );
  }

  if (descriptor.type === 'device') {
    const current = String(value.effective);
    // idx:-1 is the synthetic "unindexed (cpu / ORT / CT2)" entry the server
    // appends so a cpu_fallback badge has somewhere to attach (gpu-devices.ts)
    // — it's not a real, pinnable card and must never become a `cuda:-1` option.
    const cudaOptions = (gpuDevices ?? []).filter((d) => d.idx >= 0).map((d) => `cuda:${d.idx}`);
    // 'mps' (Apple Silicon) isn't enumerable via GET /api/gpu/devices (CUDA-only
    // probe), but the sidecar's device grammar accepts it for all three knobs —
    // keep it a static, always-offered option rather than dropping it.
    const options = ['auto', 'cpu', 'mps', ...cudaOptions];
    // A stale/manually-set value (e.g. a card that vanished) stays selectable
    // rather than silently jumping to whatever option happens to be first.
    if (!options.includes(current)) options.push(current);

    return (
      <div>
        <select
          aria-label={descriptor.label}
          value={current}
          disabled={disabled}
          onChange={(e) => {
            const selected = e.target.value;
            const device = (gpuDevices ?? []).find((d) => `cuda:${d.idx}` === selected);
            const peak = ENGINE_PEAK_MB[descriptor.key];
            if (device && peak && device.free_mb < peak) {
              setFootprintWarning(
                `${device.name} may not have enough free VRAM (${device.free_mb} MB free, ~${peak} MB typically needed).`,
              );
            } else {
              setFootprintWarning(null);
            }
            onChange(selected);
          }}
          className={`w-full ${base}`}
        >
          {options.map((opt) => {
            const device = (gpuDevices ?? []).find((d) => `cuda:${d.idx}` === opt);
            const label = device ? `${opt} — ${device.name} (${device.free_mb} MB free)` : opt;
            return (
              <option key={opt} value={opt}>
                {label}
              </option>
            );
          })}
        </select>
        {footprintWarning && (
          <p className="text-xs text-amber-700 mt-1" role="status">{footprintWarning}</p>
        )}
      </div>
    );
  }

  if (descriptor.type === 'number' || descriptor.type === 'integer') {
    const isInteger = descriptor.type === 'integer';
    return (
      <input
        type="number"
        aria-label={descriptor.label}
        value={Number(value.effective)}
        min={descriptor.min}
        max={descriptor.max}
        step={descriptor.step ?? (isInteger ? 1 : undefined)}
        disabled={disabled}
        onChange={(e) => {
          const raw = e.target.value;
          const parsed = isInteger ? parseInt(raw, 10) : parseFloat(raw);
          if (Number.isFinite(parsed)) onChange(parsed);
        }}
        className={`w-32 ${base}`}
      />
    );
  }

  /* string */
  return (
    <input
      type="text"
      aria-label={descriptor.label}
      value={String(value.effective)}
      disabled={disabled}
      onBlur={(e) => onChange(e.target.value)}
      onChange={
        /* immediate feedback for text so the input doesn't feel sticky */
        (e) => onChange(e.target.value)
      }
      className={`w-full ${base}`}
    />
  );
}

/* ── OverrideRow ─────────────────────────────────────────────────────────── */

export interface OverrideRowProps {
  descriptor: KnobDescriptor;
  value: KnobValue;
  onChange: (raw: number | boolean | string) => void;
  onRevert: () => void;
  /** GPU cards detected via GET /api/gpu/devices — only consumed by type: 'device' knobs. */
  gpuDevices?: GpuDevice[];
}

export function OverrideRow({ descriptor, value, onChange, onRevert, gpuDevices }: OverrideRowProps) {
  const locked = value.locked;

  return (
    <div className="py-3 border-b border-ink/8 last:border-b-0">
      {/* Header row: label + apply pill (+ env pill when locked) */}
      <div className="flex items-start gap-2 flex-wrap mb-1">
        <span className="text-sm font-medium text-ink flex-1">{descriptor.label}</span>

        <div className="flex items-center gap-1.5 shrink-0 flex-wrap">
          {locked ? (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-ink/8 text-ink/60 text-[11px] font-semibold">
              .env
            </span>
          ) : (
            <span
              className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold ${applyPillClasses(descriptor.apply)}`}
            >
              {applyLabel(descriptor.apply)}
            </span>
          )}
          {value.staleReason && (
            <span
              data-testid="stale-reason-badge"
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-100 text-amber-900 text-[11px] font-semibold"
            >
              {staleReasonLabel(value.staleReason)}
            </span>
          )}
        </div>
      </div>

      {/* Help text */}
      <p className="text-xs text-ink/55 mb-2">{descriptor.help}</p>

      {/* Control row */}
      <div className="flex items-center gap-3 flex-wrap">
        <KnobControl
          descriptor={descriptor}
          value={value}
          onChange={onChange}
          disabled={locked}
          gpuDevices={gpuDevices}
        />

        {/* Env-locked indicator */}
        {locked && (
          <span className="text-xs text-ink/55 flex items-center gap-1">
            <span>🔒</span>
            <span>set in .env</span>
          </span>
        )}

        {/* Revert button + default value — only when overridden and not locked */}
        {!locked && value.overridden && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-ink/50">
              default: <span className="font-mono">{String(descriptor.default)}</span>
            </span>
            <button
              type="button"
              onClick={onRevert}
              className="px-2.5 py-1 rounded-lg border border-ink/15 bg-white text-xs text-ink/70 hover:bg-ink/4 min-h-[44px] sm:min-h-0"
            >
              Revert
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
