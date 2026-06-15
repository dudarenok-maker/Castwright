/* fs-43 — "Will it run on my machine?" panel. Server-sourced host detection
   (the server runs the models; a paired browser may be a LAN phone, so
   client-side detection would describe the wrong machine). side-14 adds the
   ground truth: per-engine resolved devices from the sidecar's startup probe,
   headlined by the engine the server resolves as the active default. Falls
   back to the capability copy whenever ground truth isn't available (older
   server/sidecar, probe pending, sidecar down). */

import { useAppInfo } from '../lib/use-app-info';
import { HARDWARE_LINE } from '../lib/brand';

type DeviceFamily = 'cuda' | 'rocm' | 'directml' | 'mps' | 'cpu';

const DEVICE_LABEL: Record<DeviceFamily, string> = {
  cuda: 'NVIDIA GPU (CUDA)',
  rocm: 'AMD GPU (ROCm)',
  directml: 'AMD GPU (DirectML)',
  mps: 'Apple GPU (Metal)',
  cpu: 'CPU',
};

/* AMD acceleration (rocm/directml) is a preview path (phase 2) — flag it so
   users understand it's newer/less battle-tested than the NVIDIA/Apple paths. */
const AMD_FAMILIES: ReadonlySet<DeviceFamily> = new Set(['rocm', 'directml']);

/* Brand engine names — keep in lockstep with the engine credits used across
   the app (Kokoro / Coqui XTTS / Qwen3-TTS). */
const ENGINE_LABEL = { kokoro: 'Kokoro', coqui: 'Coqui XTTS', qwen: 'Qwen3-TTS' } as const;
const ENGINE_ORDER = ['kokoro', 'qwen', 'coqui'] as const;

export function DevicePanel() {
  const { info } = useAppInfo();
  const hw = info?.hardware;
  const devices = info?.devicesState === 'ready' ? (info?.devices ?? null) : null;
  const activeEngine = info?.activeEngine;
  const headlineDevice =
    devices && activeEngine && activeEngine in devices
      ? devices[activeEngine as keyof typeof devices]
      : null;

  return (
    <section
      data-testid="device-panel"
      className="rounded-2xl border border-ink/10 bg-white p-6 shadow-card"
    >
      <h2 className="text-base font-semibold text-ink">Will it run on my machine?</h2>
      <p className="mt-1 text-sm text-ink/70">{HARDWARE_LINE}</p>

      {hw ? (
        <p className="mt-4 text-sm">
          <span className="text-ink/55">Detected:</span>{' '}
          <span className="font-medium text-ink">{hw.label}</span>
        </p>
      ) : (
        <p className="mt-4 text-sm text-ink/50">Detecting your hardware…</p>
      )}

      {headlineDevice && (
        <p className="mt-2 text-sm">
          <span className="text-ink/55">Currently running on:</span>{' '}
          <span className="font-medium text-ink">{DEVICE_LABEL[headlineDevice]}</span>
        </p>
      )}

      {devices && (
        <ul className="mt-2 space-y-0.5 text-xs text-ink/60">
          {ENGINE_ORDER.filter((e) => devices[e] !== null).map((e) => (
            <li key={e}>
              <span className="font-medium text-ink/80">{ENGINE_LABEL[e]}</span>
              {' · '}
              {DEVICE_LABEL[devices[e] as DeviceFamily]}
            </li>
          ))}
        </ul>
      )}

      {devices &&
        ENGINE_ORDER.some((e) => AMD_FAMILIES.has(devices[e] as DeviceFamily)) && (
          <p className="mt-2 text-xs text-ink/50" data-testid="amd-experimental-note">
            AMD GPU acceleration is experimental (preview) — if you hit issues, set the
            accelerator to CPU in Advanced settings.
          </p>
        )}

      {!devices && hw?.appleSilicon && (
        <p className="mt-2 text-xs text-ink/60">
          Castwright uses your Mac&rsquo;s Metal GPU automatically — no setup, no drivers.
        </p>
      )}
      {!devices && hw && !hw.appleSilicon && hw.platform === 'darwin' && (
        <p className="mt-2 text-xs text-ink/60">
          Intel Macs run on the CPU — slower than an 8&nbsp;GB GPU or Apple Silicon, but it works.
        </p>
      )}
      {!devices && hw && (hw.platform === 'win32' || hw.platform === 'linux') && (
        <p className="mt-2 text-xs text-ink/60">
          With an 8&nbsp;GB NVIDIA GPU you get near-realtime rendering; without one, Castwright
          falls back to the CPU (slower). Load a voice to confirm which device is in use.
        </p>
      )}
    </section>
  );
}
