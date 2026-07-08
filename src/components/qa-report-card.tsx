import { useState } from 'react';
import type { BookQaReport } from '../lib/types';
import { downloadFile } from '../lib/download-file';
import { formatQaReportJson, formatQaReportText } from '../lib/qa-report-export';
import { api } from '../lib/api';
import { Pill } from './primitives';

interface QaReportCardProps {
  report: BookQaReport | null;
  loading: boolean;
  error: boolean;
  bookTitle: string;
  bookId: string;
  scoringProgress?: { charactersChecked: number; charactersOnRoster: number };
}

function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

/* fs-51 round-2 review fix — see the matching comment in qa-report-export.ts;
   the bold span must be a genuine line count (linesRerecorded), never a sum
   of unlike units mislabeled "lines." `before`/`after` sandwich the bold
   span so every case (bold-first or bold-last) still ends with a period. */
function headline(report: BookQaReport): { before: string; bold: string; after: string } {
  const hasOtherIssues = report.asr.linesFlaggedDrift > 0 || report.voiceDrift.mismatches.length > 0;
  if (report.acoustic.linesRerecorded > 0) {
    return { before: '', bold: String(report.acoustic.linesRerecorded), after: ' lines needed a second take.' };
  }
  if (hasOtherIssues) return { before: 'Some lines need a ', bold: 'second look', after: '.' };
  return { before: 'Every line ', bold: 'held', after: '.' };
}

function AcousticRow({ report }: { report: BookQaReport }) {
  const { linesChecked, linesRerecorded } = report.acoustic;
  return (
    <div className="flex items-center justify-between py-2">
      <span className="text-sm text-ink/70">Acoustic</span>
      <span className="text-sm text-ink">{linesChecked} lines checked, {linesRerecorded} needed a second take</span>
    </div>
  );
}

function TranscriptRow({ report }: { report: BookQaReport }) {
  const { linesVerified, linesFlaggedDrift } = report.asr;
  if (linesVerified === 0 && report.totalLines > 0) {
    return (
      <div className="flex items-center justify-between py-2">
        <span className="text-sm text-ink/70">Transcript</span>
        <span className="text-sm text-ink/50">Not run for this book — turn on transcript verification before your next render.</span>
      </div>
    );
  }
  return (
    <div className="flex items-center justify-between py-2">
      <span className="text-sm text-ink/70">Transcript</span>
      <span className="text-sm text-ink">{linesVerified} lines verified, {linesFlaggedDrift} flagged</span>
    </div>
  );
}

function VoiceMatchRow({
  report,
  bookId,
  scoringProgress,
}: {
  report: BookQaReport;
  bookId: string;
  scoringProgress?: { charactersChecked: number; charactersOnRoster: number };
}) {
  const vd = report.voiceDrift;
  const [resuming, setResuming] = useState(false);
  const [resumed, setResumed] = useState(false);

  if (vd.chaptersEligible === 0) {
    return (
      <div className="flex items-center justify-between py-2">
        <span className="text-sm text-ink/70">Voice match</span>
        <span className="text-sm text-ink/50">No stochastic-voiced characters in this book — nothing for this check to do.</span>
      </div>
    );
  }
  /* srv-36 hardening — live progress from an in-flight SSE-streamed scoreBook
     pass (see chapters-slice.ts scoringProgress). Takes priority over every
     other state below: while a scoring pass is actively running, the row
     should reflect that live progress rather than the last-persisted
     snapshot in `report.voiceDrift`. */
  if (scoringProgress) {
    return (
      <div className="flex items-center justify-between py-2">
        <span className="text-sm text-ink/70">Voice match</span>
        <span className="text-sm text-ink">
          ⏳ Checking character voices — {scoringProgress.charactersChecked} of {scoringProgress.charactersOnRoster} done
        </span>
      </div>
    );
  }
  /* srv-36 hardening — charactersPending means a prior scoreBook pass was
     interrupted mid-run (e.g. server restart) and left work undone that no
     live SSE stream will ever resume on its own (Task 6/7's architecture:
     broadcastToBook only reaches subscribers of an active generation job).
     Offer a manual Resume button; see the round-2 plan-review note on why
     the button doesn't revert to clickable after a successful click. */
  if (vd.charactersPending.length > 0) {
    return (
      <div className="flex items-center justify-between py-2">
        <span className="text-sm text-ink/70">Voice match</span>
        <div className="flex items-center gap-2">
          <span className="text-sm text-ink">
            {vd.charactersChecked} of {vd.charactersOnRoster} characters checked so far
          </span>
          {resumed ? (
            <span className="text-xs text-ink/50">Resuming — check back in a few minutes</span>
          ) : (
            <button
              onClick={async () => {
                setResuming(true);
                try {
                  await api.resumeScoring(bookId);
                  // Deliberately stays disabled after success (does NOT revert to
                  // clickable) — a resume-triggered scoreBook run produces no live
                  // SSE progress (see Task 6/7's architecture note), so nothing
                  // will update this row again until the user next reloads the
                  // book and useQaReport re-fetches. Reverting to "Resume scoring"
                  // here would invite a confusing repeat click.
                  setResumed(true);
                } catch {
                  setResuming(false); // a real failure (not the 409 already-running case) — let them retry
                }
              }}
              disabled={resuming}
              className="text-xs font-semibold text-ink/70 hover:text-ink px-3 py-1 rounded-full border border-ink/10 disabled:opacity-50"
            >
              {resuming ? 'Resuming…' : 'Resume scoring'}
            </button>
          )}
        </div>
      </div>
    );
  }
  /* fs-51 correctness fix: chaptersScored === 0 alone no longer means "the
     gate never ran" — a fleet-wide embedding failure (the gate attempted
     every eligible chapter, but embeddings failed for literally all of
     them) ALSO produces chaptersScored === 0, while chaptersEmbedFailed is
     now correctly nonzero for that case. Only show the "never ran"
     invitation copy when chaptersEmbedFailed is ALSO 0 — otherwise fall
     through to the eligible-chapters-scored branch below, which already
     renders the honest "0 of N eligible chapters scored" fraction. */
  if (vd.chaptersScored === 0 && vd.chaptersEmbedFailed === 0) {
    return (
      <div className="flex items-center justify-between py-2">
        <span className="text-sm text-ink/70">Voice match</span>
        <span className="text-sm text-ink/50">Not run for this book — flip on render-integrity checking to catch mismatches automatically.</span>
      </div>
    );
  }
  /* fs-51 round-2 review fix: chaptersScored < chaptersEligible (an isolated
     embed failure) must lead the row, exactly like the character-shortfall
     case below — otherwise a full-roster book with a failed embed still
     reads as a clean "N of N characters checked", the false-clean the
     chaptersEmbedFailed field exists to prevent.
     fs-51 round-3 review fix: also surface inconclusiveCount (short quotes
     below the minimum-duration gate) on this row per the spec — it was
     computed but only ever reached the JSON export. */
  const inconclusiveNote = vd.inconclusiveCount > 0 ? ` · ${vd.inconclusiveCount} chapters inconclusive` : '';
  if (vd.chaptersScored < vd.chaptersEligible) {
    return (
      <div className="flex items-center justify-between py-2">
        <span className="text-sm text-ink/70">Voice match</span>
        <span className="text-sm text-ink">
          {vd.chaptersScored} of {vd.chaptersEligible} eligible chapters scored ({vd.chaptersEmbedFailed} couldn't be embedded), {vd.mismatches.length} mismatches{inconclusiveNote}
        </span>
      </div>
    );
  }
  return (
    <div className="flex items-center justify-between py-2">
      <span className="text-sm text-ink/70">Voice match</span>
      <span className="text-sm text-ink">
        {vd.charactersChecked} of {vd.charactersOnRoster} characters checked, {vd.mismatches.length} mismatches{inconclusiveNote}
      </span>
    </div>
  );
}

function CastContinuityRow({ report }: { report: BookQaReport }) {
  const { mild, moderate, severe } = report.configDrift.counts;
  const total = mild + moderate + severe;
  return (
    <div className="flex items-center justify-between py-2">
      <span className="text-sm text-ink/70">Cast continuity</span>
      <div className="flex items-center gap-2">
        {severe > 0 && <Pill color="danger">{severe} severe</Pill>}
        {moderate > 0 && <Pill color="warning">{moderate} moderate</Pill>}
        {mild > 0 && <Pill color="neutral">{mild} mild</Pill>}
        {total === 0 && <span className="text-sm text-ink">0 changes since render</span>}
      </div>
    </div>
  );
}

export function QaReportCard({ report, loading, error, bookTitle, bookId, scoringProgress }: QaReportCardProps) {
  if (loading) {
    return <div className="bg-white rounded-3xl border border-ink/10 shadow-card p-6 text-sm text-ink/50">Loading QA report…</div>;
  }
  if (error || !report) {
    return <div className="bg-white rounded-3xl border border-ink/10 shadow-card p-6 text-sm text-ink/50">QA report unavailable.</div>;
  }
  const { before, bold, after } = headline(report);

  return (
    <div className="bg-white rounded-3xl border border-ink/10 shadow-card p-6">
      <p className="text-sm uppercase tracking-widest text-ink/45 font-semibold mb-2">Quality gate</p>
      <h3 className="text-lg font-medium text-ink mb-1">
        {before}<span className="font-bold">{bold}</span>{after}
      </h3>
      <p className="text-sm text-ink/60 mb-4">
        Checked, verified, and matched against every character's own voice — automatically, before this book reached you.
      </p>
      <div className="divide-y divide-ink/5">
        <AcousticRow report={report} />
        <TranscriptRow report={report} />
        <VoiceMatchRow report={report} bookId={bookId} scoringProgress={scoringProgress} />
        <CastContinuityRow report={report} />
      </div>
      <div className="flex gap-2 mt-4">
        <button
          onClick={() => downloadFile(`${slugify(bookTitle)}-qa-report.txt`, formatQaReportText(report, bookTitle), 'text/plain')}
          className="text-xs font-semibold text-ink/70 hover:text-ink px-3 py-1.5 rounded-full border border-ink/10"
        >
          Download as text
        </button>
        <button
          onClick={() => downloadFile(`${slugify(bookTitle)}-qa-report.json`, formatQaReportJson(report), 'application/json')}
          className="text-xs font-semibold text-ink/70 hover:text-ink px-3 py-1.5 rounded-full border border-ink/10"
        >
          Download as JSON
        </button>
      </div>
    </div>
  );
}
