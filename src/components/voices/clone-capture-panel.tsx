import { useState } from 'react';
import { useAppDispatch } from '../../store';
import { cloneSample } from '../../store/voice-library-slice';
import { MAX_CLONE_TRANSCRIPT_CHARS } from '../../lib/clone-transcript-limit';
import { VoiceRecorder } from './voice-recorder';
import { TranscriptField } from './transcript-field';

type Relationship = 'self' | 'family-with-permission' | 'guardian-of-minor';
export interface ConsentDraft { personName: string; relationship: Relationship; permittedUse: 'personal'; attestedBy?: string; }

/* #1943 — the attestation sentence's fixed "relaying permission" phrasing is
   wrong for guardian-of-minor: a guardian isn't relaying the child's
   permission, they're consenting on the child's behalf. */
/* self and family-with-permission share ONE literal rather than repeating it:
   two copies of the same sentence is how one arm silently drifts when the
   other is edited, and family-with-permission is the arm where a relative —
   not the subject — is attesting, so a drift there matters most. */
const PERMISSION_SENTENCE = 'I attest I have this person’s permission to clone their voice.';
const ATTEST_SENTENCE: Record<Relationship, string> = {
  self: PERMISSION_SENTENCE,
  'family-with-permission': PERMISSION_SENTENCE,
  'guardian-of-minor': 'I attest, as this child’s guardian, that I consent to cloning their voice.',
};

export function CloneCapturePanel({ onReady }: { onReady: (r: { candidateId: string; transcript: string; consent: ConsentDraft }) => void }) {
  const dispatch = useAppDispatch();
  const [tab, setTab] = useState<'record' | 'upload'>('upload');
  const [candidateId, setCandidateId] = useState<string | null>(null);
  const [transcript, setTranscript] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [personName, setPersonName] = useState('');
  const [relationship, setRelationship] = useState<Relationship>('self');
  const [attestedBy, setAttestedBy] = useState('');
  const [attested, setAttested] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function ingest(blobOrFile: Blob, captureMethod: 'record' | 'upload') {
    setBusy(true); setError(null);
    try {
      const form = new FormData();
      form.append('audio', blobOrFile, captureMethod === 'record' ? 'recording.webm' : 'sample');
      form.append('captureMethod', captureMethod);
      const res = await dispatch(cloneSample(form)).unwrap();
      setCandidateId(res.candidateId); setTranscript(res.transcript); setWarnings(res.qualityWarnings);
    } catch (e) { setError((e as Error).message || 'Could not use that audio.'); }
    finally { setBusy(false); }
  }

  /* #1836 — deliberately NOT a textarea `maxLength`: the browser would
     silently drop the tail of a long paste, and half a correction is exactly
     the silent discard this fixes. Caught here instead, while the field is
     still on screen and editable — after Continue the panel unmounts, so a
     server 400 would leave nowhere to fix it. The route (and the mock) still
     enforce the same cap for non-UI callers. */
  const transcriptTooLong = transcript.length > MAX_CLONE_TRANSCRIPT_CHARS;
  /* #1943 — the attester is who is ACTUALLY attesting, distinct from the
     person being cloned for the two non-self relationships. Required there
     (asking someone to name themselves twice for 'self' is noise, so the
     field is omitted entirely and the server falls back to personName). */
  const attesterRequired = relationship !== 'self';
  const consentComplete =
    personName.trim().length > 0 && attested && (!attesterRequired || attestedBy.trim().length > 0);
  const canContinue = !!candidateId && consentComplete && !busy && !transcriptTooLong;

  return (
    <div className="flex flex-col gap-4">
      <div role="tablist" className="flex gap-2">
        <button role="tab" aria-selected={tab === 'record'} onClick={() => setTab('record')} className="min-h-[44px] fine-pointer:min-h-0">Record</button>
        <button role="tab" aria-selected={tab === 'upload'} onClick={() => setTab('upload')} className="min-h-[44px] fine-pointer:min-h-0">Upload</button>
      </div>
      {tab === 'record'
        ? <VoiceRecorder onRecorded={(blob) => void ingest(blob, 'record')} />
        : <label>Upload a clip<input aria-label="Upload audio" type="file" accept="audio/*" onChange={(e) => { const f = e.target.files?.[0]; if (f) void ingest(f, 'upload'); }} /></label>}

      {busy && <p>Processing sample…</p>}
      {error && <p className="text-magenta">{error}</p>}
      {warnings.map((w) => <p key={w} className="text-amber-600 text-xs">{w}</p>)}
      {candidateId && <TranscriptField value={transcript} onChange={setTranscript} />}

      <fieldset className="flex flex-col gap-2">
        <legend>Consent</legend>
        <label>Person’s name<input aria-label="person name" value={personName} onChange={(e) => setPersonName(e.target.value)} /></label>
        <label>Relationship
          <select aria-label="relationship" value={relationship} onChange={(e) => setRelationship(e.target.value as Relationship)}>
            <option value="self">This is my own voice</option>
            <option value="family-with-permission">A family member, with their permission</option>
            <option value="guardian-of-minor">My child (I’m their guardian)</option>
          </select>
        </label>
        {attesterRequired && (
          <label>Your name (the attester)
            <input
              aria-label="attester name"
              value={attestedBy}
              onChange={(e) => setAttestedBy(e.target.value)}
              className="min-h-[44px] fine-pointer:min-h-0"
            />
          </label>
        )}
        <div className="flex items-center gap-2">
          <input type="checkbox" aria-label="I attest" aria-describedby="clone-attest-sentence" checked={attested} onChange={(e) => setAttested(e.target.checked)} />
          <span id="clone-attest-sentence">{ATTEST_SENTENCE[relationship]}</span>
        </div>
      </fieldset>

      <button
        className="min-h-[44px] fine-pointer:min-h-0"
        disabled={!canContinue}
        onClick={() =>
          candidateId &&
          onReady({
            candidateId,
            transcript,
            consent: {
              personName: personName.trim(),
              relationship,
              permittedUse: 'personal',
              ...(attesterRequired ? { attestedBy: attestedBy.trim() } : {}),
            },
          })
        }
      >Continue</button>
    </div>
  );
}
