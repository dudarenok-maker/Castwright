/* fs-21 wave 2 — C5: SetupWizard orchestrator.
   Composes the seven step components into two modes:

   - guided    — linear, one step at a time, Back/Next paging + a "Step N of 7"
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
import type { SetupReadiness, NeedsAnswer } from '../../lib/api';
import { StepEnvironment } from './step-environment';
import { StepFfmpeg } from './step-ffmpeg';
import { StepAnalysis } from './step-analysis';
import { StepVoice } from './step-voice';
import { StepDefaults } from './step-defaults';
import { StepLibrary } from './step-library';
import { StepLanCert } from './step-lan-cert';
import { StepFinish } from './step-finish';
import { STEPS, type StepId } from './steps';
import { WikiLink } from '../wiki-link';
import { stepLearnMorePage } from '../../lib/wiki-links';
import { HelpResources } from './help-resources';

function assertNever(x: never): never {
  throw new Error(`Unhandled wizard step: ${String(x)}`);
}

interface Props {
  readiness: SetupReadiness;
  mode: 'guided' | 'checklist';
  onRefetch: () => void;
  onFinish: () => void;
  onTryDemoBook?: () => void;
}

/* Render a single step by id, passing ONLY the props its type declares.
   The wizard swaps steps by unmounting the current one, so any answer a step
   holds in its own state is lost on Back/Next. The Voice step's guided answer
   therefore lives on the wizard (voiceNeeds) and is threaded in here, so it
   survives navigation. */
function renderStep(
  id: StepId,
  readiness: SetupReadiness,
  onRefetch: () => void,
  onFinish: () => void,
  voiceNeeds: NeedsAnswer | null,
  onChooseVoiceNeeds: (answer: NeedsAnswer) => void,
  libraryChanged: boolean,
  onLibraryChanged: () => void,
  onTryDemoBook?: () => void,
) {
  switch (id) {
    case 'environment':
      return <StepEnvironment readiness={readiness} onRefetch={onRefetch} />;
    case 'ffmpeg':
      return <StepFfmpeg readiness={readiness} onRefetch={onRefetch} />;
    case 'analysis':
      return <StepAnalysis readiness={readiness} onRefetch={onRefetch} />;
    case 'voice':
      return (
        <StepVoice
          readiness={readiness}
          onRefetch={onRefetch}
          needs={voiceNeeds}
          onChooseNeeds={onChooseVoiceNeeds}
        />
      );
    case 'defaults':
      return <StepDefaults readiness={readiness} />;
    case 'library':
      return <StepLibrary readiness={readiness} onLibrarySaved={onLibraryChanged} />;
    case 'lanCert':
      return <StepLanCert />;
    case 'finish':
      return (
        <StepFinish
          readiness={readiness}
          onFinish={onFinish}
          onTryDemoBook={onTryDemoBook}
          libraryChanged={libraryChanged}
        />
      );
    default:
      return assertNever(id);
  }
}

export function SetupWizard({ readiness, mode, onRefetch, onFinish, onTryDemoBook }: Props) {
  const [stepIndex, setStepIndex] = useState(0);
  /* The Voice step's guided answer lives here, not in StepVoice, so paging
     Back/Next (which unmounts the step) doesn't forget it — and the user never
     has to re-answer, which previously re-fired the recommended-engine save and
     clobbered a finer model picked on the Defaults step. */
  const [voiceNeeds, setVoiceNeeds] = useState<NeedsAnswer | null>(null);
  /* Session flag: did the user change the library location earlier in the
     wizard? Threaded down to the Finish step so it can remind about the
     restart needed to move the library. */
  const [libraryChanged, setLibraryChanged] = useState(false);

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
          voiceNeeds={voiceNeeds}
          onChooseVoiceNeeds={setVoiceNeeds}
          libraryChanged={libraryChanged}
          onLibraryChanged={() => setLibraryChanged(true)}
          onTryDemoBook={onTryDemoBook}
        />
      ) : (
        <ReEntryFlow
          readiness={readiness}
          onRefetch={onRefetch}
          onFinish={onFinish}
          voiceNeeds={voiceNeeds}
          onChooseVoiceNeeds={setVoiceNeeds}
          libraryChanged={libraryChanged}
          onLibraryChanged={() => setLibraryChanged(true)}
          onTryDemoBook={onTryDemoBook}
        />
      )}

      <HelpResources />
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
  voiceNeeds,
  onChooseVoiceNeeds,
  libraryChanged,
  onLibraryChanged,
  onTryDemoBook,
  onExit,
}: {
  readiness: SetupReadiness;
  stepIndex: number;
  onStepChange: (next: number) => void;
  onRefetch: () => void;
  onFinish: () => void;
  /** Voice step's guided answer, owned by the wizard so it survives paging. */
  voiceNeeds: NeedsAnswer | null;
  onChooseVoiceNeeds: (answer: NeedsAnswer) => void;
  /** Did the user change the library location earlier in the wizard? */
  libraryChanged: boolean;
  onLibraryChanged: () => void;
  onTryDemoBook?: () => void;
  /** When provided (re-entry), shows a "Setup overview" link back to the summary. */
  onExit?: () => void;
}) {
  const step = STEPS[stepIndex];
  const learnMorePage = stepLearnMorePage(step.id);
  const isFirst = stepIndex === 0;
  const isLast = stepIndex === STEPS.length - 1;

  return (
    <div className="space-y-6">
      {onExit && (
        <button
          type="button"
          onClick={onExit}
          className="inline-flex items-center gap-1 min-h-[44px] fine-pointer:min-h-0 text-sm font-medium text-ink/60 hover:text-ink"
        >
          &lsaquo; Setup overview
        </button>
      )}

      {/* Progress indicator: dots + "Step N of 7" */}
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
        {learnMorePage && (
          <div className="mb-3 flex flex-wrap justify-end">
            <WikiLink page={learnMorePage} label="Learn more" />
          </div>
        )}
        {renderStep(
          step.id,
          readiness,
          onRefetch,
          onFinish,
          voiceNeeds,
          onChooseVoiceNeeds,
          libraryChanged,
          onLibraryChanged,
          onTryDemoBook,
        )}
      </div>

      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => onStepChange(stepIndex - 1)}
          disabled={isFirst}
          className="min-h-[44px] fine-pointer:min-h-0 px-4 py-2 rounded-full border border-ink/15 bg-white text-sm font-medium text-ink/70 hover:bg-ink/5 disabled:opacity-40 disabled:hover:bg-white disabled:cursor-not-allowed"
        >
          Back
        </button>

        {/* Next is ALWAYS enabled — no blocker gating. On the last step the
            Finish button lives inside StepFinish, so the wizard's Next is gone. */}
        {!isLast && (
          <button
            type="button"
            onClick={() => onStepChange(stepIndex + 1)}
            className="min-h-[44px] fine-pointer:min-h-0 px-5 py-2 rounded-full bg-ink text-canvas text-sm font-medium hover:bg-ink-soft"
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
  voiceNeeds,
  onChooseVoiceNeeds,
  libraryChanged,
  onLibraryChanged,
  onTryDemoBook,
}: {
  readiness: SetupReadiness;
  onRefetch: () => void;
  onFinish: () => void;
  voiceNeeds: NeedsAnswer | null;
  onChooseVoiceNeeds: (answer: NeedsAnswer) => void;
  libraryChanged: boolean;
  onLibraryChanged: () => void;
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
        onFinish={onFinish}
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
      voiceNeeds={voiceNeeds}
      onChooseVoiceNeeds={onChooseVoiceNeeds}
      libraryChanged={libraryChanged}
      onLibraryChanged={onLibraryChanged}
      onTryDemoBook={onTryDemoBook}
      onExit={() => setWizardStep(null)}
    />
  );
}

type SummaryStatus = 'ok' | 'warn' | 'attention';

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
   blockers (ffmpeg, voice runtime + default voice, analyzer) drive the dots.
   Analyzer precedes Voice, mirroring the local-first Analysis-before-Voice
   step order. */
function buildSummaryRows(readiness: SetupReadiness): SummaryRow[] {
  const { blockers, info } = readiness;
  // Transient sidecar unreachability (engine still starting up) is not a
  // real blocker — agrees with the step-voice neutral pill (#1612).
  const sidecarBlocking = blockers.sidecar.status === 'fail' && blockers.sidecar.cause !== 'unreachable-transient';
  const voiceOk = !sidecarBlocking && blockers.tts.status === 'pass';
  const voiceDetail = voiceOk
    ? 'Runtime + default voice ready'
    : (sidecarBlocking ? blockers.sidecar.message : blockers.tts.message);
  const analyzerStatus: SummaryStatus =
    blockers.analyzer.status === 'pass' ? 'ok' : blockers.analyzer.status === 'warn' ? 'warn' : 'attention';
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
      detail: blockers.ffmpeg.status === 'pass' ? 'ffmpeg installed' : blockers.ffmpeg.message,
      status: blockers.ffmpeg.status === 'pass' ? 'ok' : 'attention',
      stepIndex: 1,
    },
    {
      key: 'analyzer',
      label: 'Analyzer',
      detail: blockers.analyzer.status === 'pass' ? 'Ready' : blockers.analyzer.message,
      status: analyzerStatus,
      stepIndex: 2,
    },
    {
      key: 'voice',
      label: 'Voice engines',
      detail: voiceDetail,
      status: voiceOk ? 'ok' : 'attention',
      stepIndex: 3,
    },
    {
      key: 'defaults',
      label: 'Defaults',
      detail: 'New-book starting points',
      status: 'ok',
      stepIndex: 4,
    },
    {
      key: 'library',
      label: 'Library',
      detail: 'Where audiobooks are saved',
      status: 'ok',
      stepIndex: 5,
    },
    {
      key: 'lanCert',
      label: 'LAN access',
      detail: 'Phone/tablet HTTPS certificate',
      status: 'ok',
      stepIndex: 6,
    },
  ];
}

function SetupSummary({
  readiness,
  onRefetch,
  onFinish,
  onOpenStep,
}: {
  readiness: SetupReadiness;
  onRefetch: () => void;
  onFinish: () => void;
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
          className="shrink-0 min-h-[44px] fine-pointer:min-h-0 px-3 py-1.5 rounded-full border border-ink/20 bg-white text-xs font-medium text-ink hover:bg-ink/5"
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
                r.status === 'ok' ? 'bg-emerald-500' : r.status === 'warn' ? 'bg-amber-400' : 'bg-amber-500',
              ].join(' ')}
              aria-label={
                r.status === 'ok'
                  ? `${r.label}: ready`
                  : r.status === 'warn'
                    ? `${r.label}: ready, no backup`
                    : `${r.label}: needs attention`
              }
            />
            <span className="font-semibold text-ink text-sm w-36 shrink-0">{r.label}</span>
            <span className="text-sm text-ink/60 min-w-0 flex-1 truncate">{r.detail}</span>
            <span className="text-xs font-medium text-ink/40 group-hover:text-magenta shrink-0">
              Review &rsaquo;
            </span>
          </button>
        ))}
      </div>

      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        {allGood ? (
          <>
            <PrimaryButton onClick={onFinish}>Continue to my library</PrimaryButton>
            <PrimaryButton variant="ghost" icon={false} onClick={() => onOpenStep(0)}>
              Open setup wizard
            </PrimaryButton>
          </>
        ) : (
          <PrimaryButton onClick={() => onOpenStep(attention[0]?.stepIndex ?? 0)}>
            Fix setup
          </PrimaryButton>
        )}
      </div>
    </div>
  );
}
