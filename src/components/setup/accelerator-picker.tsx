/* fs-21 + AMD phase 2 — first-run accelerator profile picker. Lets the user pin
   the GPU stack (or keep Auto-detect) during setup; persists to the
   tts.accelerator config override, which the venv bootstrap reads to install the
   matching torch/ONNX-runtime overlay. 'auto' clears to hardware detection. */

import { useState } from 'react';
import { api } from '../../lib/api';

const OPTIONS: { value: string; label: string }[] = [
  { value: 'auto', label: 'Auto-detect (recommended)' },
  { value: 'nvidia', label: 'NVIDIA (CUDA)' },
  { value: 'amd', label: 'AMD (ROCm / DirectML) — experimental' },
  { value: 'cpu', label: 'CPU only' },
];

export function AcceleratorPicker() {
  const [value, setValue] = useState('auto');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSelect(next: string) {
    setValue(next);
    setSaving(true);
    setError(null);
    try {
      await api.putConfig({ 'tts.accelerator': next });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the accelerator choice.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="rounded-2xl border border-ink/10 bg-canvas px-4 py-3"
      data-testid="accelerator-picker"
    >
      <label htmlFor="accelerator-select" className="text-sm font-medium text-ink">
        GPU accelerator
      </label>
      <p className="mt-0.5 text-xs text-ink/60">
        How the voice engines run. Auto-detect fits most machines. Pinning a profile rebuilds the
        Python environment on the next install — your books and voices are kept. AMD is an
        experimental preview.
      </p>
      <select
        id="accelerator-select"
        value={value}
        onChange={(e) => void onSelect(e.target.value)}
        disabled={saving}
        className="mt-2 w-full rounded-lg border border-ink/20 bg-white px-3 py-2 text-sm text-ink min-h-[44px] sm:min-h-0"
      >
        {OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}
