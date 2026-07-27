/* fs-21 wave 2 — Step 2: ffmpeg.
   Hard-blocker step. ffmpeg is an OS-level dependency — no in-app installer.
   Shows a green "found" card on pass; shows per-OS install instructions + a
   Re-check button on fail (mirrors the venv-bootstrap decision-Z pattern). */

import type { SetupReadiness } from '../../lib/api';
import { wikiUrl, WIZARD_STEP_WIKI } from '../../lib/wiki-links';

interface Props {
  readiness: SetupReadiness;
  onRefetch: () => void;
}

export function StepFfmpeg({ readiness, onRefetch }: Props) {
  const diagnosis = readiness.blockers.ffmpeg;
  const passed = diagnosis.status === 'pass';
  /* ops-35 (#1877): present, but older than the declared support floor. This
     used to fall through to the "isn't installed yet" branch, which told a
     user who HAS ffmpeg to install it. */
  const outdated = diagnosis.cause === 'ffmpeg-too-old';

  if (passed) {
    return (
      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-ink">Audio assembly</h2>
        <p className="text-sm text-ink/60">
          The final step of every audiobook stitches your generated voice clips into a
          single, properly-levelled audio file. Castwright does this with a free tool
          called <span className="font-medium text-ink">ffmpeg</span>.
        </p>
        <div
          data-testid="step-ffmpeg-ready"
          className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4"
        >
          <div className="flex items-center gap-3">
            <span className="w-2 h-2 rounded-full bg-emerald-600 shrink-0" />
            <div className="flex-1">
              <p className="text-sm font-semibold text-emerald-900">Audio assembly ready</p>
              <p className="text-xs text-emerald-900/70">
                ffmpeg is installed on this machine — Castwright can assemble finished
                audiobooks.
              </p>
            </div>
          </div>
        </div>
      </section>
    );
  }

  /* Installed, but below the support floor. A support floor means "we haven't
     tested this", not "this is broken" — so this card informs, links out, and
     never blocks: the wizard stays advanceable because setup-readiness.ts
     counts 'warn' toward `ready`. */
  if (outdated) {
    return (
      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-ink">Audio assembly</h2>
        <p className="text-sm text-ink/60">
          The final step of every audiobook stitches your generated voice clips into a
          single, properly-levelled audio file. Castwright does this with a free tool
          called <span className="font-medium text-ink">ffmpeg</span>.
        </p>
        <div
          data-testid="step-ffmpeg-outdated"
          className="rounded-2xl border border-amber-200 bg-amber-50 p-4 space-y-4"
        >
          <div>
            <p className="text-sm font-semibold text-amber-900">{diagnosis.message}</p>
            <p className="mt-1 text-xs text-amber-900/70">
              Castwright can still assemble audiobooks with this version — it just
              isn’t one we test against, and chapter loudness may differ. Upgrading
              is recommended.
            </p>
          </div>

          <div className="space-y-3">
            <div className="space-y-1">
              <p className="text-xs font-semibold text-ink/60 uppercase tracking-wide">Windows</p>
              <pre className="text-xs bg-ink/5 text-ink rounded-lg p-3 overflow-x-auto leading-relaxed">
                {'winget upgrade Gyan.FFmpeg'}
              </pre>
            </div>

            <div className="space-y-1">
              <p className="text-xs font-semibold text-ink/60 uppercase tracking-wide">macOS</p>
              <pre className="text-xs bg-ink/5 text-ink rounded-lg p-3 overflow-x-auto leading-relaxed">
                {'brew upgrade ffmpeg'}
              </pre>
            </div>

            <div className="space-y-1">
              <p className="text-xs font-semibold text-ink/60 uppercase tracking-wide">Linux</p>
              <pre className="text-xs bg-ink/5 text-ink rounded-lg p-3 overflow-x-auto leading-relaxed">
                {'sudo snap install ffmpeg'}
              </pre>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={onRefetch}
              className="px-3 py-1.5 rounded-full border border-amber-300 bg-white text-xs text-amber-900 hover:bg-amber-100 min-h-[44px] fine-pointer:min-h-0"
            >
              Re-check
            </button>
            <a
              href={wikiUrl(WIZARD_STEP_WIKI.ffmpeg)}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-amber-900 underline underline-offset-2"
            >
              Prerequisites — supported versions
            </a>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold text-ink">Audio assembly</h2>
      <p className="text-sm text-ink/60">
        The final step of every audiobook stitches your generated voice clips into a
        single, properly-levelled audio file. Castwright does this with a free tool
        called <span className="font-medium text-ink">ffmpeg</span>.
      </p>
      <div
        data-testid="step-ffmpeg-missing"
        className="rounded-2xl border border-amber-200 bg-amber-50 p-4 space-y-4"
      >
        <div>
          <p className="text-sm font-semibold text-amber-900">ffmpeg isn’t installed yet</p>
          <p className="mt-1 text-xs text-amber-900/70">
            Without it, Castwright can generate voices but can’t assemble them into a
            finished audiobook. Install it with your OS package manager, then click
            Re-check.
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
