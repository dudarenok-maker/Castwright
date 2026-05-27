/* Plan 120 — global Status modal.
 *
 * Mounted in Layout; renders nothing when `ui.statusModalOpen` is false.
 * Collapses the former top-bar status cluster — the TTS model-control pills
 * (Kokoro / Coqui / Qwen Load/Stop + the GPU-busy badge), the in-flight
 * analysis pill, the generation pill, and the pending-revisions badge — into
 * one place behind the compact Status pill. The bar keeps only the Queue
 * chip, theme toggle and avatar inline, so the nav menu keeps its room.
 *
 * Fully presentational (mounted directly in Layout, not a self-reading
 * container) because the TTS Load/Stop handlers live in Layout's
 * useTtsLifecycle() — they reach this modal as the `ttsControls` ReactNode.
 * The analysis / generation sections reuse the exported AnalysisPill /
 * GenerationPill with their onClick overridden to navigate-AND-close, so the
 * existing single-book→Generate / multi-book→queue routing is preserved
 * without duplication.
 *
 * Responsive per CLAUDE.md mobile protocol (mirrors queue-modal):
 *   - phone (`<640px`) → full-screen sheet
 *   - tablet/desktop    → dialog centered on screen
 * Touch targets ≥44×44 px per WCAG 2.5.5. */

import type { ReactNode } from 'react';
import { IconClose } from '../lib/icons';
import {
  AnalysisPill,
  GenerationPill,
  type AnalysisPillData,
  type GenerationPillData,
} from '../components/top-bar';

interface StatusModalProps {
  open: boolean;
  onClose: () => void;
  /** The <ModelControlPill> cluster Layout builds (ttsPillElement), including
      the GPU-busy badge. null when no book is in scope. */
  ttsControls: ReactNode;
  analysis: AnalysisPillData | null;
  generation: GenerationPillData | null;
  pendingRevisionsCount: number;
  /** Navigate-then-close handlers, wired in Layout (they dispatch the
      underlying navigation then closeStatusModal). */
  onOpenRevisions: () => void;
  onGoToAnalysing: () => void;
  onGoToGeneration: () => void;
}

function Section({
  title,
  testid,
  children,
}: {
  title: string;
  testid: string;
  children: ReactNode;
}) {
  return (
    <section data-testid={testid} className="py-4 border-b border-ink/10 last:border-b-0">
      <p className="text-[10px] uppercase tracking-widest text-ink/50 font-semibold mb-2">{title}</p>
      {children}
    </section>
  );
}

export function StatusModal({
  open,
  onClose,
  ttsControls,
  analysis,
  generation,
  pendingRevisionsCount,
  onOpenRevisions,
  onGoToAnalysing,
  onGoToGeneration,
}: StatusModalProps) {
  if (!open) return null;
  return (
    <>
      <div
        onClick={onClose}
        className="fixed inset-0 bg-ink/40 z-50 fade-in"
        data-testid="status-modal-backdrop"
      />
      <div
        className="fixed inset-0 z-50 grid sm:place-items-center sm:p-6 pointer-events-none"
        role="dialog"
        aria-modal="true"
        aria-label="Status"
      >
        <div className="bg-white sm:rounded-3xl shadow-float w-full h-full sm:h-auto sm:max-w-2xl sm:max-h-[90vh] pointer-events-auto fade-in flex flex-col">
          {/* Header */}
          <div className="px-6 py-4 border-b border-ink/10 flex items-center gap-3 sticky top-0 bg-white/95 backdrop-blur-md">
            <div className="flex-1 min-w-0">
              <p className="text-[10px] uppercase tracking-widest text-ink/50 font-semibold">Status</p>
              <h3 className="text-base font-bold text-ink">Activity &amp; models</h3>
            </div>
            <button
              onClick={onClose}
              className="p-2 rounded-full hover:bg-ink/5 text-ink/60 min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0"
              aria-label="Close status"
            >
              <IconClose className="w-4 h-4" />
            </button>
          </div>

          {/* Body */}
          <div className="px-6 py-2 flex-1 overflow-y-auto">
            <Section title="TTS engines" testid="status-modal-tts">
              {ttsControls ?? (
                <p className="text-sm text-ink/60">TTS controls appear once a manuscript is open.</p>
              )}
            </Section>
            <Section title="Analysis" testid="status-modal-analysis">
              {analysis ? (
                <AnalysisPill data={{ ...analysis, onClick: onGoToAnalysing }} />
              ) : (
                <p className="text-sm text-ink/60">No analysis running.</p>
              )}
            </Section>
            <Section title="Generation" testid="status-modal-generation">
              {generation ? (
                <GenerationPill data={{ ...generation, onClick: onGoToGeneration }} />
              ) : (
                <p className="text-sm text-ink/60">Nothing generating.</p>
              )}
            </Section>
            <Section title="Revisions" testid="status-modal-revisions">
              {pendingRevisionsCount > 0 ? (
                <button
                  type="button"
                  onClick={onOpenRevisions}
                  className="inline-flex items-center gap-2 px-3 py-1.5 min-h-[44px] sm:min-h-0 rounded-full bg-peach/15 hover:bg-peach/25 text-magenta text-xs font-semibold transition-colors"
                >
                  {pendingRevisionsCount} revision{pendingRevisionsCount === 1 ? '' : 's'} pending · Open
                </button>
              ) : (
                <p className="text-sm text-ink/60">No pending revisions.</p>
              )}
            </Section>
          </div>
        </div>
      </div>
    </>
  );
}
