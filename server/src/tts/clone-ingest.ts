/* Ingest a captured voice sample → a normalized master.wav candidate + ref_text
   (spec §4.1). Decode (real ffmpeg) → quality gate → cap 60s → WAV → candidate
   store → Whisper transcript. No GPU synth. */
import { decodeAudioToPcm } from './mp3.js';
import { assessCloneSample } from './clone-quality.js';
import { encodePcmToWav } from './wav.js';
import { transcribeSegment } from './transcribe-client.js';
import { writeCandidate } from '../workspace/clone-candidate.js';

const SAMPLE_RATE = 24_000;
const MAX_SECONDS = 60;

export class CloneIngestError extends Error {
  status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'CloneIngestError';
  }
}

export interface CloneSampleCandidateResult {
  candidateId: string;
  transcript: string;
  durationSeconds: number;
  sampleRate: number;
  qualityWarnings: string[];
  /** #1951 — the language Whisper DETECTED in the reference clip, BCP-47-ish
      (`'de'`), or null when it reported none. Previously discarded here, which
      is why `deriveEngineArtifact` had nothing to put in `X-Language` and every
      cloned voice's manifest read "English" — mislabelling the voice in the
      library and making the wizard's completion audition speak the wrong
      language. Internal only: no OpenAPI change, and it lands on the entry's
      existing `languageCode` field. */
  detectedLanguage: string | null;
}

export async function ingestCloneSample(
  input: Buffer,
  opts: { captureMethod: 'upload' | 'record'; candidateId: string; sampleRate?: number },
): Promise<CloneSampleCandidateResult> {
  const sampleRate = opts.sampleRate ?? SAMPLE_RATE;
  let pcm: Buffer;
  try {
    pcm = await decodeAudioToPcm(input, sampleRate);
  } catch (e) {
    throw new CloneIngestError(`Could not decode the audio: ${(e as Error).message}`);
  }
  // Cap to MAX_SECONDS (s16le mono → 2 bytes/sample).
  const maxBytes = MAX_SECONDS * sampleRate * 2;
  if (pcm.length > maxBytes) pcm = pcm.subarray(0, maxBytes);

  const quality = assessCloneSample(pcm, sampleRate);
  if (quality.fatal) throw new CloneIngestError(quality.fatal);

  const wav = encodePcmToWav(pcm, sampleRate);
  const t = await transcribeSegment(pcm, sampleRate);
  const transcript = (t.text ?? '').trim();

  await writeCandidate(
    opts.candidateId,
    {
      sampleRate,
      durationSeconds: quality.durationSeconds,
      transcript,
      transcriptSource: 'whisper',
      captureMethod: opts.captureMethod,
      /* #1951 — persisted because `POST /clone` is a SEPARATE request and the
         candidate's master is the only state that survives between the two.
         Omit the key entirely when Whisper reported no language, so "unknown"
         stays distinguishable from a real detection. */
      ...(t.language ? { languageCode: t.language } : {}),
    },
    wav,
  );

  return {
    candidateId: opts.candidateId,
    transcript,
    durationSeconds: quality.durationSeconds,
    sampleRate,
    qualityWarnings: quality.warnings,
    detectedLanguage: t.language,
  };
}
