/* Setup wizard — Step: Voice.
   Voice engines share one Python runtime — set it up once, then every
   engine can use it. One models-status fetch feeds BOTH the runtime badge/
   liveness pill AND each install card's controlled `status` prop, so the badges
   and the cards can never disagree. The aggregate "Voice" badge still rides the
   readiness.blockers.tts diagnosis (its source is consistent with models-status
   server-side). */

import { useCallback, useEffect, useState } from 'react';
import { VenvBootstrap } from '../venv-bootstrap';
import { KokoroInstall } from '../kokoro-install';
import { QwenInstall } from '../qwen-install';
import { CoquiInstall } from '../coqui-install';
import { BlockerFixAction } from '../blocker-fix-action';
import { api, type SetupReadiness, type BlockerDiagnosis, type ModelsStatus } from '../../lib/api';
import { runtimeLivenessPill } from './engine-card-status';

function BlockerBadge({
  diagnosis,
  label,
  onRefetch,
}: {
  diagnosis: BlockerDiagnosis;
  label: string;
  onRefetch: () => void;
}) {
  const isPass = diagnosis.status === 'pass';
  return (
    <div className="space-y-1.5">
      <span
        data-blocker-status={diagnosis.status}
        className={[
          'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold',
          isPass ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800',
        ].join(' ')}
      >
        <span className={['w-1.5 h-1.5 rounded-full', isPass ? 'bg-emerald-600' : 'bg-amber-600'].join(' ')} />
        {label}
      </span>
      {!isPass && (
        <>
          <p className="text-xs text-ink/60">{diagnosis.message}</p>
          <BlockerFixAction diagnosis={diagnosis} onDone={onRefetch} />
        </>
      )}
    </div>
  );
}

/* Runtime badge from DISK truth (installedOnDisk), NOT the process axis — the
   old sidecar-blocker conflated disk + process, so a still-booting sidecar read
   as "Runtime needed". */
function RuntimeDiskBadge({ installedOnDisk }: { installedOnDisk: boolean }) {
  return (
    <span
      data-testid="runtime-disk-badge"
      data-blocker-status={installedOnDisk ? 'pass' : 'fail'}
      className={[
        'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold self-start',
        installedOnDisk ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800',
      ].join(' ')}
    >
      <span
        className={['w-1.5 h-1.5 rounded-full', installedOnDisk ? 'bg-emerald-600' : 'bg-amber-600'].join(' ')}
      />
      {installedOnDisk ? 'Runtime installed' : 'Runtime needed'}
    </span>
  );
}

/* Separate liveness pill: a transient 'starting' is neutral (blue), never amber.
   'down'/'crashed' are alarm (rose). */
function RuntimeLivenessPill({ runtime }: { runtime: ModelsStatus['runtime'] }) {
  const pill = runtimeLivenessPill(runtime);
  if (!pill) return null;
  const neutral = pill.tone === 'neutral';
  return (
    <span
      data-testid="runtime-liveness-pill"
      data-tone={pill.tone}
      className={[
        'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold self-start',
        neutral ? 'bg-sky-100 text-sky-800' : 'bg-rose-100 text-rose-800',
      ].join(' ')}
    >
      <span className={['w-1.5 h-1.5 rounded-full', neutral ? 'bg-sky-500' : 'bg-rose-500'].join(' ')} />
      {pill.label}
    </span>
  );
}

export function StepVoice({ readiness, onRefetch }: { readiness: SetupReadiness; onRefetch: () => void }) {
  const [models, setModels] = useState<ModelsStatus | null>(null);

  const refetchModels = useCallback(async () => {
    try {
      setModels(await api.getModelsStatus());
    } catch {
      /* keep the last good status */
    }
  }, []);

  useEffect(() => {
    void refetchModels();
  }, [refetchModels]);

  const refetchBoth = useCallback(() => {
    onRefetch();
    void refetchModels();
  }, [onRefetch, refetchModels]);

  return (
    <div className="space-y-8">
      <div className="flex items-start gap-3 flex-wrap">
        <h1 className="text-2xl font-semibold text-ink">Voice</h1>
        {models && <RuntimeDiskBadge installedOnDisk={models.runtime.installedOnDisk} />}
        {models && <RuntimeLivenessPill runtime={models.runtime} />}
        <BlockerBadge
          diagnosis={readiness.blockers.tts}
          label={readiness.blockers.tts.status === 'pass' ? 'Voice ready' : 'Voice needed'}
          onRefetch={refetchBoth}
        />
      </div>

      {/* Guided fix for a runtime that IS installed on disk but the sidecar is
          still blocked (process crashed/exhausted, package broken) — the cases the
          VenvBootstrap card can't resolve. When !installedOnDisk (venv/python
          missing) the card owns the setup flow, so we don't duplicate its button;
          a transient 'starting' is the neutral pill above, never a fix-action. */}
      {models &&
        models.runtime.installedOnDisk &&
        readiness.blockers.sidecar.status !== 'pass' &&
        readiness.blockers.sidecar.cause !== 'unreachable-transient' && (
          <div className="space-y-1.5" data-testid="runtime-fix-action">
            <p className="text-xs text-ink/60">{readiness.blockers.sidecar.message}</p>
            <BlockerFixAction diagnosis={readiness.blockers.sidecar} onDone={refetchBoth} />
          </div>
        )}

      <p className="text-sm text-ink/60">
        Voice engines turn your manuscript into speech. They all share one Python runtime —
        set it up once, then every voice engine can use it.
      </p>

      {models === null ? (
        <p data-testid="step-voice-loading" className="text-sm text-ink/50">
          Checking voice engines…
        </p>
      ) : (
        <>
          <VenvBootstrap status={models.runtime} onBootstrapped={refetchBoth} />
          <KokoroInstall status={models.engines.kokoro} onInstalled={refetchBoth} />

          <details className="group rounded-2xl border border-ink/10">
            <summary className="flex cursor-pointer items-center justify-between px-4 py-3 text-sm font-medium text-ink select-none">
              <span>More voice engines</span>
              <span className="text-xs text-ink/50 group-open:hidden">Qwen3-TTS · Coqui XTTS v2</span>
              <span className="text-xs text-ink/50 hidden group-open:inline">Hide</span>
            </summary>
            <div className="px-4 pb-4 space-y-4">
              <p className="text-xs text-ink/55">
                On a GPU box, Qwen3-TTS installs automatically with the Python runtime — fetch its
                model weights here to enable bespoke per-character voice design. Coqui XTTS v2 is an
                optional add-on for zero-shot voice cloning.
              </p>
              <QwenInstall status={models.engines.qwen} onInstalled={refetchBoth} />
              <CoquiInstall status={models.engines.coqui} onInstalled={refetchBoth} />
            </div>
          </details>
        </>
      )}
    </div>
  );
}
