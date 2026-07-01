/* Presentational row component for a single server/sidecar config knob in
   the Advanced Settings UI. Pure props-and-callbacks — no slice access.
   The parent view wires this to the knob registry + change dispatch. */

import type { GpuDevice, KnobDescriptor, KnobValue } from '../../lib/types';

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

/* ── editable input controls ─────────────────────────────────────────────── */

interface ControlProps {
  descriptor: KnobDescriptor;
  value: KnobValue;
  onChange: (raw: number | boolean | string) => void;
  disabled: boolean;
  gpuDevices?: GpuDevice[];
}

function KnobControl({ descriptor, value, onChange, disabled, gpuDevices }: ControlProps) {
  const base =
    'px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink ' +
    'focus:outline-hidden focus:ring-2 focus:ring-magenta/30 ' +
    'disabled:bg-ink/3 disabled:text-ink/50 disabled:cursor-not-allowed ' +
    'min-h-[44px] sm:min-h-0';

  if (descriptor.type === 'boolean') {
    return (
      <label className="inline-flex items-center gap-3 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={Boolean(value.effective)}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          className="h-4 w-4 rounded border-ink/30 text-magenta focus:ring-2 focus:ring-magenta/30 disabled:cursor-not-allowed"
        />
        <span className="text-sm text-ink">{value.effective ? 'Enabled' : 'Disabled'}</span>
      </label>
    );
  }

  if (descriptor.type === 'enum') {
    return (
      <select
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
    const cudaOptions = (gpuDevices ?? []).map((d) => `cuda:${d.idx}`);
    // 'mps' (Apple Silicon) isn't enumerable via GET /api/gpu/devices (CUDA-only
    // probe), but the sidecar's device grammar accepts it for all three knobs —
    // keep it a static, always-offered option rather than dropping it.
    const options = ['auto', 'cpu', 'mps', ...cudaOptions];
    // A stale/manually-set value (e.g. a card that vanished) stays selectable
    // rather than silently jumping to whatever option happens to be first.
    if (!options.includes(current)) options.push(current);

    return (
      <select
        value={current}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
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
    );
  }

  if (descriptor.type === 'number' || descriptor.type === 'integer') {
    const isInteger = descriptor.type === 'integer';
    return (
      <input
        type="number"
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
