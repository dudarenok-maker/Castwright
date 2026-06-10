/* fs-43 — "Will it run on my machine?" panel. Server-sourced host detection
   (the server runs the models; a paired browser may be a LAN phone, so
   client-side detection would describe the wrong machine). Shows the detected
   host + the honest per-platform hardware line. The precise active torch device
   — incl. mps ground-truth — is the side-14 follow-up. */

import { useAppInfo } from '../lib/use-app-info';
import { HARDWARE_LINE } from '../lib/brand';

export function DevicePanel() {
  const { info } = useAppInfo();
  const hw = info?.hardware;

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

      {hw?.appleSilicon && (
        <p className="mt-2 text-xs text-ink/60">
          Castwright uses your Mac&rsquo;s Metal GPU automatically — no setup, no drivers.
        </p>
      )}
      {hw && !hw.appleSilicon && hw.platform === 'darwin' && (
        <p className="mt-2 text-xs text-ink/60">
          Intel Macs run on the CPU — slower than an 8&nbsp;GB GPU or Apple Silicon, but it works.
        </p>
      )}
      {hw && (hw.platform === 'win32' || hw.platform === 'linux') && (
        <p className="mt-2 text-xs text-ink/60">
          With an 8&nbsp;GB NVIDIA GPU you get near-realtime rendering; without one, Castwright
          falls back to the CPU (slower). Load a voice to confirm which device is in use.
        </p>
      )}
    </section>
  );
}
