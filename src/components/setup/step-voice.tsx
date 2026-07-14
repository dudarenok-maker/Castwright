/* Setup wizard — Step: Voice.
   Voice engines share one Python runtime — set it up once, then every
   engine can use it. Lifted verbatim from the former combined Models step. */

import { VenvBootstrap } from '../venv-bootstrap';
import { KokoroInstall } from '../kokoro-install';
import { QwenInstall } from '../qwen-install';
import { CoquiInstall } from '../coqui-install';
import { BlockerFixAction } from '../blocker-fix-action';
import type { SetupReadiness, BlockerDiagnosis } from '../../lib/api';

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

export function StepVoice({ readiness, onRefetch }: { readiness: SetupReadiness; onRefetch: () => void }) {
  return (
    <div className="space-y-8">
      <div className="flex items-start gap-3 flex-wrap">
        <h1 className="text-2xl font-semibold text-ink">Voice</h1>
        <BlockerBadge
          diagnosis={readiness.blockers.sidecar}
          label={readiness.blockers.sidecar.status === 'pass' ? 'Runtime ready' : 'Runtime needed'}
          onRefetch={onRefetch}
        />
        <BlockerBadge
          diagnosis={readiness.blockers.tts}
          label={readiness.blockers.tts.status === 'pass' ? 'Voice ready' : 'Voice needed'}
          onRefetch={onRefetch}
        />
      </div>

      <p className="text-sm text-ink/60">
        Voice engines turn your manuscript into speech. They all share one Python runtime —
        set it up once, then every voice engine can use it.
      </p>

      <VenvBootstrap onBootstrapped={onRefetch} />
      <KokoroInstall onInstalled={onRefetch} />

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
          <QwenInstall onInstalled={onRefetch} />
          <CoquiInstall onInstalled={onRefetch} />
        </div>
      </details>
    </div>
  );
}
