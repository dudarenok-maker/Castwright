# fs-38 Wave 3 · sub-wave 3a — Ingest, Consent & Recorder — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the no-ML, behind-flag foundation of the voice-clone pipeline — audio ingest (upload + in-browser recorder), a quality gate, Whisper transcription, `master.wav` persistence, consent-at-write store enforcement, a revoke path, and the cloned-voice library surfaces — so sub-wave 3b1 can add the actual Qwen clone on top with no infrastructure work.

**Architecture:** A voice sample enters via `POST /api/voice-library/clone-sample` (multipart upload or a recorded blob), is decoded to s16le PCM by the existing ffmpeg seam, quality-gated, written as a `master.wav` into an **ephemeral candidate** directory, and Whisper-transcribed for `ref_text`. No cloned library entry is persisted in 3a — the candidate is consumed by 3b1's `POST /clone`. The consent-at-write guard, the revoke route, and the cloned-section UI are built and unit-tested here but have no production caller until 3b1 (a disclosed behind-flag slice). The frontend contributes reusable building blocks (recorder, capture+consent panel) that 3b1 assembles into the two-phase wizard.

**Tech Stack:** Node/Express (server), `multer` (memory storage) for uploads, ffmpeg via the existing `server/src/tts/mp3.ts` seam, the sidecar Whisper `POST /transcribe` via `transcribe-client.ts`, Vite + React 18 + Redux Toolkit (frontend), `MediaRecorder`/`getUserMedia` (recorder), Vitest + supertest (server) / Vitest + React Testing Library (frontend), Playwright (e2e). Types are generated from `openapi.yaml`.

## Global Constraints

- **Spec of record:** `docs/superpowers/specs/2026-07-25-fs38-wave3-clone-pipeline-design.md`. 3a scope only (spec §1.1 row 3a); no GPU synth, no `POST /clone`, no cloning.
- **OpenAPI is the type source of truth.** All new wire shapes land in `openapi.yaml` first, then `npm run openapi:types` regenerates `src/lib/api-types.ts`. Never hand-write API types.
- **Route files import `Request`/`Response`/`NextFunction` from `'../http.js'`, NOT from `'express'`.**
- **Frontend mock functions live inside `src/lib/api.ts`** (e.g. `mockDesignLibraryVoice`), not in `src/mocks/`; `src/mocks/voice-library.ts` holds fixtures only. Register each new call in BOTH the `realApi` (~`api.ts:10007`) and `mockApi` (~`api.ts:10296`) objects.
- **All new routes sit on `voiceLibraryRouter`**, mounted with `requireVoiceLibraryEnabled` at `app.ts:196` — they inherit the `voices.library.enabled` 404 gate automatically.
- **Storage-key scope stays `qwen-<voiceUuid>`.** `master.wav` is written by a new Node RIFF writer (no ffmpeg WAV branch exists). Candidate masters live under `<voiceLibraryDir>/_candidates/<candidateId>/`.
- **PCM everywhere is s16le mono**, sample rate caller-supplied (Qwen path is 24000 Hz).
- **Consent enum is fixed (Wave 1):** `relationship ∈ 'self'|'family-with-permission'|'guardian-of-minor'`, `permittedUse: 'personal'`. No enum change.
- **Quality thresholds:** fatal → duration < 4 s or RMS ≤ silence floor (−45 dBFS); warn → 4–8 s (short) or clipping (samples ≥ −0.1 dBFS over > 0.5 % of the clip); ingest cap 60 s.
- **Every task ends green** (`cd server && npm test -- <file>` or `npm test -- <file>` for frontend) and commits. Commit subjects follow `<type>(<scope>): <subject>`, ≤ 100 chars.
- **Testing discipline:** every task lands its paired test; bug-shaped fixes ship a failing-first regression test.

---

### Task 1: OpenAPI shapes — `VoiceMaster`, candidate, clone-sample & revoke

**Files:**
- Modify: `openapi.yaml` (schemas + two paths)
- Modify (generated): `src/lib/api-types.ts` (via `npm run openapi:types`)

**Interfaces:**
- Produces: schema `VoiceMaster`, schema `CloneSampleCandidate`, path `POST /voice-library/clone-sample` (multipart, `202`→`CloneSampleCandidate`), path `POST /voice-library/{voiceUuid}/revoke` (`200`→`VoiceLibraryEntry`). Extends `VoiceLibraryEntry` with optional `master: VoiceMaster`.

- [ ] **Step 1: Add the schemas.** In `openapi.yaml`, under `components.schemas`, add:

```yaml
    VoiceMaster:
      type: object
      required: [clipFile, sampleRate, durationSeconds, transcript, transcriptSource, captureMethod]
      properties:
        clipFile: { type: string, description: "'master.wav', relative to the entry dir" }
        sampleRate: { type: integer }
        durationSeconds: { type: number }
        transcript: { type: string }
        transcriptSource: { type: string, enum: [whisper, user] }
        captureMethod: { type: string, enum: [upload, record] }
    CloneSampleCandidate:
      type: object
      required: [candidateId, transcript, durationSeconds, sampleRate, qualityWarnings]
      properties:
        candidateId: { type: string }
        transcript: { type: string }
        durationSeconds: { type: number }
        sampleRate: { type: integer }
        qualityWarnings: { type: array, items: { type: string } }
        clipPreviewUrl: { type: string }
```

- [ ] **Step 2: Extend `VoiceLibraryEntry`.** In the existing `VoiceLibraryEntry` schema's `properties`, add:

```yaml
        master:
          $ref: '#/components/schemas/VoiceMaster'
```

- [ ] **Step 3: Add the two paths.** Under `paths`:

```yaml
  /voice-library/clone-sample:
    post:
      operationId: cloneVoiceSample
      summary: Ingest a voice sample (upload or recorded blob) into an ephemeral candidate
      requestBody:
        required: true
        content:
          multipart/form-data:
            schema:
              type: object
              required: [audio]
              properties:
                audio: { type: string, format: binary }
                captureMethod: { type: string, enum: [upload, record] }
      responses:
        '202': { description: Candidate created, content: { application/json: { schema: { $ref: '#/components/schemas/CloneSampleCandidate' } } } }
        '400': { description: Bad or unusable audio }
        '404': { description: Voice library disabled }
  /voice-library/{voiceUuid}/revoke:
    post:
      operationId: revokeVoiceLibraryEntry
      summary: Revoke consent for a cloned voice (hides it and makes it unrenderable)
      parameters:
        - { name: voiceUuid, in: path, required: true, schema: { type: string } }
      responses:
        '200': { description: Revoked, content: { application/json: { schema: { $ref: '#/components/schemas/VoiceLibraryEntry' } } } }
        '404': { description: No such entry / disabled }
```

- [ ] **Step 4: Regenerate + verify.** Run: `npm run openapi:types`
Expected: `src/lib/api-types.ts` updated, no error.

- [ ] **Step 5: Verify types compile.** Run: `npm run typecheck`
Expected: PASS (no consumers yet, so this only proves the schema is well-formed).

- [ ] **Step 6: Commit**

```bash
git add openapi.yaml src/lib/api-types.ts
git commit -m "feat(api): fs-38 3a clone-sample/revoke openapi shapes + VoiceMaster"
```

---

### Task 2: Node RIFF WAV writer

**Files:**
- Create: `server/src/tts/wav.ts`
- Test: `server/src/tts/wav.test.ts`

**Interfaces:**
- Produces: `encodePcmToWav(pcm: Buffer, sampleRate: number): Buffer` — wraps s16le-mono PCM in a 44-byte canonical RIFF/WAVE header.

- [ ] **Step 1: Write the failing test.**

```ts
// server/src/tts/wav.test.ts
import { describe, it, expect } from 'vitest';
import { encodePcmToWav } from './wav.js';

describe('encodePcmToWav', () => {
  it('prepends a 44-byte canonical PCM WAV header for s16le mono', () => {
    const pcm = Buffer.alloc(8, 0); // 4 samples
    const wav = encodePcmToWav(pcm, 24_000);
    expect(wav.length).toBe(44 + pcm.length);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.toString('ascii', 12, 16)).toBe('fmt ');
    expect(wav.toString('ascii', 36, 40)).toBe('data');
    expect(wav.readUInt32LE(4)).toBe(36 + pcm.length); // ChunkSize
    expect(wav.readUInt16LE(20)).toBe(1); // PCM
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(24_000); // sample rate
    expect(wav.readUInt32LE(28)).toBe(24_000 * 2); // byte rate = sr * blockAlign
    expect(wav.readUInt16LE(32)).toBe(2); // block align (mono * 16-bit)
    expect(wav.readUInt16LE(34)).toBe(16); // bits per sample
    expect(wav.readUInt32LE(40)).toBe(pcm.length); // Subchunk2Size
    expect(wav.subarray(44)).toEqual(pcm);
  });
});
```

- [ ] **Step 2: Run test to verify it fails.** Run: `cd server && npm test -- src/tts/wav.test.ts`
Expected: FAIL ("Cannot find module './wav.js'").

- [ ] **Step 3: Implement.**

```ts
// server/src/tts/wav.ts
/* Canonical 16-bit mono PCM → RIFF/WAVE. The codebase has no WAV encoder
   (mp3.ts emits only mp3/aac/opus, and decodeAudioToPcm returns headerless
   s16le), so cloned/designed master clips get this ~20-line writer instead of
   a second ffmpeg spawn. Input MUST be s16le mono (what decodeAudioToPcm emits). */
export function encodePcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // audio format = PCM
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
```

- [ ] **Step 4: Run test to verify it passes.** Run: `cd server && npm test -- src/tts/wav.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/tts/wav.ts server/src/tts/wav.test.ts
git commit -m "feat(server): add Node RIFF WAV writer for clone master clips"
```

---

### Task 3: Quality gate (pure)

**Files:**
- Create: `server/src/tts/clone-quality.ts`
- Test: `server/src/tts/clone-quality.test.ts`

**Interfaces:**
- Produces: `assessCloneSample(pcm: Buffer, sampleRate: number): CloneQuality` where `CloneQuality = { durationSeconds: number; fatal?: string; warnings: string[] }`.

- [ ] **Step 1: Write the failing test.**

```ts
// server/src/tts/clone-quality.test.ts
import { describe, it, expect } from 'vitest';
import { assessCloneSample } from './clone-quality.js';

const SR = 24_000;
// tone(seconds, amplitude) → s16le mono buffer of a constant-amplitude square-ish signal
function tone(seconds: number, amp: number): Buffer {
  const n = Math.floor(seconds * SR);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(i % 2 === 0 ? amp : -amp, i * 2);
  return b;
}

describe('assessCloneSample', () => {
  it('reports duration in seconds', () => {
    expect(assessCloneSample(tone(5, 8000), SR).durationSeconds).toBeCloseTo(5, 1);
  });
  it('fatals a clip under 4s', () => {
    expect(assessCloneSample(tone(3, 8000), SR).fatal).toMatch(/short/i);
  });
  it('fatals near-silence', () => {
    expect(assessCloneSample(tone(6, 20), SR).fatal).toMatch(/silen/i);
  });
  it('warns (not fatal) on a 4–8s clip', () => {
    const q = assessCloneSample(tone(5, 8000), SR);
    expect(q.fatal).toBeUndefined();
    expect(q.warnings.join(' ')).toMatch(/short/i);
  });
  it('warns on clipping', () => {
    const q = assessCloneSample(tone(10, 32767), SR);
    expect(q.fatal).toBeUndefined();
    expect(q.warnings.join(' ')).toMatch(/clip/i);
  });
  it('clean 10s clip: no fatal, no warnings', () => {
    const q = assessCloneSample(tone(10, 8000), SR);
    expect(q.fatal).toBeUndefined();
    expect(q.warnings).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails.** Run: `cd server && npm test -- src/tts/clone-quality.test.ts`
Expected: FAIL ("Cannot find module './clone-quality.js'").

- [ ] **Step 3: Implement.**

```ts
// server/src/tts/clone-quality.ts
/* Pure quality gate for a captured voice sample (spec §4.1). Thresholds are the
   spec's Global Constraints; exact cutoffs are calibratable but committed here so
   the ingest route has a single source of truth. Input is s16le mono PCM. */
export interface CloneQuality {
  durationSeconds: number;
  fatal?: string;
  warnings: string[];
}

const SILENCE_DBFS = -45; // fatal at/below
const CLIP_DBFS = -0.1; // a sample at/above this magnitude counts as clipped
const CLIP_FRACTION = 0.005; // >0.5% clipped → warn
const MIN_FATAL_S = 4;
const MIN_GOOD_S = 8;

const FULL_SCALE = 32768;
const dbfs = (linear: number): number => (linear <= 0 ? -Infinity : 20 * Math.log10(linear / FULL_SCALE));

export function assessCloneSample(pcm: Buffer, sampleRate: number): CloneQuality {
  const n = Math.floor(pcm.length / 2);
  const durationSeconds = n / sampleRate;
  const warnings: string[] = [];

  let sumSq = 0;
  let clipped = 0;
  const clipThreshold = Math.pow(10, CLIP_DBFS / 20) * FULL_SCALE;
  for (let i = 0; i < n; i++) {
    const s = pcm.readInt16LE(i * 2);
    sumSq += s * s;
    if (Math.abs(s) >= clipThreshold) clipped++;
  }
  const rms = n > 0 ? Math.sqrt(sumSq / n) : 0;

  if (durationSeconds < MIN_FATAL_S) {
    return { durationSeconds, fatal: `Sample too short (${durationSeconds.toFixed(1)}s) — need at least ${MIN_FATAL_S}s.`, warnings };
  }
  if (dbfs(rms) <= SILENCE_DBFS) {
    return { durationSeconds, fatal: 'Sample is silent or too quiet — record closer to the mic.', warnings };
  }
  if (durationSeconds < MIN_GOOD_S) {
    warnings.push(`Sample is a little short (${durationSeconds.toFixed(1)}s) — 8s+ clones better.`);
  }
  if (n > 0 && clipped / n > CLIP_FRACTION) {
    warnings.push('Audio is clipping — lower the input level or move back from the mic.');
  }
  return { durationSeconds, warnings };
}
```

- [ ] **Step 4: Run test to verify it passes.** Run: `cd server && npm test -- src/tts/clone-quality.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/tts/clone-quality.ts server/src/tts/clone-quality.test.ts
git commit -m "feat(server): pure quality gate for captured clone samples"
```

---

### Task 4: Ephemeral candidate store

**Files:**
- Create: `server/src/workspace/clone-candidate.ts`
- Test: `server/src/workspace/clone-candidate.test.ts`

**Interfaces:**
- Consumes: `voiceLibraryDir()` from `./voice-library.js`.
- Produces:
  - `type CloneCandidate = { candidateId: string; master: VoiceMaster }` (import `VoiceMaster`-shaped fields from the manifest type).
  - `candidateDir(candidateId): string`, `candidateMasterPath(candidateId): string`
  - `writeCandidate(candidateId, master: CloneCandidateMaster, wav: Buffer): Promise<void>`
  - `readCandidate(candidateId): Promise<CloneCandidate | null>`
  - `removeCandidate(candidateId): Promise<void>`
  - where `CloneCandidateMaster = Omit<VoiceMaster, 'clipFile'>`.

- [ ] **Step 1: Write the failing test.**

```ts
// server/src/workspace/clone-candidate.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cand-'));
  process.env.WORKSPACE_DIR = dir;
});
afterEach(() => {
  delete process.env.WORKSPACE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

it('writes, reads back, and removes a candidate', async () => {
  const { writeCandidate, readCandidate, candidateMasterPath, removeCandidate } = await import('./clone-candidate.js');
  const master = { sampleRate: 24_000, durationSeconds: 6, transcript: 'hi', transcriptSource: 'whisper' as const, captureMethod: 'upload' as const };
  await writeCandidate('cand1', master, Buffer.from('RIFFfake'));
  expect(existsSync(candidateMasterPath('cand1'))).toBe(true);
  const read = await readCandidate('cand1');
  expect(read?.master.transcript).toBe('hi');
  expect(read?.master.clipFile).toBe('master.wav');
  await removeCandidate('cand1');
  expect(existsSync(candidateMasterPath('cand1'))).toBe(false);
});

it('readCandidate returns null for an unknown id', async () => {
  const { readCandidate } = await import('./clone-candidate.js');
  expect(await readCandidate('nope')).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails.** Run: `cd server && npm test -- src/workspace/clone-candidate.test.ts`
Expected: FAIL ("Cannot find module './clone-candidate.js'").

- [ ] **Step 3: Implement.**

```ts
// server/src/workspace/clone-candidate.ts
/* Ephemeral holding area for an ingested-but-not-yet-cloned voice sample
   (spec §4.2 phase 1). Lives under <voiceLibraryDir>/_candidates/<id>/; 3b1's
   POST /clone reads it and promotes master.wav into the real entry dir. In 3a it
   has no consumer — that is the disclosed behind-flag state. */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { voiceLibraryDir } from './voice-library.js';
import { safeSegment, assertContained, sanitizeIdSegment } from '../util/safe-path.js';
import type { VoiceLibraryEntry } from './voice-library.js';

export type VoiceMaster = NonNullable<VoiceLibraryEntry['master']>;
export type CloneCandidateMaster = Omit<VoiceMaster, 'clipFile'>;
export interface CloneCandidate {
  candidateId: string;
  master: VoiceMaster;
}

function candidatesRoot(): string {
  return join(voiceLibraryDir(), '_candidates');
}
export function candidateDir(candidateId: string): string {
  const root = candidatesRoot();
  const dir = join(root, sanitizeIdSegment(safeSegment(candidateId)));
  assertContained(root, dir);
  return dir;
}
export function candidateMasterPath(candidateId: string): string {
  return join(candidateDir(candidateId), 'master.wav');
}
function candidateJsonPath(candidateId: string): string {
  return join(candidateDir(candidateId), 'candidate.json');
}

export async function writeCandidate(candidateId: string, master: CloneCandidateMaster, wav: Buffer): Promise<void> {
  const dir = candidateDir(candidateId);
  await mkdir(dir, { recursive: true });
  await writeFile(candidateMasterPath(candidateId), wav);
  const full: VoiceMaster = { ...master, clipFile: 'master.wav' };
  await writeFile(candidateJsonPath(candidateId), JSON.stringify(full, null, 2), 'utf8');
}

export async function readCandidate(candidateId: string): Promise<CloneCandidate | null> {
  const p = candidateJsonPath(candidateId);
  if (!existsSync(p)) return null;
  try {
    const master = JSON.parse(await readFile(p, 'utf8')) as VoiceMaster;
    return { candidateId, master };
  } catch {
    return null;
  }
}

export async function removeCandidate(candidateId: string): Promise<void> {
  await rm(candidateDir(candidateId), { recursive: true, force: true });
}
```

> NOTE for the implementer: if `VoiceLibraryEntry['master']` is not yet present on the server type, Task 1 added `master` to the OpenAPI schema but the **server** `VoiceLibraryEntry` in `voice-library.ts` is a manual mirror — add the `master?: VoiceMaster` field and the `VoiceMaster` interface to `server/src/workspace/voice-library.ts` in this task (it is the store's own type), matching the OpenAPI shape from Task 1.

- [ ] **Step 3b: Add the server-side `master` field.** In `server/src/workspace/voice-library.ts`, add above `VoiceLibraryEntry`:

```ts
export interface VoiceMaster {
  clipFile: string;
  sampleRate: number;
  durationSeconds: number;
  transcript: string;
  transcriptSource: 'whisper' | 'user';
  captureMethod: 'upload' | 'record';
}
```
and add to `VoiceLibraryEntry`: `master?: VoiceMaster;`

- [ ] **Step 4: Run test to verify it passes.** Run: `cd server && npm test -- src/workspace/clone-candidate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/workspace/clone-candidate.ts server/src/workspace/clone-candidate.test.ts server/src/workspace/voice-library.ts
git commit -m "feat(server): ephemeral clone-candidate store + VoiceMaster type"
```

---

### Task 5: Ingest pipeline

**Files:**
- Create: `server/src/tts/clone-ingest.ts`
- Test: `server/src/tts/clone-ingest.test.ts`
- Fixture: reuse an existing small audio file — `server/src/tts/__fixtures__/` if present, else generate one in the test with `encodePcmToWav` (Task 2).

**Interfaces:**
- Consumes: `decodeAudioToPcm` (`./mp3.js`), `assessCloneSample` (`./clone-quality.js`), `encodePcmToWav` (`./wav.js`), `transcribeSegment` (`./transcribe-client.js`), `writeCandidate` (`../workspace/clone-candidate.js`).
- Produces: `ingestCloneSample(input: Buffer, opts: { captureMethod: 'upload'|'record'; candidateId: string; sampleRate?: number }): Promise<CloneSampleCandidateResult>` where `CloneSampleCandidateResult = { candidateId: string; transcript: string; durationSeconds: number; sampleRate: number; qualityWarnings: string[] }`. Throws `CloneIngestError` (with `.status = 400`) on decode failure or a fatal quality verdict.

- [ ] **Step 1: Write the failing test.** (Real ffmpeg decode; mock only the sidecar transcribe.)

```ts
// server/src/tts/clone-ingest.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const transcribeSegment = vi.fn();
vi.mock('./transcribe-client.js', () => ({ transcribeSegment: (...a: unknown[]) => transcribeSegment(...a) }));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ingest-'));
  process.env.WORKSPACE_DIR = dir;
  transcribeSegment.mockResolvedValue({ text: 'the quick brown fox', language: 'en', words: null, avgLogprob: null, noSpeechProb: null, compressionRatio: null });
});
afterEach(() => {
  delete process.env.WORKSPACE_DIR;
  rmSync(dir, { recursive: true, force: true });
  vi.clearAllMocks();
});

async function wav(seconds: number, amp = 8000, sr = 24_000): Promise<Buffer> {
  const { encodePcmToWav } = await import('./wav.js');
  const n = seconds * sr;
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) pcm.writeInt16LE(i % 2 ? -amp : amp, i * 2);
  return encodePcmToWav(pcm, sr);
}

describe('ingestCloneSample', () => {
  it('decodes, gates, writes the candidate, and returns the transcript', async () => {
    const { ingestCloneSample } = await import('./clone-ingest.js');
    const { readCandidate } = await import('../workspace/clone-candidate.js');
    const res = await ingestCloneSample(await wav(6), { captureMethod: 'upload', candidateId: 'c1' });
    expect(res.transcript).toBe('the quick brown fox');
    expect(res.durationSeconds).toBeCloseTo(6, 0);
    expect(res.qualityWarnings).toContain(expect.stringMatching(/short/i));
    expect((await readCandidate('c1'))?.master.captureMethod).toBe('upload');
  });

  it('throws a 400 on a fatally short sample', async () => {
    const { ingestCloneSample, CloneIngestError } = await import('./clone-ingest.js');
    await expect(ingestCloneSample(await wav(2), { captureMethod: 'record', candidateId: 'c2' }))
      .rejects.toMatchObject({ status: 400 });
    void CloneIngestError;
  });

  it('throws a 400 when the audio cannot be decoded', async () => {
    const { ingestCloneSample } = await import('./clone-ingest.js');
    await expect(ingestCloneSample(Buffer.from('not audio'), { captureMethod: 'upload', candidateId: 'c3' }))
      .rejects.toMatchObject({ status: 400 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails.** Run: `cd server && npm test -- src/tts/clone-ingest.test.ts`
Expected: FAIL ("Cannot find module './clone-ingest.js'").

- [ ] **Step 3: Implement.**

```ts
// server/src/tts/clone-ingest.ts
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
    { sampleRate, durationSeconds: quality.durationSeconds, transcript, transcriptSource: 'whisper', captureMethod: opts.captureMethod },
    wav,
  );

  return { candidateId: opts.candidateId, transcript, durationSeconds: quality.durationSeconds, sampleRate, qualityWarnings: quality.warnings };
}
```

- [ ] **Step 4: Run test to verify it passes.** Run: `cd server && npm test -- src/tts/clone-ingest.test.ts`
Expected: PASS. (If the `expect.stringMatching` inside `toContain` is unsupported in this Vitest, switch that assertion to `expect(res.qualityWarnings.join(' ')).toMatch(/short/i)`.)

- [ ] **Step 5: Commit**

```bash
git add server/src/tts/clone-ingest.ts server/src/tts/clone-ingest.test.ts
git commit -m "feat(server): clone-sample ingest pipeline (decode+gate+wav+transcribe)"
```

---

### Task 6: `POST /clone-sample` route (multipart)

**Files:**
- Modify: `server/src/routes/voice-library.ts` (add the route + multer)
- Test: `server/src/routes/voice-library.test.ts` (add cases)

**Interfaces:**
- Consumes: `ingestCloneSample` (`../tts/clone-ingest.js`), `voiceSamplePublicUrl`-style preview is out of scope (no clip preview URL in 3a — return the candidateId only; `clipPreviewUrl` stays optional/absent).
- Produces: `POST /api/voice-library/clone-sample` → `202` `CloneSampleCandidate`.

- [ ] **Step 1: Write the failing test.** (Add to the existing suite; mock transcribe at module scope alongside the existing provider mock.)

```ts
// in server/src/routes/voice-library.test.ts — add near the other vi.mock calls:
const transcribeSegment = vi.fn().mockResolvedValue({ text: 'hello there', language: 'en', words: null, avgLogprob: null, noSpeechProb: null, compressionRatio: null });
vi.mock('../tts/transcribe-client.js', () => ({ transcribeSegment: (...a: unknown[]) => transcribeSegment(...a) }));

// ...and a new test (uses supertest .attach for multipart):
it('POST /clone-sample ingests an uploaded clip → 202 candidate', async () => {
  const { encodePcmToWav } = await import('../tts/wav.js');
  const n = 6 * 24_000;
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) pcm.writeInt16LE(i % 2 ? -8000 : 8000, i * 2);
  const wav = encodePcmToWav(pcm, 24_000);
  const res = await request(app)
    .post('/api/voice-library/clone-sample')
    .field('captureMethod', 'upload')
    .attach('audio', wav, 'sample.wav');
  expect(res.status).toBe(202);
  expect(res.body.candidateId).toBeTruthy();
  expect(res.body.transcript).toBe('hello there');
});

it('POST /clone-sample rejects a too-short clip → 400', async () => {
  const { encodePcmToWav } = await import('../tts/wav.js');
  const n = 2 * 24_000;
  const wav = encodePcmToWav(Buffer.alloc(n * 2, 40), 24_000);
  const res = await request(app).post('/api/voice-library/clone-sample').attach('audio', wav, 's.wav');
  expect(res.status).toBe(400);
});
```

- [ ] **Step 2: Run test to verify it fails.** Run: `cd server && npm test -- src/routes/voice-library.test.ts`
Expected: FAIL (404/route missing).

- [ ] **Step 3: Implement.** Add near the top of `voice-library.ts` (imports) and register the route. Follow the `cover.ts` multer idiom exactly.

```ts
// imports (top of voice-library.ts)
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { ingestCloneSample } from '../tts/clone-ingest.js';

const cloneUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// route (add alongside the other voiceLibraryRouter.post handlers)
voiceLibraryRouter.post(
  '/clone-sample',
  (req: Request, res: Response, next: (err?: unknown) => void) => {
    cloneUpload.single('audio')(req, res, (err: unknown) => {
      if (err) {
        if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({ error: 'Sample too large (max 25 MB).' });
        }
        return res.status(400).json({ error: (err as Error).message || 'Upload error.' });
      }
      next();
    });
  },
  async (req: Request, res: Response) => {
    try {
      const file = req.file;
      if (!file?.buffer?.length) return res.status(400).json({ error: 'No audio uploaded (use the "audio" field).' });
      const captureMethod = (req.body?.captureMethod === 'record' ? 'record' : 'upload') as 'record' | 'upload';
      const candidateId = randomUUID();
      const result = await ingestCloneSample(file.buffer, { captureMethod, candidateId });
      return res.status(202).json({ ...result, qualityWarnings: result.qualityWarnings });
    } catch (e) {
      const status = (e as { status?: number }).status ?? 502;
      return res.status(status).json({ error: (e as Error).message || 'Clone-sample ingest failed.' });
    }
  },
);
```

> NOTE: place `/clone-sample` **before** any `/:voiceUuid`-parameterized routes are matched? Express matches in registration order; `/clone-sample` is a literal segment and `/:voiceUuid` is a param at the same depth — a GET/POST to `/clone-sample` will match the literal only if registered first OR if the param route uses a different method. Register `/clone-sample` above `POST /:voiceUuid/...` handlers to be safe.

- [ ] **Step 4: Run test to verify it passes.** Run: `cd server && npm test -- src/routes/voice-library.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/voice-library.ts server/src/routes/voice-library.test.ts
git commit -m "feat(server): POST /voice-library/clone-sample ingest route"
```

---

### Task 7: Consent-at-write structure guard

**Files:**
- Modify: `server/src/workspace/voice-library.ts` (`writeEntry`)
- Test: `server/src/workspace/voice-library.test.ts` (create if absent, else add cases) — note the store may not have a colocated test yet; if not, create `server/src/workspace/voice-library.store.test.ts`.

**Interfaces:**
- Modifies: `writeEntry` throws `ConsentRequiredError` when `provenance==='cloned'` and consent is absent or structurally invalid; `revokedAt` is orthogonal (a revoke write passes).

- [ ] **Step 1: Write the failing test.**

```ts
// server/src/workspace/voice-library.store.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'vl-')); process.env.WORKSPACE_DIR = dir; });
afterEach(() => { delete process.env.WORKSPACE_DIR; rmSync(dir, { recursive: true, force: true }); });

const base = { voiceUuid: 'u1', name: 'Mum', tags: [], pinned: false, engines: {}, createdAt: 'x', updatedAt: 'x' };
const consent = { personName: 'Mum', relationship: 'family-with-permission' as const, permittedUse: 'personal' as const, attestedAt: 'x', attestedBy: 'me' };

it('rejects a cloned entry with no consent', async () => {
  const { writeEntry } = await import('./voice-library.js');
  await expect(writeEntry({ ...base, provenance: 'cloned' })).rejects.toThrow(/consent/i);
});
it('accepts a cloned entry with structurally-valid consent', async () => {
  const { writeEntry, readEntry } = await import('./voice-library.js');
  await writeEntry({ ...base, provenance: 'cloned', consent });
  expect((await readEntry('u1'))?.consent?.personName).toBe('Mum');
});
it('accepts a revoke write (revokedAt set) — orthogonal to the guard', async () => {
  const { writeEntry, readEntry } = await import('./voice-library.js');
  await writeEntry({ ...base, provenance: 'cloned', consent });
  await writeEntry({ ...base, provenance: 'cloned', consent: { ...consent, revokedAt: 'now' } });
  expect((await readEntry('u1'))?.consent?.revokedAt).toBe('now');
});
it('does not gate designed entries', async () => {
  const { writeEntry } = await import('./voice-library.js');
  await expect(writeEntry({ ...base, provenance: 'designed' })).resolves.toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails.** Run: `cd server && npm test -- src/workspace/voice-library.store.test.ts`
Expected: FAIL (cloned-without-consent currently writes fine).

- [ ] **Step 3: Implement.** In `voice-library.ts`, add the error + guard and call it at the top of `writeEntry`:

```ts
export class ConsentRequiredError extends Error {
  status = 422;
  constructor() {
    super('A cloned voice requires a consent record (person, relationship, permitted use, attestation).');
    this.name = 'ConsentRequiredError';
  }
}

function assertConsentForClone(entry: VoiceLibraryEntry): void {
  if (entry.provenance !== 'cloned') return;
  const c = entry.consent;
  const structurallyValid =
    !!c && !!c.personName && !!c.relationship && !!c.permittedUse && !!c.attestedAt && !!c.attestedBy;
  if (!structurallyValid) throw new ConsentRequiredError(); // revokedAt is orthogonal — not checked here
}

// at the very top of writeEntry(entry):
assertConsentForClone(entry);
```

- [ ] **Step 4: Run test to verify it passes.** Run: `cd server && npm test -- src/workspace/voice-library.store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/workspace/voice-library.ts server/src/workspace/voice-library.store.test.ts
git commit -m "feat(server): consent-structure guard on cloned writeEntry (revoke orthogonal)"
```

---

### Task 8: `POST /:voiceUuid/revoke` route

**Files:**
- Modify: `server/src/routes/voice-library.ts`
- Test: `server/src/routes/voice-library.test.ts`

**Interfaces:**
- Produces: `POST /api/voice-library/:voiceUuid/revoke` → `200` `VoiceLibraryEntry` (with `consent.revokedAt` stamped).

- [ ] **Step 1: Write the failing test.** (Seed a cloned entry directly via the store, then revoke it.)

```ts
it('POST /:uuid/revoke stamps revokedAt on a cloned entry', async () => {
  const { writeEntry } = await import('../workspace/voice-library.js');
  await writeEntry({
    voiceUuid: 'r1', name: 'Dad', provenance: 'cloned', tags: [], pinned: false, engines: {},
    consent: { personName: 'Dad', relationship: 'family-with-permission', permittedUse: 'personal', attestedAt: 'x', attestedBy: 'me' },
    createdAt: 'x', updatedAt: 'x',
  });
  const res = await request(app).post('/api/voice-library/r1/revoke');
  expect(res.status).toBe(200);
  expect(res.body.consent.revokedAt).toBeTruthy();
});
it('POST /:uuid/revoke 404s an unknown entry', async () => {
  const res = await request(app).post('/api/voice-library/nope/revoke');
  expect(res.status).toBe(404);
});
```

- [ ] **Step 2: Run test to verify it fails.** Run: `cd server && npm test -- src/routes/voice-library.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.**

```ts
voiceLibraryRouter.post('/:voiceUuid/revoke', async (req: Request, res: Response) => {
  try {
    const { voiceUuid } = req.params;
    const entry = await readEntry(voiceUuid);
    if (!entry) return res.status(404).json({ error: `No voice-library entry "${voiceUuid}".` });
    if (!entry.consent) return res.status(409).json({ error: 'Entry has no consent record to revoke.' });
    const updated = { ...entry, consent: { ...entry.consent, revokedAt: new Date().toISOString() } };
    await writeEntry(updated); // passes the guard — revokedAt is orthogonal (Task 7)
    return res.status(200).json(updated);
  } catch (e) {
    return res.status(502).json({ error: (e as Error).message || 'Revoke failed.' });
  }
});
```

- [ ] **Step 4: Run test to verify it passes.** Run: `cd server && npm test -- src/routes/voice-library.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/voice-library.ts server/src/routes/voice-library.test.ts
git commit -m "feat(server): POST /voice-library/:uuid/revoke consent revocation"
```

---

### Task 9: Sample-route consent gate (spec I5)

**Files:**
- Modify: `server/src/routes/voice-library.ts` (`POST /:voiceUuid/sample`)
- Test: `server/src/routes/voice-library.test.ts`

**Interfaces:**
- Modifies: the existing sample route returns `403` when the entry is `provenance:'cloned'` with absent or revoked consent — a revoked person's voice can never be spoken from the card's Play button.

- [ ] **Step 1: Write the failing test.**

```ts
it('POST /:uuid/sample 403s a revoked cloned voice', async () => {
  const { writeEntry } = await import('../workspace/voice-library.js');
  await writeEntry({
    voiceUuid: 's1', name: 'Gran', provenance: 'cloned', tags: [], pinned: false, engines: {},
    consent: { personName: 'Gran', relationship: 'family-with-permission', permittedUse: 'personal', attestedAt: 'x', attestedBy: 'me', revokedAt: 'yesterday' },
    createdAt: 'x', updatedAt: 'x',
  });
  const res = await request(app).post('/api/voice-library/s1/sample').send({});
  expect(res.status).toBe(403);
});
```

- [ ] **Step 2: Run test to verify it fails.** Run: `cd server && npm test -- src/routes/voice-library.test.ts`
Expected: FAIL (currently 200/synthesizes).

- [ ] **Step 3: Implement.** In the sample handler, immediately after `if (!entry) return res.status(404)...`:

```ts
if (entry.provenance === 'cloned' && (!entry.consent || entry.consent.revokedAt)) {
  return res.status(403).json({ error: 'This cloned voice has no valid consent and cannot be played.' });
}
```

- [ ] **Step 4: Run test to verify it passes.** Run: `cd server && npm test -- src/routes/voice-library.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/voice-library.ts server/src/routes/voice-library.test.ts
git commit -m "fix(server): gate voice-library sample route on cloned consent validity"
```

---

### Task 10: `VoiceProvenanceBadge` — 'Cloned' branch

**Files:**
- Modify: `src/components/voices/voice-provenance-badge.tsx`
- Test: `src/components/voices/voice-provenance-badge.test.tsx` (create if absent)

**Interfaces:**
- Modifies: the badge renders "Cloned" when `slot.provenance === 'cloned'` (checked before the `designed`/`Catalogue` fall-through, and independent of `libraryUuid`).

- [ ] **Step 1: Write the failing test.**

```tsx
// src/components/voices/voice-provenance-badge.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VoiceProvenanceBadge } from './voice-provenance-badge';

it('renders "Cloned" for a cloned slot', () => {
  render(<VoiceProvenanceBadge slot={{ name: 'qwen-x', provenance: 'cloned' }} />);
  expect(screen.getByText('Cloned')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails.** Run: `npm test -- src/components/voices/voice-provenance-badge.test.tsx`
Expected: FAIL (no 'Cloned' text).

- [ ] **Step 3: Implement.** Add a branch in the badge switch, before the `designed`/else branches:

```tsx
if (slot?.provenance === 'cloned') {
  return <span data-testid="voice-provenance-badge" className={/* reuse the existing badge classes */ badgeClass}>Cloned</span>;
}
```
(Match the exact class-name/markup pattern the file already uses for the "Designed"/"My voice" spans — copy that span, change the label to "Cloned".)

- [ ] **Step 4: Run test to verify it passes.** Run: `npm test -- src/components/voices/voice-provenance-badge.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/voices/voice-provenance-badge.tsx src/components/voices/voice-provenance-badge.test.tsx
git commit -m "feat(frontend): Cloned branch in VoiceProvenanceBadge"
```

---

### Task 11: Reusable recorder component

**Files:**
- Create: `src/components/voices/voice-recorder.tsx`
- Test: `src/components/voices/voice-recorder.test.tsx`

**Interfaces:**
- Produces: `<VoiceRecorder onRecorded={(blob: Blob) => void} />` — a self-contained record/re-take control with permission states and a level meter. Emits the recorded audio blob on stop. Touch targets ≥44×44 (`min-h-[44px] fine-pointer:min-h-0`).

- [ ] **Step 1: Write the failing test.** (Mock `getUserMedia` + `MediaRecorder`.)

```tsx
// src/components/voices/voice-recorder.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { VoiceRecorder } from './voice-recorder';

class FakeRecorder {
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  state = 'inactive';
  start() { this.state = 'recording'; }
  stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['x'], { type: 'audio/webm' }) }); this.onstop?.(); }
}

beforeEach(() => {
  (globalThis as any).MediaRecorder = FakeRecorder;
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] }) },
  });
});

it('records then emits a blob on stop', async () => {
  const onRecorded = vi.fn();
  render(<VoiceRecorder onRecorded={onRecorded} />);
  fireEvent.click(screen.getByRole('button', { name: /record/i }));
  await waitFor(() => expect(screen.getByRole('button', { name: /stop/i })).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: /stop/i }));
  await waitFor(() => expect(onRecorded).toHaveBeenCalledWith(expect.any(Blob)));
});

it('shows a permission-denied fallback', async () => {
  (navigator.mediaDevices.getUserMedia as any).mockRejectedValueOnce(new Error('denied'));
  render(<VoiceRecorder onRecorded={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: /record/i }));
  await waitFor(() => expect(screen.getByText(/mic/i)).toBeInTheDocument());
});
```

- [ ] **Step 2: Run test to verify it fails.** Run: `npm test -- src/components/voices/voice-recorder.test.tsx`
Expected: FAIL ("Cannot find module './voice-recorder'").

- [ ] **Step 3: Implement.** Minimal recorder (start/stop/re-take, permission state, blob emit). Level-meter can be a simple animated bar; keep it functional.

```tsx
// src/components/voices/voice-recorder.tsx
import { useRef, useState } from 'react';

type Phase = 'idle' | 'recording' | 'recorded' | 'denied';

export function VoiceRecorder({ onRecorded }: { onRecorded: (blob: Blob) => void }) {
  const [phase, setPhase] = useState<Phase>('idle');
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  async function start() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const rec = new MediaRecorder(stream);
      chunksRef.current = [];
      rec.ondataavailable = (e) => chunksRef.current.push(e.data);
      rec.onstop = () => {
        onRecorded(new Blob(chunksRef.current, { type: 'audio/webm' }));
        streamRef.current?.getTracks().forEach((t) => t.stop());
        setPhase('recorded');
      };
      recorderRef.current = rec;
      rec.start();
      setPhase('recording');
    } catch {
      setPhase('denied');
    }
  }
  function stop() { recorderRef.current?.stop(); }

  if (phase === 'denied') {
    return (
      <div className="text-sm text-magenta">
        Mic access was blocked. Enable microphone permission or use the Upload tab instead.
        <button className="ml-2 underline min-h-[44px] fine-pointer:min-h-0" onClick={() => setPhase('idle')}>Try again</button>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-3">
      {phase === 'recording'
        ? <button className="min-h-[44px] fine-pointer:min-h-0" onClick={stop}>Stop</button>
        : <button className="min-h-[44px] fine-pointer:min-h-0" onClick={start}>{phase === 'recorded' ? 'Re-record' : 'Record'}</button>}
      {phase === 'recording' && <span aria-hidden className="animate-pulse">●</span>}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes.** Run: `npm test -- src/components/voices/voice-recorder.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/voices/voice-recorder.tsx src/components/voices/voice-recorder.test.tsx
git commit -m "feat(frontend): reusable VoiceRecorder component (getUserMedia + MediaRecorder)"
```

---

### Task 12: Slice thunks + API real/mock pair + cloned fixture

**Files:**
- Modify: `src/store/voice-library-slice.ts` (add `cloneSample`, `revokeVoice` thunks + candidate/wizard state)
- Modify: `src/lib/api.ts` (real+mock `cloneVoiceSample`, `revokeVoiceLibraryEntry` + register in both objects)
- Modify: `src/mocks/voice-library.ts` (add one `provenance:'cloned'` fixture)
- Test: `src/store/voice-library-slice.clone.test.ts`

**Interfaces:**
- Consumes: `api.cloneVoiceSample(form: FormData)`, `api.revokeVoiceLibraryEntry(voiceUuid: string)`.
- Produces thunks: `cloneSample(form: FormData) → CloneSampleCandidate`; `revokeVoice(voiceUuid) → VoiceLibraryEntry` (refetches the library after).

- [ ] **Step 1: Write the failing test.**

```ts
// src/store/voice-library-slice.clone.test.ts
import { describe, it, expect, vi } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { voiceLibrarySlice, revokeVoice } from './voice-library-slice';

const revokeVoiceLibraryEntry = vi.fn().mockResolvedValue({ voiceUuid: 'r1', name: 'X', provenance: 'cloned', consent: { revokedAt: 'now' } });
const listVoiceLibrary = vi.fn().mockResolvedValue([]);
vi.mock('../lib/api', () => ({ api: { revokeVoiceLibraryEntry: (...a: unknown[]) => revokeVoiceLibraryEntry(...a), listVoiceLibrary: () => listVoiceLibrary() } }));

it('revokeVoice calls the api and refetches', async () => {
  const store = configureStore({ reducer: { voiceLibrary: voiceLibrarySlice.reducer } });
  await store.dispatch(revokeVoice('r1') as never);
  expect(revokeVoiceLibraryEntry).toHaveBeenCalledWith('r1');
  expect(listVoiceLibrary).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run test to verify it fails.** Run: `npm test -- src/store/voice-library-slice.clone.test.ts`
Expected: FAIL (`revokeVoice` not exported).

- [ ] **Step 3: Implement.**

In `src/lib/api.ts` — add the real+mock pair and register in both objects:

```ts
// real
async function realCloneVoiceSample(form: FormData): Promise<CloneSampleCandidate> {
  const res = await fetch('/api/voice-library/clone-sample', { method: 'POST', body: form });
  if (!res.ok) throw new Error(`Clone sample failed (${res.status}): ${(await res.text()) || res.statusText}`);
  return res.json();
}
async function realRevokeVoiceLibraryEntry(voiceUuid: string): Promise<VoiceLibraryEntry> {
  const res = await fetch(`/api/voice-library/${encodeURIComponent(voiceUuid)}/revoke`, { method: 'POST' });
  if (!res.ok) throw new Error(`Revoke failed (${res.status}): ${(await res.text()) || res.statusText}`);
  return res.json();
}
// mock
export async function mockCloneVoiceSample(_form: FormData): Promise<CloneSampleCandidate> {
  await wait(300);
  return { candidateId: `cand-${Math.random().toString(36).slice(2, 10)}`, transcript: 'the quick brown fox jumped', durationSeconds: 9, sampleRate: 24_000, qualityWarnings: [] };
}
export async function mockRevokeVoiceLibraryEntry(voiceUuid: string): Promise<VoiceLibraryEntry> {
  await wait(150);
  mockVoiceLibraryEntries = mockVoiceLibraryEntries.map((e) =>
    e.voiceUuid === voiceUuid && e.consent ? { ...e, consent: { ...e.consent, revokedAt: new Date().toISOString() } } : e);
  return mockVoiceLibraryEntries.find((e) => e.voiceUuid === voiceUuid)!;
}
```
Register: add `cloneVoiceSample: realCloneVoiceSample, revokeVoiceLibraryEntry: realRevokeVoiceLibraryEntry` to `realApi` (~`10007`) and the `mock*` counterparts to `mockApi` (~`10296`). Add `type CloneSampleCandidate = ApiComponents['schemas']['CloneSampleCandidate']` beside the other voice-library type aliases (~`api.ts:9392`).

In `src/store/voice-library-slice.ts` — add thunks:

```ts
export const cloneSample = createAsyncThunk('voiceLibrary/cloneSample', async (form: FormData) => {
  return api.cloneVoiceSample(form);
});
export const revokeVoice = createAsyncThunk('voiceLibrary/revoke', async (voiceUuid: string, { dispatch }) => {
  const entry = await api.revokeVoiceLibraryEntry(voiceUuid);
  await dispatch(fetchVoiceLibrary());
  return entry;
});
```
(Import `cloneVoiceSample`/`revokeVoiceLibraryEntry` are on `api`; import `CloneSampleCandidate` type from `../lib/api` if referenced.)

In `src/mocks/voice-library.ts` — add a cloned fixture to `MOCK_VOICE_LIBRARY_ENTRIES`:

```ts
{
  voiceUuid: 'lib-cloned-demo', name: 'Mum (cloned)', provenance: 'cloned', tags: [], pinned: false,
  consent: { personName: 'Mum', relationship: 'family-with-permission', permittedUse: 'personal', attestedAt: '2026-07-20T00:00:00Z', attestedBy: 'me' },
  master: { clipFile: 'master.wav', sampleRate: 24_000, durationSeconds: 12, transcript: 'demo', transcriptSource: 'whisper', captureMethod: 'record' },
  engines: {}, createdAt: '2026-07-20T00:00:00Z', updatedAt: '2026-07-20T00:00:00Z',
},
```

- [ ] **Step 4: Run test to verify it passes.** Run: `npm test -- src/store/voice-library-slice.clone.test.ts`
Expected: PASS. Then `npm run typecheck` to confirm the api registration is type-consistent.

- [ ] **Step 5: Commit**

```bash
git add src/store/voice-library-slice.ts src/lib/api.ts src/mocks/voice-library.ts src/store/voice-library-slice.clone.test.ts
git commit -m "feat(frontend): clone-sample + revoke thunks, api pair, cloned fixture"
```

---

### Task 13: Cloned voices in My voices (render + Revoke action)

**Files:**
- Modify: `src/components/voices/my-voices-section.tsx`
- Test: `src/components/voices/my-voices-section.clone.test.tsx`

**Interfaces:**
- Consumes: `selectMyVoices`, `revokeVoice` (slice); `VoiceProvenanceBadge`.
- Produces: cloned entries render in the My-voices grid with the 'Cloned' badge, a consent summary (person + relationship), and a **Revoke** button that dispatches `revokeVoice(uuid)` behind a confirm.

- [ ] **Step 1: Write the failing test.**

```tsx
// src/components/voices/my-voices-section.clone.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { voiceLibrarySlice } from '../../store/voice-library-slice';
import { MyVoicesSection } from './my-voices-section';

vi.mock('../../lib/api', () => ({ api: { listVoiceLibrary: () => Promise.resolve([]), revokeVoiceLibraryEntry: vi.fn() } }));

function storeWith(entries: unknown[]) {
  return configureStore({
    reducer: { voiceLibrary: voiceLibrarySlice.reducer },
    preloadedState: { voiceLibrary: { entries, status: 'ready', designPending: false, lastFetchedAt: 1 } as never },
  });
}

it('shows a cloned voice with its badge and a Revoke action', () => {
  const cloned = { voiceUuid: 'c1', name: 'Mum', provenance: 'cloned', tags: [], pinned: false, engines: {}, consent: { personName: 'Mum', relationship: 'family-with-permission', permittedUse: 'personal', attestedAt: 'x', attestedBy: 'me' }, createdAt: 'x', updatedAt: 'x' };
  render(<Provider store={storeWith([cloned])}><MyVoicesSection enabled /></Provider>);
  expect(screen.getByText('Cloned')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /revoke/i })).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails.** Run: `npm test -- src/components/voices/my-voices-section.clone.test.tsx`
Expected: FAIL (no 'Cloned' badge / Revoke button rendered).

- [ ] **Step 3: Implement.** In `my-voices-section.tsx`, in the entry card render, add a cloned branch: render `<VoiceProvenanceBadge slot={{ name: '', provenance: entry.provenance }} />`, the consent summary, and a Revoke button:

```tsx
{entry.provenance === 'cloned' && (
  <div className="mt-1 text-xs text-ink/70">
    <VoiceProvenanceBadge slot={{ name: '', provenance: 'cloned' }} />
    {entry.consent && <span className="ml-2">{entry.consent.personName} · {entry.consent.relationship}</span>}
    <button
      className="ml-2 underline min-h-[44px] fine-pointer:min-h-0"
      onClick={() => { if (window.confirm(`Revoke consent for "${entry.name}"? It will stop working immediately.`)) dispatch(revokeVoice(entry.voiceUuid)); }}
    >Revoke</button>
  </div>
)}
```
(Wire `const dispatch = useAppDispatch()` and import `revokeVoice` + `VoiceProvenanceBadge` if not already present.)

- [ ] **Step 4: Run test to verify it passes.** Run: `npm test -- src/components/voices/my-voices-section.clone.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/voices/my-voices-section.tsx src/components/voices/my-voices-section.clone.test.tsx
git commit -m "feat(frontend): render cloned voices in My voices with Revoke action"
```

---

### Task 14: Documentation & release notes

**Files:**
- Create: `docs/features/267-fs38-wave3-voice-clone.md` (regression plan; confirm the next free number with `ls docs/features` — 266 was fs-35, so 267 is the likely next)
- Modify: `docs/features/INDEX.md` (new entry under the voice area)
- Modify: `docs/features/194-voice-cloning.md` (spec M4: update the wave roadmap + drop "XTTS reference path first" DoD framing)
- Modify: `docs/release-notes-next.md` (technical entry, PR-refed)
- Modify: `RELEASE_NOTES.md` (brand-voice line in the in-progress version section)
- Modify: `docs/BACKLOG.md` (thin row for the wave, linking #624)

- [ ] **Step 1: Write the regression plan** from `docs/features/TEMPLATE.md`, `status: active`, covering: the 3a acceptance walkthrough (upload a clip → candidate returned; too-short → 400; cloned-without-consent write rejected; revoke stamps `revokedAt`; sample route 403 on revoked cloned; recorder permission-denied fallback), and a "Not in 3a (→ 3b1/3b2/3c)" boundary section. Cite the spec.

- [ ] **Step 2: Update `docs/features/194-voice-cloning.md`** — in the roadmap, mark data-model+capture as delivered (3a) and correct the "Qwen design-to-target"/"XTTS reference path first" ordering to match the spec's Qwen-first, four-sub-wave plan.

- [ ] **Step 3: Append the release-notes entries** — `docs/release-notes-next.md` (e.g. `- Voice cloning groundwork: sample ingest, consent, and recorder (behind the voice-library flag). (#624)`) and a matching brand-voice line in `RELEASE_NOTES.md`'s top in-progress section.

- [ ] **Step 4: Add the INDEX + BACKLOG rows.**

- [ ] **Step 5: Commit**

```bash
git add docs/features/267-fs38-wave3-voice-clone.md docs/features/INDEX.md docs/features/194-voice-cloning.md docs/release-notes-next.md RELEASE_NOTES.md docs/BACKLOG.md
git commit -m "docs(docs): fs-38 3a regression plan + release notes + doc-194 update"
```

---

## Final verification (before the PR)

- [ ] **Full server suite:** `cd server && npm test` — green.
- [ ] **Full frontend suite:** `npm test` — green.
- [ ] **Typecheck:** `npm run typecheck` — green (proves the api registration + generated types line up).
- [ ] **Branch-scoped gate:** `npm run verify:fast:branch`.
- [ ] **E2E (add one spec):** an upload-path phase-1 golden path is deferred with the wizard to 3b1 (3a ships no wired wizard entry point). If time allows, add a component-level RTL test that a cloned fixture appears in My voices with a working Revoke — already covered by Task 13. No new Playwright spec is required for 3a; note this explicitly in the PR ("e2e lands with the wizard in 3b1").
- [ ] **PR:** body links `Refs #624` (partial delivery — 3a of four sub-waves), links the regression plan and the spec, and states the disclosed behind-flag scope (consent guard / revoke / cloned UI have no reachable caller until 3b1). Run the mandatory `code-review` pass (medium effort — multi-scope `feat`).

## Self-review notes (author)

- **Spec coverage (3a rows of §1.1):** ingest ✔ T5/T6, quality gate ✔ T3, Whisper transcript ✔ T5, `master.wav` write ✔ T2/T4/T5, OpenAPI schema ✔ T1, consent-at-write guard ✔ T7, wizard phase-1 building blocks ✔ T10–T13 (recorder + capture surfaces + slice; full wizard assembly is 3b1 by the disclosed refinement), cloned-section UI shell ✔ T13, sample-route consent gate ✔ T9, cross-book exclusion — **already shipped in Wave 1** (spec §4.4), no task. Revoke ✔ T8.
- **No placeholders:** every code step carries real code; the only deferred item (e2e golden path) is explicitly assigned to 3b1 with rationale, not left as a TODO.
- **Type consistency:** `CloneSampleCandidate`, `VoiceMaster`, `CloneCandidateMaster`, `assessCloneSample`/`CloneQuality`, `ingestCloneSample`/`CloneSampleCandidateResult`, `cloneSample`/`revokeVoice` thunks, `cloneVoiceSample`/`revokeVoiceLibraryEntry` api calls — names are consistent across tasks 1–13.
