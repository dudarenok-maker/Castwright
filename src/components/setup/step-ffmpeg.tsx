/* fs-21 wave 2 — Step 2: ffmpeg.
   Hard-blocker step. ffmpeg is an OS-level dependency — no in-app installer.
   Shows a green "found" card on pass; shows per-OS install instructions + a
   Re-check button on fail (mirrors the venv-bootstrap decision-Z pattern). */

import type { SetupReadiness } from '../../lib/api';

interface Props {
  readiness: SetupReadiness;
  onRefetch: () => void;
}

export function StepFfmpeg({ readiness, onRefetch }: Props) {
  const passed = readiness.blockers.ffmpeg === 'pass';

  if (passed) {
    return (
      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-ink">ffmpeg</h2>
        <div
          data-testid="step-ffmpeg-ready"
          className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4"
        >
          <div className="flex items-center gap-3">
            <span className="w-2 h-2 rounded-full bg-emerald-600 shrink-0" />
            <div className="flex-1">
              <p className="text-sm font-semibold text-emerald-900">ffmpeg found</p>
              <p className="text-xs text-emerald-900/70">
                Audio assembly is ready — ffmpeg is available on this machine.
              </p>
            </div>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold text-ink">ffmpeg</h2>
      <div
        data-testid="step-ffmpeg-missing"
        className="rounded-2xl border border-amber-200 bg-amber-50 p-4 space-y-4"
      >
        <div>
          <p className="text-sm font-semibold text-amber-900">ffmpeg not found</p>
          <p className="mt-1 text-xs text-amber-900/70">
            Castwright uses ffmpeg to assemble and normalise audio. Install it with your
            OS package manager, then click Re-check.
          </p>
        </div>

        <div className="space-y-3">
          <div className="space-y-1">
            <p className="text-xs font-semibold text-ink/60 uppercase tracking-wide">Windows</p>
            <pre className="text-xs bg-ink/5 text-ink rounded-lg p-3 overflow-x-auto leading-relaxed">
              {'winget install ffmpeg'}
            </pre>
          </div>

          <div className="space-y-1">
            <p className="text-xs font-semibold text-ink/60 uppercase tracking-wide">macOS</p>
            <pre className="text-xs bg-ink/5 text-ink rounded-lg p-3 overflow-x-auto leading-relaxed">
              {'brew install ffmpeg'}
            </pre>
          </div>

          <div className="space-y-1">
            <p className="text-xs font-semibold text-ink/60 uppercase tracking-wide">Linux</p>
            <pre className="text-xs bg-ink/5 text-ink rounded-lg p-3 overflow-x-auto leading-relaxed">
              {'sudo apt install ffmpeg'}
            </pre>
          </div>
        </div>

        <button
          type="button"
          onClick={onRefetch}
          className="px-3 py-1.5 rounded-full border border-amber-300 bg-white text-xs text-amber-900 hover:bg-amber-100"
        >
          Re-check
        </button>
      </div>
    </section>
  );
}
