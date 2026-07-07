import type { BookQaReport } from '../lib/types';
import { downloadFile } from '../lib/download-file';
import { formatQaReportJson, formatQaReportText } from '../lib/qa-report-export';
import { Pill } from './primitives';

interface QaReportCardProps {
  report: BookQaReport | null;
  loading: boolean;
  error: boolean;
  bookTitle: string;
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

function VoiceMatchRow({ report }: { report: BookQaReport }) {
  const vd = report.voiceDrift;
  if (vd.chaptersEligible === 0) {
    return (
      <div className="flex items-center justify-between py-2">
        <span className="text-sm text-ink/70">Voice match</span>
        <span className="text-sm text-ink/50">No stochastic-voiced characters in this book — nothing for this check to do.</span>
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

export function QaReportCard({ report, loading, error, bookTitle }: QaReportCardProps) {
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
        <VoiceMatchRow report={report} />
        <CastContinuityRow report={report} />
      </div>
      <div className="flex gap-2 mt-4">
        <button
          onClick={() => downloadFile(`${slugify(bookTitle)}-qa-report.txt`, formatQaReportText(report, bookTitle), 'text/plain')}
          className="text-xs font-semibold text-ink/70 hover:text-ink px-3 py-1.5 rounded-full border border-ink/10"
        >
          Copy as text
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
