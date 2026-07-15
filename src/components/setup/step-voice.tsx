/* Setup wizard — Step: Voice.
   Voice engines share one Python runtime — set it up once, then every
   engine can use it. One models-status fetch feeds BOTH the runtime badge/
   liveness pill AND each install card's controlled `status` prop, so the badges
   and the cards can never disagree. The aggregate "Voice" badge still rides the
   readiness.blockers.tts diagnosis (its source is consistent with models-status
   server-side). */

import { useCallback, useEffect, useState, type JSX } from 'react';
import { VenvBootstrap } from '../venv-bootstrap';
import { KokoroInstall } from '../kokoro-install';
import { QwenInstall } from '../qwen-install';
import { CoquiInstall } from '../coqui-install';
import { BlockerFixAction } from '../blocker-fix-action';
import {
  api,
  type SetupReadiness,
  type BlockerDiagnosis,
  type ModelsStatus,
  type NeedsAnswer,
  type EngineRecommendation,
} from '../../lib/api';
import { useAppDispatch } from '../../store';
import { saveAccountSettings } from '../../store/account-slice';
import { runtimeLivenessPill } from './engine-card-status';
import { NEEDS_QUESTION, needsAnswerLabel, RECOMMENDED_BADGE, engineDisplayName } from './engine-recommendation-copy';

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
  const dispatch = useAppDispatch();
  const [models, setModels] = useState<ModelsStatus | null>(null);
  const [needs, setNeeds] = useState<NeedsAnswer | null>(null);

  const activeRec: EngineRecommendation | null =
    models && needs
      ? needs === 'expressive-or-multilingual'
        ? models.recommendation.expressiveOrMultilingual
        : models.recommendation.simpleEnglish
      : null;

  const chooseNeeds = useCallback(
    (answer: NeedsAnswer) => {
      setNeeds(answer);
      if (!models) return;
      const rec =
        answer === 'expressive-or-multilingual'
          ? models.recommendation.expressiveOrMultilingual
          : models.recommendation.simpleEnglish;
      void dispatch(
        saveAccountSettings({
          defaultTtsModelKey: rec.modelKey,
          defaultTtsModelKeyExplicit: true,
          defaultTtsEngine: 'local',
        }),
      );
    },
    [dispatch, models],
  );

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

          <fieldset className="rounded-2xl border border-ink/10 p-4 space-y-2">
            <legend className="text-sm font-medium text-ink px-1">{NEEDS_QUESTION}</legend>
            {(['expressive-or-multilingual', 'simple-english'] as NeedsAnswer[]).map((a) => (
              <label
                key={a}
                className="flex items-center gap-2 text-sm text-ink/80 min-h-[44px] fine-pointer:min-h-0"
              >
                <input type="radio" name="voice-needs" checked={needs === a} onChange={() => chooseNeeds(a)} />
                {needsAnswerLabel(a)}
              </label>
            ))}
            {!needs && (
              <p className="text-xs text-ink/50 pt-1">
                Answer to see which engine we'd recommend for you.
              </p>
            )}
          </fieldset>

          {(() => {
            const ALL: Array<'kokoro' | 'qwen' | 'coqui'> = ['kokoro', 'qwen', 'coqui'];
            const leadId = activeRec?.engine ?? 'kokoro';
            const ordered = [leadId, ...ALL.filter((id) => id !== leadId)];

            const CARD: Record<'kokoro' | 'qwen' | 'coqui', () => JSX.Element> = {
              kokoro: () => <KokoroInstall status={models.engines.kokoro} onInstalled={refetchBoth} />,
              qwen: () => <QwenInstall status={models.engines.qwen} onInstalled={refetchBoth} />,
              coqui: () => <CoquiInstall status={models.engines.coqui} onInstalled={refetchBoth} />,
            };

            return (
              <>
                <div data-engine-card={leadId} className="space-y-2">
                  {activeRec && (
                    <div className="space-y-1">
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-800">
                        {RECOMMENDED_BADGE}
                      </span>
                      {activeRec.caveat && (
                        <p data-testid="recommendation-caveat" aria-live="polite" className="text-xs text-sky-700">
                          {activeRec.caveat}
                        </p>
                      )}
                    </div>
                  )}
                  {CARD[leadId]()}
                </div>

                <details className="group rounded-2xl border border-ink/10" open={!activeRec}>
                  <summary className="flex cursor-pointer items-center justify-between px-4 py-3 text-sm font-medium text-ink select-none">
                    <span>{activeRec ? 'Other engines' : 'More voice engines'}</span>
                    <span className="text-xs text-ink/50 group-open:hidden">
                      {ordered.slice(1).map(engineDisplayName).join(' · ')}
                    </span>
                    <span className="text-xs text-ink/50 hidden group-open:inline">Hide</span>
                  </summary>
                  <div className="px-4 pb-4 space-y-4">
                    {!activeRec && (
                      <p className="text-xs text-ink/55">
                        On a GPU box, Qwen3-TTS installs automatically with the Python runtime — fetch
                        its model weights here to enable bespoke per-character voice design. Coqui XTTS
                        v2 is an optional add-on for zero-shot voice cloning.
                      </p>
                    )}
                    {ordered.slice(1).map((id) => (
                      <div key={id} data-engine-card={id}>
                        {CARD[id]()}
                      </div>
                    ))}
                  </div>
                </details>
              </>
            );
          })()}
        </>
      )}
    </div>
  );
}
