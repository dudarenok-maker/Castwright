/* fs-21 wave 2 — C5: SetupWizard orchestrator.
   Composes the five step components into two modes:

   - guided   — linear, one step at a time, Back/Next paging + a "Step N of 5"
                progress indicator. Next is ALWAYS enabled: the derived Wave 0
                boot gate is the real lock, so the wizard never blocks
                progression on a failing blocker. The final step (Finish) owns
                its own "Finish setup" button (via onFinish), so the wizard's
                Next is dropped there.
   - checklist — all five steps rendered stacked for re-entry (used once setup
                is already complete); no Back/Next.

   Per-step prop types differ (StepDefaults has no onRefetch; StepFinish takes
   onFinish, not onRefetch), so each step is wired explicitly rather than via a
   uniform spread. */

import { useState } from 'react';
import { MixedHeading } from '../primitives';
import type { SetupReadiness } from '../../lib/api';
import { StepEnvironment } from './step-environment';
import { StepFfmpeg } from './step-ffmpeg';
import { StepModels } from './step-models';
import { StepDefaults } from './step-defaults';
import { StepFinish } from './step-finish';

type StepId = 'environment' | 'ffmpeg' | 'models' | 'defaults' | 'finish';

const STEPS: { id: StepId; title: string }[] = [
  { id: 'environment', title: 'Environment' },
  { id: 'ffmpeg', title: 'ffmpeg' },
  { id: 'models', title: 'Models' },
  { id: 'defaults', title: 'Defaults' },
  { id: 'finish', title: 'Finish' },
];

interface Props {
  readiness: SetupReadiness;
  mode: 'guided' | 'checklist';
  onRefetch: () => void;
  onFinish: () => void;
  onTryDemoBook?: () => void;
}

/* Render a single step by id, passing ONLY the props its type declares. */
function renderStep(
  id: StepId,
  readiness: SetupReadiness,
  onRefetch: () => void,
  onFinish: () => void,
  onTryDemoBook?: () => void,
) {
  switch (id) {
    case 'environment':
      return <StepEnvironment readiness={readiness} onRefetch={onRefetch} />;
    case 'ffmpeg':
      return <StepFfmpeg readiness={readiness} onRefetch={onRefetch} />;
    case 'models':
      return <StepModels readiness={readiness} onRefetch={onRefetch} />;
    case 'defaults':
      return <StepDefaults readiness={readiness} />;
    case 'finish':
      return <StepFinish readiness={readiness} onFinish={onFinish} onTryDemoBook={onTryDemoBook} />;
  }
}

export function SetupWizard({ readiness, mode, onRefetch, onFinish, onTryDemoBook }: Props) {
  const [stepIndex, setStepIndex] = useState(0);

  return (
    <div className="max-w-[960px] mx-auto px-4 sm:px-6 py-10">
      <header className="mb-8">
        <MixedHeading regular="Set up" bold="Castwright" level="h1" />
        <p className="mt-3 text-ink/60 max-w-xl">
          A quick check that everything needed to produce an audiobook is in place.
        </p>
      </header>

      {mode === 'guided' ? (
        <GuidedWizard
          readiness={readiness}
          stepIndex={stepIndex}
          onStepChange={setStepIndex}
          onRefetch={onRefetch}
          onFinish={onFinish}
          onTryDemoBook={onTryDemoBook}
        />
      ) : (
        <ChecklistWizard readiness={readiness} onRefetch={onRefetch} onFinish={onFinish} onTryDemoBook={onTryDemoBook} />
      )}
    </div>
  );
}

// ── guided mode ───────────────────────────────────────────────────────────────

function GuidedWizard({
  readiness,
  stepIndex,
  onStepChange,
  onRefetch,
  onFinish,
  onTryDemoBook,
}: {
  readiness: SetupReadiness;
  stepIndex: number;
  onStepChange: (next: number) => void;
  onRefetch: () => void;
  onFinish: () => void;
  onTryDemoBook?: () => void;
}) {
  const step = STEPS[stepIndex];
  const isFirst = stepIndex === 0;
  const isLast = stepIndex === STEPS.length - 1;

  return (
    <div className="space-y-6">
      {/* Progress indicator: dots + "Step N of 5" */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1.5" aria-hidden>
          {STEPS.map((s, i) => (
            <span
              key={s.id}
              className={[
                'h-2 rounded-full transition-all',
                i === stepIndex ? 'w-6 bg-magenta' : 'w-2 bg-ink/15',
              ].join(' ')}
            />
          ))}
        </div>
        <span className="text-xs font-medium text-ink/55">
          Step {stepIndex + 1} of {STEPS.length}
        </span>
      </div>

      <div className="rounded-2xl border border-ink/10 bg-white p-5 sm:p-6 shadow-card">
        {renderStep(step.id, readiness, onRefetch, onFinish, onTryDemoBook)}
      </div>

      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => onStepChange(stepIndex - 1)}
          disabled={isFirst}
          className="min-h-[44px] sm:min-h-0 px-4 py-2 rounded-full border border-ink/15 bg-white text-sm font-medium text-ink/70 hover:bg-ink/5 disabled:opacity-40 disabled:hover:bg-white disabled:cursor-not-allowed"
        >
          Back
        </button>

        {/* Next is ALWAYS enabled — no blocker gating. On the last step the
            Finish button lives inside StepFinish, so the wizard's Next is gone. */}
        {!isLast && (
          <button
            type="button"
            onClick={() => onStepChange(stepIndex + 1)}
            className="min-h-[44px] sm:min-h-0 px-5 py-2 rounded-full bg-ink text-canvas text-sm font-medium hover:bg-ink-soft"
          >
            Next
          </button>
        )}
      </div>
    </div>
  );
}

// ── checklist mode ──────────────────────────────────────────────────────────

function ChecklistWizard({
  readiness,
  onRefetch,
  onFinish,
  onTryDemoBook,
}: {
  readiness: SetupReadiness;
  onRefetch: () => void;
  onFinish: () => void;
  onTryDemoBook?: () => void;
}) {
  return (
    <div className="space-y-6">
      {STEPS.map((s) => (
        <section
          key={s.id}
          className="rounded-2xl border border-ink/10 bg-white p-5 sm:p-6 shadow-card"
        >
          {renderStep(s.id, readiness, onRefetch, onFinish, onTryDemoBook)}
        </section>
      ))}
    </div>
  );
}
