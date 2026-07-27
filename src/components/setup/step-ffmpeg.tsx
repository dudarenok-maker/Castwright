/* fs-21 wave 2 — Step 2: ffmpeg. ffmpeg is an OS-level dependency — no in-app
   installer. Three render states, keyed off `status` (NOT off `cause`, so a
   future warn cause can't fall through to the missing card):
     pass  — green "found" card.
     warn  — amber "installed but unsupported" card: upgrade commands + a docs
             link, and it does NOT block. ops-35 (#1877) added this; the floor
             is a support line, so untested is not broken.
     fail  — per-OS install instructions + Re-check (the venv-bootstrap
             decision-Z pattern). This is the only blocking state. */

import type { SetupReadiness } from '../../lib/api';
import { wikiUrl, WIZARD_STEP_WIKI } from '../../lib/wiki-links';

interface Props {
  readiness: SetupReadiness;
  onRefetch: () => void;
}

export function StepFfmpeg({ readiness, onRefetch }: Props) {
  const diagnosis = readiness.blockers.ffmpeg;
  const passed = diagnosis.status === 'pass';
  /* Any 'warn' renders the outdated card, not just cause 'ffmpeg-too-old'.
     Keying on the cause would send the next warn cause added down the "isn't
     installed yet" path — exactly the bug ops-35 fixed here. The card leads
     with diagnosis.message, so a different warn still reads correctly. */
  const outdated = diagnosis.status === 'warn';

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
              {/* Deliberately NOT the `ffmpeg` snap: its stable channel is
                  4.3.1 (2020), older than Ubuntu 22.04's own 4.4.2, so it
                  would downgrade the very users this card is shown to. */}
              <pre className="text-xs bg-ink/5 text-ink rounded-lg p-3 overflow-x-auto leading-relaxed">
                {'sudo apt install ffmpeg'}
              </pre>
              <p className="text-xs text-ink/50">
                Ubuntu 24.04+ and Debian 13+ ship a supported build. Ubuntu 22.04 tops out
                at 4.4 — you’ll need to upgrade the OS, or install a newer ffmpeg yourself.
              </p>
            </div>
          </div>

          <p className="text-xs text-amber-900/70">
            Still showing the old version afterwards? Run{' '}
            <code className="font-mono">ffmpeg -version</code> — if it hasn’t changed, an older
            copy earlier on your PATH is shadowing the new one.
          </p>

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
