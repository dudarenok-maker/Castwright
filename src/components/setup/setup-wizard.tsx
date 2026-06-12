/* fs-21 wave 2 — C5: SetupWizard orchestrator.
   Composes the five step components into two modes:

   - guided    — linear, one step at a time, Back/Next paging + a "Step N of 5"
                 progress indicator. Next is ALWAYS enabled: the derived Wave 0
                 boot gate is the real lock, so the wizard never blocks
                 progression on a failing blocker. The final step (Finish) owns
                 its own finish button (via onFinish), so the wizard's Next is
                 dropped there.
   - re-entry  — used once setup is already complete. Opens on a compact
                 at-a-glance SUMMARY board (one row per step with a green/amber
                 status dot, mirroring the Admin → Health board). From there the
                 user drills into the same guided step-by-step flow — clicking a
                 row (or "Open setup wizard") enters the wizard at that step, and
                 a "Setup overview" link returns to the summary.

   Per-step prop types differ (StepDefaults has no onRefetch; StepFinish takes
   onFinish, not onRefetch), so each step is wired explicitly rather than via a
   uniform spread. */

import { useState } from 'react';
import { MixedHeading, PrimaryButton } from '../primitives';
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
        <ReEntryFlow
          readiness={readiness}
          onRefetch={onRefetch}
          onFinish={onFinish}
          onTryDemoBook={onTryDemoBook}
        />
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
  onExit,
}: {
  readiness: SetupReadiness;
  stepIndex: number;
  onStepChange: (next: number) => void;
  onRefetch: () => void;
  onFinish: () => void;
  onTryDemoBook?: () => void;
  /** When provided (re-entry), shows a "Setup overview" link back to the summary. */
  onExit?: () => void;
}) {
  const step = STEPS[stepIndex];
  const isFirst = stepIndex === 0;
  const isLast = stepIndex === STEPS.length - 1;

  return (
    <div className="space-y-6">
      {onExit && (
        <button
          type="button"
          onClick={onExit}
          className="inline-flex items-center gap-1 min-h-[44px] sm:min-h-0 text-sm font-medium text-ink/60 hover:text-ink"
        >
          &lsaquo; Setup overview
        </button>
      )}

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

// ── re-entry mode (summary board → drill into the wizard) ──────────────────────

function ReEntryFlow({
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
  /* null → showing the summary board; a number → showing the guided wizard
     opened at that step. */
  const [wizardStep, setWizardStep] = useState<number | null>(null);

  if (wizardStep === null) {
    return (
      <SetupSummary
        readiness={readiness}
        onRefetch={onRefetch}
        onOpenStep={(i) => setWizardStep(i)}
      />
    );
  }

  return (
    <GuidedWizard
      readiness={readiness}
      stepIndex={wizardStep}
      onStepChange={setWizardStep}
      onRefetch={onRefetch}
      onFinish={onFinish}
      onTryDemoBook={onTryDemoBook}
      onExit={() => setWizardStep(null)}
    />
  );
}

type SummaryStatus = 'ok' | 'attention';

interface SummaryRow {
  key: string;
  label: string;
  detail: string;
  status: SummaryStatus;
  /** Which guided step this row drills into. */
  stepIndex: number;
}

/* Derive one at-a-glance row per setup area from the readiness blockers.
   Environment + Defaults are informational (always 'ok'); the three real
   blockers (ffmpeg, voice runtime + default voice, analyzer) drive the dots. */
function buildSummaryRows(readiness: SetupReadiness): SummaryRow[] {
  const { blockers, info } = readiness;
  const voiceOk = blockers.sidecar === 'pass' && blockers.tts === 'pass';
  return [
    {
      key: 'environment',
      label: 'Environment',
      detail: info.gpu,
      status: 'ok',
      stepIndex: 0,
    },
    {
      key: 'ffmpeg',
      label: 'Audio assembly',
      detail: blockers.ffmpeg === 'pass' ? 'ffmpeg installed' : 'ffmpeg not found',
      status: blockers.ffmpeg === 'pass' ? 'ok' : 'attention',
      stepIndex: 1,
    },
    {
      key: 'voice',
      label: 'Voice engines',
      detail: voiceOk ? 'Runtime + default voice ready' : 'Runtime or default voice needs setup',
      status: voiceOk ? 'ok' : 'attention',
      stepIndex: 2,
    },
    {
      key: 'analyzer',
      label: 'Analyzer',
      detail: blockers.analyzer === 'pass' ? 'Ready' : 'Needs a Gemini key or a local model',
      status: blockers.analyzer === 'pass' ? 'ok' : 'attention',
      stepIndex: 2,
    },
    {
      key: 'defaults',
      label: 'Defaults',
      detail: 'New-book starting points',
      status: 'ok',
      stepIndex: 3,
    },
  ];
}

function SetupSummary({
  readiness,
  onRefetch,
  onOpenStep,
}: {
  readiness: SetupReadiness;
  onRefetch: () => void;
  onOpenStep: (stepIndex: number) => void;
}) {
  const rows = buildSummaryRows(readiness);
  const attention = rows.filter((r) => r.status === 'attention');
  const allGood = attention.length === 0;

  return (
    <div className="space-y-6" data-testid="setup-summary">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-ink/70">
          {allGood
            ? 'Everything’s ready — Castwright is set up on this machine.'
            : `${attention.length} item${attention.length === 1 ? '' : 's'} need${
                attention.length === 1 ? 's' : ''
              } attention.`}
        </p>
        <button
          type="button"
          onClick={onRefetch}
          className="shrink-0 min-h-[44px] sm:min-h-0 px-3 py-1.5 rounded-full border border-ink/20 bg-white text-xs font-medium text-ink hover:bg-ink/5"
        >
          Re-check
        </button>
      </div>

      {/* Health-style board: one row per area; click a row to open that step. */}
      <div
        data-testid="setup-summary-board"
        className="bg-white rounded-3xl border border-ink/10 shadow-card overflow-hidden divide-y divide-ink/5"
      >
        {rows.map((r) => (
          <button
            key={r.key}
            type="button"
            onClick={() => onOpenStep(r.stepIndex)}
            data-testid={`setup-summary-row-${r.key}`}
            data-status={r.status}
            className="group flex w-full items-center gap-3 px-4 py-3 min-h-[44px] text-left hover:bg-ink/[0.03] transition-colors"
          >
            <span
              className={[
                'inline-block w-2.5 h-2.5 rounded-full shrink-0',
                r.status === 'ok' ? 'bg-emerald-500' : 'bg-amber-500',
              ].join(' ')}
              aria-label={r.status === 'ok' ? `${r.label}: ready` : `${r.label}: needs attention`}
            />
            <span className="font-semibold text-ink text-sm w-36 shrink-0">{r.label}</span>
            <span className="text-sm text-ink/60 min-w-0 flex-1 truncate">{r.detail}</span>
            <span className="text-xs font-medium text-ink/40 group-hover:text-magenta shrink-0">
              Review &rsaquo;
            </span>
          </button>
        ))}
      </div>

      <div className="flex items-center">
        <PrimaryButton onClick={() => onOpenStep(attention[0]?.stepIndex ?? 0)}>
          {allGood ? 'Open setup wizard' : 'Fix setup'}
        </PrimaryButton>
      </div>
    </div>
  );
}
