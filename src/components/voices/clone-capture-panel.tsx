import { useState } from 'react';
import { useAppDispatch } from '../../store';
import { cloneSample } from '../../store/voice-library-slice';
import { VoiceRecorder } from './voice-recorder';

type Relationship = 'self' | 'family-with-permission' | 'guardian-of-minor';
export interface ConsentDraft { personName: string; relationship: Relationship; permittedUse: 'personal'; }

export function CloneCapturePanel({ onReady }: { onReady: (r: { candidateId: string; consent: ConsentDraft }) => void }) {
  const dispatch = useAppDispatch();
  const [tab, setTab] = useState<'record' | 'upload'>('upload');
  const [candidateId, setCandidateId] = useState<string | null>(null);
  const [transcript, setTranscript] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [personName, setPersonName] = useState('');
  const [relationship, setRelationship] = useState<Relationship>('self');
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

  const consentComplete = personName.trim().length > 0 && attested;
  const canContinue = !!candidateId && consentComplete && !busy;

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
      {candidateId && (
        <label>Transcript<textarea aria-label="transcript" value={transcript} onChange={(e) => setTranscript(e.target.value)} /></label>
      )}

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
        <div className="flex items-center gap-2">
          <input type="checkbox" aria-label="I attest" checked={attested} onChange={(e) => setAttested(e.target.checked)} />
          <span>I attest I have this person’s permission to clone their voice.</span>
        </div>
      </fieldset>

      <button
        className="min-h-[44px] fine-pointer:min-h-0"
        disabled={!canContinue}
        onClick={() => candidateId && onReady({ candidateId, consent: { personName: personName.trim(), relationship, permittedUse: 'personal' } })}
      >Continue</button>
    </div>
  );
}
