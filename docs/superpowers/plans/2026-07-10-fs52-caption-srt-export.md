# fs-52 — Caption/SRT export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `.srt`/`.vtt` caption export (line/sentence/word granularity, whole-book or per-chapter scope) as a new format in the existing `BookExportJob` queue, from data already on disk after a render.

**Architecture:** Line/sentence captions are pure metadata transforms over the already-written `<slug>.segments.json` + `manuscript-edits.json` — no new data, no audio decode. Word captions add one new sidecar capability (Whisper `word_timestamps`) and run one whole-chapter ASR pass at export time only. A new `server/src/export/build-captions.ts` (+ two small pure helper modules) slots into `server/src/routes/export.ts` exactly like `build-m4b.ts`/`build-mp3-zip.ts` already do — both caption scopes (`whole-book` single file, `per-chapter` zip) are single-artifact builds, so no new job-lifecycle branch is needed in `runExportJob`, only a new dispatch arm.

**Tech Stack:** TypeScript/Express (server), Python/FastAPI + faster-whisper (sidecar), React/Redux Toolkit (frontend), Vitest, pytest, Playwright.

## Global Constraints

- Spec of record: `docs/superpowers/specs/2026-07-10-fs52-caption-srt-export-design.md` (both revision rounds already folded in — read it once before starting; every task below cites it by section).
- Sentence text for line/sentence captions MUST come from `manuscript-edits.json` (`manuscriptEditsJsonPath(bookDir)`), never the analysis cache — durability fix, spec §2.
- Word-mode ASR runs ONE whole-chapter `/transcribe` call per chapter, never per-sentence — spec §2.
- Word-mode decode profile passes `condition_on_previous_text=True` (diverges from the QA path's `False`) — spec §2, user decision.
- Line-mode fold caps at ~7s duration OR ~200 chars, whichever first, and always closes on a speaker change — spec §4, user decision.
- No silent fallback to estimated/proportional timing when Whisper is unavailable — job fails with a clear `errorReason` instead — spec §3.
- `format: 'captions'` extends the existing `BookExportRequest`/`BookExportJob` — never build a parallel export subsystem.
- OpenAPI is the type source of truth (CLAUDE.md) — schema changes land in `openapi.yaml` first, then `npm run openapi:types` regenerates `src/lib/api-types.ts`. Never hand-edit generated types.
- Every task lands its own test(s) in the same commit as the code it covers (TDD: failing test → pass → commit).

---

## Task 1: Sidecar — word-level timestamps in WhisperEngine + `/transcribe`

**Files:**
- Modify: `server/tts-sidecar/main.py` (`WhisperEngine.transcribe`, `/transcribe` route — currently lines 3519–3553 and 5852–5906)
- Test: `server/tts-sidecar/tests/test_transcribe.py`

**Interfaces:**
- Consumes: nothing new.
- Produces: `WhisperEngine.transcribe(pcm: bytes, sample_rate: int, language: Optional[str] = None, word_timestamps: bool = False) -> dict[str, Any]` — response dict gains a `"words"` key: `list[{"word": str, "start": float, "end": float}] | None` (`None` when `word_timestamps=False`). `/transcribe` route reads request header `X-Word-Timestamps` (any value → truthy) and forwards it.

- [ ] **Step 1: Write the failing tests**

Add to `server/tts-sidecar/tests/test_transcribe.py`, in the `# ── transcribe ──` section, right after `test_transcribe_uses_deterministic_decode_params`:

```python
def test_transcribe_word_timestamps_off_by_default(fake_whisper_module) -> None:
    """Default call (QA path) never requests word timestamps and keeps the
    deterministic no-carryover decode — unchanged behaviour."""
    engine = main.WhisperEngine()
    out = engine.transcribe(_pcm(), 24000)
    call = fake_whisper_module.instances[-1].transcribe_calls[-1]
    assert call["word_timestamps"] is False
    assert call["condition_on_previous_text"] is False
    assert out["words"] is None


def test_transcribe_word_timestamps_enables_caption_decode_profile(fake_whisper_module) -> None:
    """word_timestamps=True (the caption path) passes word_timestamps through
    to faster-whisper AND flips condition_on_previous_text to True — a
    distinct, separately-justified profile from the QA path's False."""
    fake_whisper_module.next_segments = [
        _FakeSegment(
            " Hello world.",
            words=[
                _FakeWord("Hello", 0.0, 0.4),
                _FakeWord("world.", 0.4, 0.9),
            ],
        ),
    ]
    engine = main.WhisperEngine()
    out = engine.transcribe(_pcm(), 24000, word_timestamps=True)
    call = fake_whisper_module.instances[-1].transcribe_calls[-1]
    assert call["word_timestamps"] is True
    assert call["condition_on_previous_text"] is True
    assert out["words"] == [
        {"word": "Hello", "start": 0.0, "end": 0.4},
        {"word": "world.", "start": 0.4, "end": 0.9},
    ]
```

Add the `_FakeWord` helper class right above `_FakeSegment` and give `_FakeSegment` a `words` attribute:

```python
class _FakeWord:
    """Stand-in for a faster-whisper Word — the attrs WhisperEngine reads
    when word_timestamps is requested."""

    def __init__(self, word: str, start: float, end: float) -> None:
        self.word = word
        self.start = start
        self.end = end
```

Then change `_FakeSegment.__init__` to accept and store `words`:

```python
class _FakeSegment:
    """Stand-in for a faster-whisper segment — just the attrs WhisperEngine
    reads."""

    def __init__(
        self,
        text: str,
        avg_logprob: float = -0.2,
        no_speech_prob: float = 0.01,
        compression_ratio: float = 1.3,
        words: Optional[list["_FakeWord"]] = None,
    ) -> None:
        self.text = text
        self.avg_logprob = avg_logprob
        self.no_speech_prob = no_speech_prob
        self.compression_ratio = compression_ratio
        self.words = words
```

Also add two route-level tests alongside the existing `asr_client`-fixture route tests (`test_transcribe_route_returns_text_and_signals` etc., currently lines 255–279) — reuse that exact fixture rather than a raw `TestClient(main.app)`, since it swaps in a fresh `main.ASR` per test (avoiding order-dependent state leaking across the pytest session):

```python
def test_transcribe_route_forwards_word_timestamps_header(asr_client, fake_whisper_module) -> None:
    """The X-Word-Timestamps request header threads through to the engine
    call and the words[] field reaches the JSON response."""
    client, _engine = asr_client
    fake_whisper_module.next_segments = [
        _FakeSegment(" Hi.", words=[_FakeWord("Hi.", 0.0, 0.3)]),
    ]
    resp = client.post(
        "/transcribe",
        content=_pcm(),
        headers={"X-Sample-Rate": "24000", "X-Word-Timestamps": "1"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["words"] == [{"word": "Hi.", "start": 0.0, "end": 0.3}]
    call = fake_whisper_module.instances[-1].transcribe_calls[-1]
    assert call["word_timestamps"] is True


def test_transcribe_route_omits_word_timestamps_by_default(asr_client) -> None:
    client, _engine = asr_client
    resp = client.post(
        "/transcribe",
        content=_pcm(),
        headers={"X-Sample-Rate": "24000"},
    )
    assert resp.status_code == 200
    assert resp.json()["words"] is None
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server/tts-sidecar && .\.venv\Scripts\python.exe -m pytest tests/test_transcribe.py -v -k word_timestamps`
Expected: FAIL — `TypeError: transcribe() got an unexpected keyword argument 'word_timestamps'` (and the route test fails the same way via the 500 it produces).

- [ ] **Step 3: Implement — widen `WhisperEngine.transcribe`**

In `server/tts-sidecar/main.py`, replace the `transcribe` method (currently lines 3519–3553):

```python
    def transcribe(
        self, pcm: bytes, sample_rate: int, language: Optional[str] = None,
        word_timestamps: bool = False,
    ) -> dict[str, Any]:
        """Transcribe one clip's PCM. Returns the text plus Whisper's
        intrinsic signals — `avg_logprob` (lower = less confident),
        `no_speech_prob` (higher = more likely silence), `compression_ratio`
        (higher = repetition/loop hallucination) — aggregated worst-case across
        segments so the server can tell "audio is wrong" from "transcript is
        untrustworthy" without re-deriving them.

        `word_timestamps=True` (fs-52 caption export, whole-chapter calls
        only) requests faster-whisper's per-word alignment AND switches
        `condition_on_previous_text` to True — a distinct, caption-tuned
        decode profile from the QA path's deterministic-idempotent one below.
        Captions want cross-window coherence on a long chapter; the QA path
        wants no cross-sentence hallucination carryover on an isolated clip.
        The two call sites never overlap (only the caption export path ever
        sets word_timestamps), so this is additive, not a behaviour change
        for the existing QA caller."""
        self._ensure_loaded()
        assert self._model is not None
        audio = self._pcm_to_float32_16k(pcm, sample_rate)
        with self._infer_lock:
            self._last_used = time.monotonic()
            segments, info = self._model.transcribe(
                audio,
                language=language,
                beam_size=1,                     # greedy
                temperature=0.0,                 # deterministic → idempotent verdicts
                condition_on_previous_text=word_timestamps,  # True only for captions
                vad_filter=True,                 # drop non-speech so silence isn't "transcribed"
                word_timestamps=word_timestamps,
            )
            segs = list(segments)
        text = " ".join((s.text or "").strip() for s in segs).strip()
        logprobs = [s.avg_logprob for s in segs if s.avg_logprob is not None]
        no_speech = [s.no_speech_prob for s in segs if s.no_speech_prob is not None]
        compression = [s.compression_ratio for s in segs if s.compression_ratio is not None]
        words: Optional[list[dict[str, Any]]] = None
        if word_timestamps:
            words = [
                {"word": w.word, "start": w.start, "end": w.end}
                for s in segs
                for w in (s.words or [])
            ]
        return {
            "text": text,
            "language": getattr(info, "language", language),
            # Worst-case aggregation: the weakest segment governs the verdict.
            "avg_logprob": (min(logprobs) if logprobs else None),
            "no_speech_prob": (max(no_speech) if no_speech else None),
            "compression_ratio": (max(compression) if compression else None),
            "words": words,
        }
```

- [ ] **Step 4: Implement — thread the header through `/transcribe`**

In `server/tts-sidecar/main.py`, inside the `/transcribe` route (currently lines 5852–5906), after the existing `language = req.headers.get("X-Language") or None` line, add:

```python
    word_timestamps = req.headers.get("X-Word-Timestamps") is not None
```

And change the call:

```python
    try:
        result = await asyncio.to_thread(
            ASR.transcribe, pcm, sample_rate, language, word_timestamps
        )
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server/tts-sidecar && .\.venv\Scripts\python.exe -m pytest tests/test_transcribe.py -v`
Expected: PASS (all tests in the file, including the pre-existing ones — `condition_on_previous_text` for the default path must still assert `False`, which the new `condition_on_previous_text=word_timestamps` line preserves since `word_timestamps` defaults to `False`).

- [ ] **Step 6: Commit**

```bash
git add server/tts-sidecar/main.py server/tts-sidecar/tests/test_transcribe.py
git commit -m "feat(sidecar): add word_timestamps to WhisperEngine.transcribe + /transcribe"
```

---

## Task 2: Server — `transcribe-client.ts` word-timestamps option

**Files:**
- Modify: `server/src/tts/transcribe-client.ts`
- Modify: `server/src/tts/transcribe-client.test.ts`

**Interfaces:**
- Consumes: Task 1's `/transcribe` wire contract (`X-Word-Timestamps` header, `words` response field).
- Produces: `TranscribeOptions.wordTimestamps?: boolean`; `TranscribeResult.words: Array<{word: string; start: number; end: number}> | null`.

- [ ] **Step 1: Write the failing test**

Add to `server/src/tts/transcribe-client.test.ts`, inside the `describe('transcribeSegment', ...)` block:

```ts
  it('sets X-Word-Timestamps and maps the words[] field when wordTimestamps is requested', async () => {
    let captured: { init: { headers: Record<string, string> } } | null = null;
    mockFetch.mockImplementation((async (_url: string, init: { headers: Record<string, string> }) => {
      captured = { init };
      return jsonResponse({
        text: 'Hello world.',
        language: 'en',
        avg_logprob: -0.2,
        no_speech_prob: 0.01,
        compression_ratio: 1.2,
        words: [
          { word: 'Hello', start: 0, end: 0.4 },
          { word: 'world.', start: 0.4, end: 0.9 },
        ],
      });
    }) as unknown as typeof undiciFetch);

    const result = await transcribeSegment(PCM, 16000, {
      wordTimestamps: true,
      sidecarUrl: URL,
    });

    expect(captured?.init.headers['x-word-timestamps']).toBe('1');
    expect(result.words).toEqual([
      { word: 'Hello', start: 0, end: 0.4 },
      { word: 'world.', start: 0.4, end: 0.9 },
    ]);
  });

  it('omits X-Word-Timestamps and returns words: null when not requested', async () => {
    let captured: { init: { headers: Record<string, string> } } | null = null;
    mockFetch.mockImplementation((async (_url: string, init: { headers: Record<string, string> }) => {
      captured = { init };
      return jsonResponse({ text: 'Hi.', language: 'en' });
    }) as unknown as typeof undiciFetch);

    const result = await transcribeSegment(PCM, 16000, { sidecarUrl: URL });

    expect(captured?.init.headers['x-word-timestamps']).toBeUndefined();
    expect(result.words).toBeNull();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/tts/transcribe-client.test.ts`
Expected: FAIL — `Object literal may only specify known properties, and 'wordTimestamps' does not exist in type 'TranscribeOptions'` (or a runtime `result.words` is `undefined` mismatch).

- [ ] **Step 3: Implement**

In `server/src/tts/transcribe-client.ts`, update the interfaces and body:

```ts
export interface TranscribeResult {
  text: string;
  language: string | null;
  avgLogprob: number | null;
  noSpeechProb: number | null;
  compressionRatio: number | null;
  /** fs-52 — per-word timestamps, present only when `wordTimestamps` was
      requested. `null` otherwise (including on a sidecar that predates the
      field). Chapter/clip-relative seconds, matching whatever PCM was sent. */
  words: Array<{ word: string; start: number; end: number }> | null;
}

export interface TranscribeOptions {
  language?: string | null;
  signal?: AbortSignal;
  sidecarUrl?: string;
  /** fs-52 — request per-word alignment from Whisper. Only the caption
      export path sets this; the QA gate never does. */
  wordTimestamps?: boolean;
}
```

Update `transcribeSegment`'s header block:

```ts
  const headers: Record<string, string> = {
    'content-type': 'audio/L16',
    'x-sample-rate': String(sampleRate),
  };
  const lang = normalizeWhisperLanguage(opts.language);
  if (lang) headers['x-language'] = lang;
  if (opts.wordTimestamps) headers['x-word-timestamps'] = '1';
```

And the response mapping:

```ts
    const body = (await response.json()) as {
      text?: unknown;
      language?: unknown;
      avg_logprob?: unknown;
      no_speech_prob?: unknown;
      compression_ratio?: unknown;
      words?: unknown;
    };
    return {
      text: typeof body.text === 'string' ? body.text : '',
      language: typeof body.language === 'string' ? body.language : null,
      avgLogprob: numOrNull(body.avg_logprob),
      noSpeechProb: numOrNull(body.no_speech_prob),
      compressionRatio: numOrNull(body.compression_ratio),
      words: Array.isArray(body.words)
        ? (body.words as Array<{ word: string; start: number; end: number }>)
        : null,
    };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/tts/transcribe-client.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/tts/transcribe-client.ts server/src/tts/transcribe-client.test.ts
git commit -m "feat(server): thread word-timestamps option through transcribeSegment"
```

---

## Task 3: Server — durable sentence-text loader (`manuscript-edits.json`)

**Files:**
- Create: `server/src/export/manuscript-sentences.ts`
- Create: `server/src/export/manuscript-sentences.test.ts`

**Interfaces:**
- Consumes: `manuscriptEditsJsonPath(bookDir)` (`server/src/workspace/paths.ts`), `readJson` (`server/src/workspace/state-io.ts`), `SentenceOutput` (`server/src/handoff/schemas.ts`).
- Produces: `loadManuscriptSentencesByChapter(bookDir: string): Promise<Record<number, Record<number, SentenceOutput>> | null>` — `null` means the file is missing/empty (caller turns that into a clear export failure, spec §2 "Missing manuscript-edits.json").

- [ ] **Step 1: Write the failing test**

Create `server/src/export/manuscript-sentences.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadManuscriptSentencesByChapter } from './manuscript-sentences.js';

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function makeBookDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'manuscript-sentences-test-'));
  dirs.push(root);
  mkdirSync(join(root, '.audiobook'), { recursive: true });
  return root;
}

describe('loadManuscriptSentencesByChapter', () => {
  it('groups sentences by chapterId then sentence id', async () => {
    const bookDir = makeBookDir();
    writeFileSync(
      join(bookDir, '.audiobook', 'manuscript-edits.json'),
      JSON.stringify({
        sentences: [
          { id: 1, chapterId: 1, characterId: 'narrator', text: 'It was a dark night.' },
          { id: 2, chapterId: 1, characterId: 'mira', text: 'Who goes there?' },
          { id: 1, chapterId: 2, characterId: 'narrator', text: 'Chapter two begins.' },
        ],
      }),
    );

    const result = await loadManuscriptSentencesByChapter(bookDir);

    expect(result).not.toBeNull();
    expect(result![1][1].text).toBe('It was a dark night.');
    expect(result![1][2].characterId).toBe('mira');
    expect(result![2][1].text).toBe('Chapter two begins.');
  });

  it('returns null when manuscript-edits.json is absent', async () => {
    const bookDir = makeBookDir();
    const result = await loadManuscriptSentencesByChapter(bookDir);
    expect(result).toBeNull();
  });

  it('returns null when the sentences array is empty', async () => {
    const bookDir = makeBookDir();
    writeFileSync(
      join(bookDir, '.audiobook', 'manuscript-edits.json'),
      JSON.stringify({ sentences: [] }),
    );
    const result = await loadManuscriptSentencesByChapter(bookDir);
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/export/manuscript-sentences.test.ts`
Expected: FAIL — `Cannot find module './manuscript-sentences.js'`

- [ ] **Step 3: Implement**

Create `server/src/export/manuscript-sentences.ts`:

```ts
/* fs-52 — durable sentence-text source for caption export. Sentence text for
   line/sentence captions comes from `manuscript-edits.json`, NOT the
   analysis cache (`server/handoff/cache/{manuscriptId}.json`): that cache is
   install-relative, transient-by-design resumable-analysis scratch space,
   and doesn't travel with the book if the workspace moves to another
   machine. `manuscript-edits.json` lives durably inside the book's own
   `.audiobook/` directory and already carries the `{id, chapterId,
   characterId, text}` shape needed — the same file `rebuildCacheFromEdits`
   (`../store/analysis-cache-rebuild.ts`) treats as the source of truth when
   the analysis cache itself is stale or absent.

   See docs/superpowers/specs/2026-07-10-fs52-caption-srt-export-design.md §2. */

import { manuscriptEditsJsonPath } from '../workspace/paths.js';
import { readJson } from '../workspace/state-io.js';
import type { SentenceOutput } from '../handoff/schemas.js';

interface EditsFile {
  sentences?: SentenceOutput[];
}

export async function loadManuscriptSentencesByChapter(
  bookDir: string,
): Promise<Record<number, Record<number, SentenceOutput>> | null> {
  const edits = await readJson<EditsFile>(manuscriptEditsJsonPath(bookDir));
  const sentences = edits?.sentences ?? [];
  if (sentences.length === 0) return null;
  const byChapter: Record<number, Record<number, SentenceOutput>> = {};
  for (const s of sentences) {
    (byChapter[s.chapterId] ??= {})[s.id] = s;
  }
  return byChapter;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/export/manuscript-sentences.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/export/manuscript-sentences.ts server/src/export/manuscript-sentences.test.ts
git commit -m "feat(server): add durable manuscript-edits.json sentence-text loader for captions"
```

---

## Task 4: Server — SRT/VTT pure formatters

**Files:**
- Create: `server/src/export/caption-format.ts`
- Create: `server/src/export/caption-format.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces: `CaptionCue { startSec: number; endSec: number; text: string; speaker?: string }`; `writeSrt(cues: CaptionCue[]): string`; `writeVtt(cues: CaptionCue[]): string`.

- [ ] **Step 1: Write the failing test**

Create `server/src/export/caption-format.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { writeSrt, writeVtt, type CaptionCue } from './caption-format.js';

const CUES: CaptionCue[] = [
  { startSec: 0, endSec: 2.5, text: 'It was a dark night.', speaker: 'Narrator' },
  { startSec: 2.5, endSec: 4.125, text: 'Who goes there?', speaker: 'Mira' },
];

describe('writeSrt', () => {
  it('numbers cues sequentially and formats HH:MM:SS,mmm timestamps', () => {
    const out = writeSrt(CUES);
    expect(out).toBe(
      '1\n' +
        '00:00:00,000 --> 00:00:02,500\n' +
        'Narrator: It was a dark night.\n' +
        '\n' +
        '2\n' +
        '00:00:02,500 --> 00:00:04,125\n' +
        'Mira: Who goes there?\n' +
        '\n',
    );
  });

  it('omits the speaker prefix when speaker is absent', () => {
    const out = writeSrt([{ startSec: 0, endSec: 1, text: 'Hello.' }]);
    expect(out).toContain('Hello.\n');
    expect(out).not.toContain(':');
  });

  it('handles an hour+ timestamp', () => {
    const out = writeSrt([{ startSec: 3661.2, endSec: 3662, text: 'Later.' }]);
    expect(out).toContain('01:01:01,200 --> 01:01:02,000');
  });
});

describe('writeVtt', () => {
  it('emits a WEBVTT header and dot-separated milliseconds', () => {
    const out = writeVtt(CUES);
    expect(out.startsWith('WEBVTT\n\n')).toBe(true);
    expect(out).toContain('00:00:00.000 --> 00:00:02.500');
    expect(out).toContain('Narrator: It was a dark night.');
    expect(out).not.toMatch(/^\d+\n/m); // no SRT-style sequence numbers
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/export/caption-format.test.ts`
Expected: FAIL — `Cannot find module './caption-format.js'`

- [ ] **Step 3: Implement**

Create `server/src/export/caption-format.ts`:

```ts
/* fs-52 — pure SRT/VTT formatters. No I/O; every caption cue is fully
   resolved (timing + text + optional speaker) before it reaches here. See
   docs/superpowers/specs/2026-07-10-fs52-caption-srt-export-design.md §4. */

export interface CaptionCue {
  startSec: number;
  endSec: number;
  text: string;
  speaker?: string;
}

function cueText(cue: CaptionCue): string {
  return cue.speaker ? `${cue.speaker}: ${cue.text}` : cue.text;
}

function pad(n: number, width: number): string {
  return String(Math.floor(n)).padStart(width, '0');
}

function formatTimestamp(totalSec: number, msSeparator: ',' | '.'): string {
  const totalMs = Math.round(totalSec * 1000);
  const ms = totalMs % 1000;
  const totalSecondsInt = Math.floor(totalMs / 1000);
  const s = totalSecondsInt % 60;
  const m = Math.floor(totalSecondsInt / 60) % 60;
  const h = Math.floor(totalSecondsInt / 3600);
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}${msSeparator}${pad(ms, 3)}`;
}

export function writeSrt(cues: CaptionCue[]): string {
  return cues
    .map((cue, i) => {
      const start = formatTimestamp(cue.startSec, ',');
      const end = formatTimestamp(cue.endSec, ',');
      return `${i + 1}\n${start} --> ${end}\n${cueText(cue)}\n\n`;
    })
    .join('');
}

export function writeVtt(cues: CaptionCue[]): string {
  const body = cues
    .map((cue) => {
      const start = formatTimestamp(cue.startSec, '.');
      const end = formatTimestamp(cue.endSec, '.');
      return `${start} --> ${end}\n${cueText(cue)}\n\n`;
    })
    .join('');
  return `WEBVTT\n\n${body}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/export/caption-format.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/export/caption-format.ts server/src/export/caption-format.test.ts
git commit -m "feat(server): add pure SRT/VTT caption formatters"
```

---

## Task 5: Server — sentence & line cue builders (title-beat + bounded fold)

**Files:**
- Create: `server/src/export/caption-cues.ts`
- Create: `server/src/export/caption-cues.test.ts`

**Interfaces:**
- Consumes: `CaptionCue` (Task 4, `./caption-format.js`), `textHashForStale` (`server/src/audio/segments-io.ts`).
- Produces: `SegmentInput { characterId: string; sentenceIds: number[]; startSec: number; endSec: number; kind?: 'title'; textHash?: string }`; `buildSentenceCues(segments, sentenceText, speakerNames, chapterTitle): CaptionCue[]`; `buildLineCues(segments, sentenceText, speakerNames, chapterTitle): CaptionCue[]`; `hasUnverifiableTextHash(segments): boolean`; constants `LINE_MAX_DURATION_SEC = 7`, `LINE_MAX_CHARS = 200` (exported for the test). Both cue builders throw when a segment's `textHash` no longer matches its current manuscript text (chapter edited since last render, not re-rendered) — a plan-review finding: joining current text onto stored render-time timing is silently wrong otherwise. `hasUnverifiableTextHash` (round-2-of-plan-review decision) flags the separate "can't tell" case — a pre-#1105 render with no `textHash` at all — so Task 7 can attach a non-fatal warning rather than silently treating "unverifiable" the same as "verified fresh."

- [ ] **Step 1: Write the failing tests**

Create `server/src/export/caption-cues.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { textHashForStale } from '../audio/segments-io.js';
import {
  buildSentenceCues,
  buildLineCues,
  hasUnverifiableTextHash,
  LINE_MAX_DURATION_SEC,
  LINE_MAX_CHARS,
  type SegmentInput,
} from './caption-cues.js';

const SPEAKERS = { narrator: 'Narrator', mira: 'Mira' };

describe('buildSentenceCues', () => {
  it('emits one cue per segment, including the title beat', () => {
    const segments: SegmentInput[] = [
      { characterId: 'narrator', sentenceIds: [], startSec: 0, endSec: 1.5, kind: 'title' },
      { characterId: 'narrator', sentenceIds: [1], startSec: 1.5, endSec: 3.2 },
      { characterId: 'mira', sentenceIds: [2], startSec: 3.2, endSec: 4.0 },
    ];
    const text = { 1: 'It was a dark night.', 2: 'Who goes there?' };
    const cues = buildSentenceCues(segments, text, SPEAKERS, 'Chapter One');

    expect(cues).toHaveLength(3);
    expect(cues[0]).toEqual({ startSec: 0, endSec: 1.5, text: 'Chapter One' });
    expect(cues[1]).toEqual({
      startSec: 1.5,
      endSec: 3.2,
      text: 'It was a dark night.',
      speaker: 'Narrator',
    });
    expect(cues[2].speaker).toBe('Mira');
  });

  it('throws a clear error when a sentence id has no matching text', () => {
    const segments: SegmentInput[] = [
      { characterId: 'narrator', sentenceIds: [99], startSec: 0, endSec: 1 },
    ];
    expect(() => buildSentenceCues(segments, {}, SPEAKERS, 'Chapter One')).toThrow(/sentence 99/);
  });

  it('throws when a segment textHash no longer matches the current manuscript text (edited-since-render)', () => {
    const segments: SegmentInput[] = [
      {
        characterId: 'narrator',
        sentenceIds: [1],
        startSec: 0,
        endSec: 1,
        textHash: textHashForStale('The original rendered sentence.'),
      },
    ];
    // Text has since been edited in the manuscript but the chapter was
    // never re-rendered — the stored textHash no longer matches.
    const text = { 1: 'An edited sentence the audio never actually said.' };
    expect(() => buildSentenceCues(segments, text, SPEAKERS, 'Chapter One')).toThrow(
      /edited after it last rendered/,
    );
  });

  it('does not throw when textHash matches the current text', () => {
    const original = 'It was a dark night.';
    const segments: SegmentInput[] = [
      { characterId: 'narrator', sentenceIds: [1], startSec: 0, endSec: 1, textHash: textHashForStale(original) },
    ];
    expect(() => buildSentenceCues(segments, { 1: original }, SPEAKERS, 'Chapter One')).not.toThrow();
  });

  it('does not check staleness when textHash is absent (pre-#1105 renders)', () => {
    const segments: SegmentInput[] = [
      { characterId: 'narrator', sentenceIds: [1], startSec: 0, endSec: 1 },
    ];
    expect(() => buildSentenceCues(segments, { 1: 'Anything at all.' }, SPEAKERS, 'Chapter One')).not.toThrow();
  });
});

describe('hasUnverifiableTextHash', () => {
  it('is true when any non-title segment lacks textHash', () => {
    const segments: SegmentInput[] = [
      { characterId: 'narrator', sentenceIds: [1], startSec: 0, endSec: 1, textHash: 'abc' },
      { characterId: 'narrator', sentenceIds: [2], startSec: 1, endSec: 2 },
    ];
    expect(hasUnverifiableTextHash(segments)).toBe(true);
  });

  it('is false when every non-title segment has textHash', () => {
    const segments: SegmentInput[] = [
      { characterId: 'narrator', sentenceIds: [1], startSec: 0, endSec: 1, textHash: 'abc' },
      { characterId: 'narrator', sentenceIds: [2], startSec: 1, endSec: 2, textHash: 'def' },
    ];
    expect(hasUnverifiableTextHash(segments)).toBe(false);
  });

  it('ignores the title beat, which never carries textHash by design', () => {
    const segments: SegmentInput[] = [
      { characterId: 'narrator', sentenceIds: [], startSec: 0, endSec: 1, kind: 'title' },
      { characterId: 'narrator', sentenceIds: [1], startSec: 1, endSec: 2, textHash: 'abc' },
    ];
    expect(hasUnverifiableTextHash(segments)).toBe(false);
  });
});

describe('buildLineCues', () => {
  it('folds consecutive same-speaker sentences into one cue', () => {
    const segments: SegmentInput[] = [
      { characterId: 'narrator', sentenceIds: [1], startSec: 0, endSec: 1 },
      { characterId: 'narrator', sentenceIds: [2], startSec: 1, endSec: 2 },
      { characterId: 'mira', sentenceIds: [3], startSec: 2, endSec: 3 },
    ];
    const text = { 1: 'One.', 2: 'Two.', 3: 'Three?' };
    const cues = buildLineCues(segments, text, SPEAKERS, 'Chapter One');

    expect(cues).toHaveLength(2);
    expect(cues[0]).toEqual({ startSec: 0, endSec: 2, text: 'One. Two.', speaker: 'Narrator' });
    expect(cues[1]).toEqual({ startSec: 2, endSec: 3, text: 'Three?', speaker: 'Mira' });
  });

  it('closes the fold once combined duration exceeds LINE_MAX_DURATION_SEC, even for the same speaker', () => {
    const segments: SegmentInput[] = [
      { characterId: 'narrator', sentenceIds: [1], startSec: 0, endSec: LINE_MAX_DURATION_SEC + 1 },
      { characterId: 'narrator', sentenceIds: [2], startSec: LINE_MAX_DURATION_SEC + 1, endSec: LINE_MAX_DURATION_SEC + 2 },
    ];
    const text = { 1: 'Long sentence.', 2: 'Next.' };
    const cues = buildLineCues(segments, text, SPEAKERS, 'Chapter One');

    // Segment 1 alone already exceeds the cap — it still emits as its own
    // cue (line mode never splits within a sentence), and segment 2 starts
    // a fresh fold rather than joining it.
    expect(cues).toHaveLength(2);
    expect(cues[0].text).toBe('Long sentence.');
    expect(cues[1].text).toBe('Next.');
  });

  it('closes the fold once combined character count exceeds LINE_MAX_CHARS', () => {
    const long = 'x'.repeat(LINE_MAX_CHARS - 5);
    const segments: SegmentInput[] = [
      { characterId: 'narrator', sentenceIds: [1], startSec: 0, endSec: 1 },
      { characterId: 'narrator', sentenceIds: [2], startSec: 1, endSec: 2 },
    ];
    const text = { 1: long, 2: 'This pushes it over the cap.' };
    const cues = buildLineCues(segments, text, SPEAKERS, 'Chapter One');
    expect(cues).toHaveLength(2);
  });

  it('always closes on a speaker change regardless of the caps', () => {
    const segments: SegmentInput[] = [
      { characterId: 'narrator', sentenceIds: [1], startSec: 0, endSec: 0.5 },
      { characterId: 'mira', sentenceIds: [2], startSec: 0.5, endSec: 1 },
    ];
    const text = { 1: 'Hi.', 2: 'Hello.' };
    const cues = buildLineCues(segments, text, SPEAKERS, 'Chapter One');
    expect(cues).toHaveLength(2);
  });

  it('includes the title beat as its own cue', () => {
    const segments: SegmentInput[] = [
      { characterId: 'narrator', sentenceIds: [], startSec: 0, endSec: 1.5, kind: 'title' },
      { characterId: 'narrator', sentenceIds: [1], startSec: 1.5, endSec: 2 },
    ];
    const cues = buildLineCues(segments, { 1: 'Hi.' }, SPEAKERS, 'Chapter One');
    expect(cues[0]).toEqual({ startSec: 0, endSec: 1.5, text: 'Chapter One' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/export/caption-cues.test.ts`
Expected: FAIL — `Cannot find module './caption-cues.js'`

- [ ] **Step 3: Implement**

Create `server/src/export/caption-cues.ts`:

```ts
/* fs-52 — sentence & line-granularity cue builders. Both are pure
   reconstructions over the already-per-sentence `segments.json` array
   (plan 70d) at export time only — rendering itself is unaffected, no
   schema change. See
   docs/superpowers/specs/2026-07-10-fs52-caption-srt-export-design.md §4. */

import type { CaptionCue } from './caption-format.js';
import type { SentenceOutput } from '../handoff/schemas.js';
import { textHashForStale } from '../audio/segments-io.js';

export interface SegmentInput {
  characterId: string;
  sentenceIds: number[];
  startSec: number;
  endSec: number;
  kind?: 'title';
  /** djb2-base36 hash of this segment's RAW rendered sentence text, stamped
      at synthesis time (`ChapterSegment.textHash`, `synthesise-chapter.ts`).
      Absent on the title beat and on pre-#1105 renders. Used here to
      detect a chapter whose manuscript text was edited AFTER it rendered
      but never re-rendered — the same staleness signal the frontend
      already uses to flag a chapter needing regeneration. */
  textHash?: string;
}

/** Line mode's bounded-fold ceilings (spec §4) — a cue closes once it hits
    either, in addition to always closing on a speaker change. */
export const LINE_MAX_DURATION_SEC = 7;
export const LINE_MAX_CHARS = 200;

/** Round-2-of-plan-review fix: line/sentence captions join CURRENT
    manuscript text onto STORED render-time timing — if the text was
    edited (or the chapter restructured) after it last rendered without a
    re-render, that join is silently wrong. Word mode is immune (it
    transcribes the actual audio), so this check only runs where text is
    actually joined onto stored timing. Absent `textHash` (pre-#1105
    renders) skips the check — "can't tell" stays permissive, matching how
    the frontend's own stale-chapter indicator treats the same absence. */
function assertNotStale(id: number, currentText: string, segment: SegmentInput): void {
  if (!segment.textHash) return;
  if (textHashForStale(currentText) !== segment.textHash) {
    throw new Error(
      `Sentence ${id}'s manuscript text no longer matches what this chapter's audio was ` +
        `rendered from — the chapter was edited after it last rendered. Regenerate this ` +
        `chapter before exporting captions.`,
    );
  }
}

function sentenceText(
  segment: SegmentInput,
  text: Record<number, string>,
): string {
  return segment.sentenceIds
    .map((id) => {
      const t = text[id];
      if (t === undefined) throw new Error(`No manuscript text found for sentence ${id}.`);
      assertNotStale(id, t, segment);
      return t;
    })
    .join(' ');
}

function speakerName(characterId: string, speakerNames: Record<string, string>): string {
  return speakerNames[characterId] ?? characterId;
}

export function buildSentenceCues(
  segments: SegmentInput[],
  text: Record<number, string>,
  speakerNames: Record<string, string>,
  chapterTitle: string,
): CaptionCue[] {
  return segments.map((seg) =>
    seg.kind === 'title'
      ? { startSec: seg.startSec, endSec: seg.endSec, text: chapterTitle }
      : {
          startSec: seg.startSec,
          endSec: seg.endSec,
          text: sentenceText(seg, text),
          speaker: speakerName(seg.characterId, speakerNames),
        },
  );
}

export function buildLineCues(
  segments: SegmentInput[],
  text: Record<number, string>,
  speakerNames: Record<string, string>,
  chapterTitle: string,
): CaptionCue[] {
  const cues: CaptionCue[] = [];
  let fold: { characterId: string; startSec: number; endSec: number; parts: string[] } | null = null;

  const flush = () => {
    if (!fold) return;
    cues.push({
      startSec: fold.startSec,
      endSec: fold.endSec,
      text: fold.parts.join(' '),
      speaker: speakerName(fold.characterId, speakerNames),
    });
    fold = null;
  };

  for (const seg of segments) {
    if (seg.kind === 'title') {
      flush();
      cues.push({ startSec: seg.startSec, endSec: seg.endSec, text: chapterTitle });
      continue;
    }
    const segText = sentenceText(seg, text);
    if (
      fold &&
      fold.characterId === seg.characterId &&
      seg.endSec - fold.startSec <= LINE_MAX_DURATION_SEC &&
      fold.parts.join(' ').length + 1 + segText.length <= LINE_MAX_CHARS
    ) {
      fold.endSec = seg.endSec;
      fold.parts.push(segText);
    } else {
      flush();
      fold = { characterId: seg.characterId, startSec: seg.startSec, endSec: seg.endSec, parts: [segText] };
    }
  }
  flush();
  return cues;
}

/** Round-2-of-plan-review decision: a pre-#1105 render has NO `textHash`
    anywhere, so `assertNotStale` can't verify it one way or the other —
    "can't tell", not "confirmed fresh." Rather than silently treating that
    the same as verified-fresh (a downloaded caption FILE is higher-stakes
    than the frontend's soft stale-chapter badge this behaviour was
    originally modelled on), the caller (Task 7's `buildCaptions`) uses this
    to attach a non-fatal `warning` to the job rather than staying silent.
    Title-beat segments are excluded (they have no `textHash` by design,
    not by age — checking them would always report "unverifiable"). */
export function hasUnverifiableTextHash(segments: SegmentInput[]): boolean {
  return segments.some((s) => s.kind !== 'title' && !s.textHash);
}
```

Note: `SentenceOutput` is imported for future consumers of this module (Task 7 passes `Record<number,string>` built from it) — if the linter flags it unused here, remove the import; the function signatures above only need `Record<number, string>`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/export/caption-cues.test.ts`
Expected: PASS. If the unused `SentenceOutput` import fails lint, delete that import line — it isn't referenced by this file's exports.

- [ ] **Step 5: Commit**

```bash
git add server/src/export/caption-cues.ts server/src/export/caption-cues.test.ts
git commit -m "feat(server): add sentence/line caption cue builders with bounded line fold"
```

---

## Task 6: Server — word cue builder (whole-chapter ASR)

**Files:**
- Modify: `server/src/export/caption-cues.ts`
- Modify: `server/src/export/caption-cues.test.ts`

**Interfaces:**
- Consumes: `decodeAudioToPcm` (`server/src/tts/mp3.ts`), `transcribeSegment` (Task 2, `server/src/tts/transcribe-client.ts`).
- Produces: `buildWordCues(chapterAudioPath: string, segments: SegmentInput[], chapterTitle: string, opts?: { language?: string | null; sidecarUrl?: string; signal?: AbortSignal }): Promise<CaptionCue[]>`.

- [ ] **Step 1: Write the failing test**

Add to `server/src/export/caption-cues.test.ts`:

```ts
import { vi } from 'vitest';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(async () => Buffer.from('fake-encoded-audio')) };
});
vi.mock('../tts/mp3.js', () => ({
  decodeAudioToPcm: vi.fn(async () => Buffer.from([0, 0, 1, 0])),
}));
vi.mock('../tts/transcribe-client.js', () => ({
  transcribeSegment: vi.fn(),
}));

import { buildWordCues } from './caption-cues.js';
import { transcribeSegment } from '../tts/transcribe-client.js';

describe('buildWordCues', () => {
  it('drops words before the first body segment and emits a fixed title cue', async () => {
    vi.mocked(transcribeSegment).mockResolvedValue({
      text: '',
      language: 'en',
      avgLogprob: -0.1,
      noSpeechProb: 0.01,
      compressionRatio: 1.0,
      words: [
        { word: 'Chapter', start: 0.1, end: 0.4 }, // inside the title beat — dropped
        { word: 'One.', start: 0.4, end: 0.9 },     // inside the title beat — dropped
        { word: 'It', start: 1.5, end: 1.7 },
        { word: 'begins.', start: 1.7, end: 2.1 },
      ],
    });
    const segments: SegmentInput[] = [
      { characterId: 'narrator', sentenceIds: [], startSec: 0, endSec: 1.5, kind: 'title' },
      { characterId: 'narrator', sentenceIds: [1], startSec: 1.5, endSec: 2.1 },
    ];

    const cues = await buildWordCues('/fake/01-chapter-one.mp3', segments, 'Chapter One');

    expect(cues).toEqual([
      { startSec: 0, endSec: 1.5, text: 'Chapter One' },
      { startSec: 1.5, endSec: 1.7, text: 'It' },
      { startSec: 1.7, endSec: 2.1, text: 'begins.' },
    ]);
  });

  it('requests word timestamps and passes the language hint', async () => {
    vi.mocked(transcribeSegment).mockResolvedValue({
      text: '',
      language: 'ru',
      avgLogprob: -0.1,
      noSpeechProb: 0.01,
      compressionRatio: 1.0,
      words: [{ word: 'Привет.', start: 0, end: 0.5 }],
    });
    const segments: SegmentInput[] = [
      { characterId: 'narrator', sentenceIds: [1], startSec: 0, endSec: 0.5 },
    ];

    await buildWordCues('/fake/01.mp3', segments, 'Chapter One', { language: 'ru' });

    expect(transcribeSegment).toHaveBeenCalledWith(
      expect.any(Buffer),
      16000,
      expect.objectContaining({ wordTimestamps: true, language: 'ru' }),
    );
  });

  it('throws a clear error when the sidecar returns no words', async () => {
    vi.mocked(transcribeSegment).mockResolvedValue({
      text: '',
      language: 'en',
      avgLogprob: null,
      noSpeechProb: null,
      compressionRatio: null,
      words: null,
    });
    const segments: SegmentInput[] = [
      { characterId: 'narrator', sentenceIds: [1], startSec: 0, endSec: 1 },
    ];

    await expect(buildWordCues('/fake/01.mp3', segments, 'Chapter One')).rejects.toThrow(
      /word-level timestamps/i,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/export/caption-cues.test.ts -t buildWordCues`
Expected: FAIL — `buildWordCues is not exported`

- [ ] **Step 3: Implement**

Append to `server/src/export/caption-cues.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { decodeAudioToPcm } from '../tts/mp3.js';
import { transcribeSegment } from '../tts/transcribe-client.js';

const WORD_ASR_SAMPLE_RATE = 16000;

export interface BuildWordCuesOptions {
  language?: string | null;
  sidecarUrl?: string;
  signal?: AbortSignal;
}

/** fs-52 — one whole-chapter ASR pass (not per-sentence — see spec §2 for
    why the per-sentence draft was rejected). Words before the first body
    segment's startSec are dropped and replaced with a single fixed-timing
    title cue, matching how sentence/line mode already treat the title
    beat. */
export async function buildWordCues(
  chapterAudioPath: string,
  segments: SegmentInput[],
  chapterTitle: string,
  opts: BuildWordCuesOptions = {},
): Promise<CaptionCue[]> {
  const encoded = await readFile(chapterAudioPath);
  const pcm = await decodeAudioToPcm(encoded, WORD_ASR_SAMPLE_RATE);
  const result = await transcribeSegment(pcm, WORD_ASR_SAMPLE_RATE, {
    wordTimestamps: true,
    language: opts.language,
    sidecarUrl: opts.sidecarUrl,
    signal: opts.signal,
  });
  if (!result.words) {
    throw new Error(
      'The sidecar did not return word-level timestamps for this chapter. ' +
        'Confirm Whisper is installed and reachable, or export line/sentence captions instead.',
    );
  }

  const titleSeg = segments.find((s) => s.kind === 'title');
  const firstBodySeg = segments.find((s) => s.kind !== 'title');
  const firstBodyStartSec = firstBodySeg?.startSec ?? 0;

  const cues: CaptionCue[] = [];
  if (titleSeg) cues.push({ startSec: titleSeg.startSec, endSec: titleSeg.endSec, text: chapterTitle });
  for (const w of result.words) {
    if (w.start < firstBodyStartSec) continue;
    const word = w.word.trim();
    if (!word) continue;
    cues.push({ startSec: w.start, endSec: w.end, text: word });
  }
  return cues;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/export/caption-cues.test.ts`
Expected: PASS (all tests in the file, including Task 5's).

- [ ] **Step 5: Commit**

```bash
git add server/src/export/caption-cues.ts server/src/export/caption-cues.test.ts
git commit -m "feat(server): add word-mode caption cue builder (whole-chapter ASR)"
```

---

## Task 7: Server — `build-captions.ts` orchestration (whole-book / per-chapter)

**Files:**
- Modify: `server/src/export/build-m4b.ts` (export `probeDurationSec`)
- Create: `server/src/export/build-captions.ts`
- Create: `server/src/export/build-captions.test.ts`

**Interfaces:**
- Consumes: `findChapterAudio` (`server/src/workspace/chapter-audio-file.ts`), `probeDurationSec` (`server/src/export/build-m4b.ts`, exported by this task), `loadManuscriptSentencesByChapter` (Task 3), `buildSentenceCues`/`buildLineCues`/`buildWordCues`/`hasUnverifiableTextHash` (Tasks 5–6), `writeSrt`/`writeVtt` (Task 4), `ExportIncompleteError`/`sanitiseForZip`/`pad2` (`server/src/export/build-mp3-zip.ts`), `castJsonPath` (`server/src/workspace/paths.ts`), `audioDir` (`server/src/workspace/paths.ts`), `readJson` (`server/src/workspace/state-io.ts`), `ChapterSegmentsFile` (`server/src/audio/finalize-chapter-write.ts`).
- Produces: `BuildCaptionsOptions { bookDir: string; state: BookStateJson; captionFileFormat: 'srt' | 'vtt'; captionGranularity: 'line' | 'sentence' | 'word'; captionScope: 'whole-book' | 'per-chapter'; outPath: string; onProgress?: (ratio: number) => void; signal?: AbortSignal }`; `BuildCaptionsResult { sizeBytes: number; warning?: string }`; `buildCaptions(opts: BuildCaptionsOptions): Promise<BuildCaptionsResult>` (Task 9 calls this from `runExportJob`). `warning` is set (round-2-of-plan-review decision) when any chapter's sentence/line cues included a segment `hasUnverifiableTextHash` flagged — word mode never sets it, since it doesn't join manuscript text at all.

- [ ] **Step 1: Export `probeDurationSec` from `build-m4b.ts`**

In `server/src/export/build-m4b.ts`, change (currently near line 229):

```ts
function probeDurationSec(mp3Path: string): Promise<number> {
```

to:

```ts
export function probeDurationSec(mp3Path: string): Promise<number> {
```

This is a one-line, behavior-neutral export widening — no test needed on its own (covered by `build-m4b.test.ts`'s existing suite, which must still pass).

Run: `cd server && npx vitest run src/export/build-m4b.test.ts`
Expected: PASS (unchanged).

- [ ] **Step 2: Write the failing test for `buildCaptions`**

Create `server/src/export/build-captions.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodePcmToAudio } from '../tts/mp3.js';
import { buildCaptions, ExportIncompleteError } from './build-captions.js';
import type { BookStateJson } from '../workspace/scan.js';

const ffmpegPresent = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
const describeIfFfmpeg = ffmpegPresent ? describe : describe.skip;

let bookDir: string;
let state: BookStateJson;

function silencePcm(seconds: number, sampleRate = 24000): Buffer {
  return Buffer.alloc(Math.floor(seconds * sampleRate) * 2);
}

beforeAll(async () => {
  bookDir = mkdtempSync(join(tmpdir(), 'build-captions-test-'));
  mkdirSync(join(bookDir, 'audio'), { recursive: true });
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });

  state = {
    bookId: 'bk_test',
    title: 'The Coalfall Test',
    author: 'Test Author',
    chapters: [{ id: 1, title: 'Chapter One', slug: '01-chapter-one' }],
  } as BookStateJson;

  writeFileSync(join(bookDir, '.audiobook', 'cast.json'), JSON.stringify({
    characters: [{ id: 'narrator', name: 'Narrator' }, { id: 'mira', name: 'Mira' }],
  }));
  writeFileSync(join(bookDir, '.audiobook', 'manuscript-edits.json'), JSON.stringify({
    sentences: [
      { id: 1, chapterId: 1, characterId: 'narrator', text: 'It was a dark night.' },
      { id: 2, chapterId: 1, characterId: 'mira', text: 'Who goes there?' },
    ],
  }));
  writeFileSync(join(bookDir, 'audio', '01-chapter-one.segments.json'), JSON.stringify({
    bookId: 'bk_test',
    chapterId: 1,
    chapterTitle: 'Chapter One',
    durationSec: 3,
    sampleRate: 24000,
    modelKey: 'kokoro-v1',
    synthesizedAt: new Date().toISOString(),
    segments: [
      { groupIndex: 0, characterId: 'narrator', sentenceIds: [1], startSec: 0, endSec: 1.5 },
      { groupIndex: 1, characterId: 'mira', sentenceIds: [2], startSec: 1.5, endSec: 3 },
    ],
  }));

  const pcm = silencePcm(3);
  const mp3 = await encodePcmToAudio(pcm, 24000, { format: 'mp3', quality: 2 });
  writeFileSync(join(bookDir, 'audio', '01-chapter-one.mp3'), mp3);
});

afterAll(() => {
  rmSync(bookDir, { recursive: true, force: true });
});

describeIfFfmpeg('buildCaptions', () => {
  it('builds a whole-book .srt with cumulative offsets from manuscript-edits.json text', async () => {
    const outPath = join(bookDir, 'out.srt');
    const result = await buildCaptions({
      bookDir,
      state,
      captionFileFormat: 'srt',
      captionGranularity: 'sentence',
      captionScope: 'whole-book',
      outPath,
    });
    expect(result.sizeBytes).toBeGreaterThan(0);
    const { readFileSync } = await import('node:fs');
    const text = readFileSync(outPath, 'utf8');
    expect(text).toContain('Narrator: It was a dark night.');
    expect(text).toContain('Mira: Who goes there?');
    expect(text).toContain('00:00:00,000 --> 00:00:01,500');
    // The fixture's segments.json carries no textHash (pre-#1105 shape) —
    // sentence/line granularity can't verify it's still current.
    expect(result.warning).toMatch(/couldn't fully verify/);
  });

  it('sets no warning when every segment carries a matching textHash', async () => {
    const { textHashForStale } = await import('../audio/segments-io.js');
    const freshDir = mkdtempSync(join(tmpdir(), 'build-captions-fresh-'));
    mkdirSync(join(freshDir, 'audio'), { recursive: true });
    mkdirSync(join(freshDir, '.audiobook'), { recursive: true });
    try {
      writeFileSync(join(freshDir, '.audiobook', 'cast.json'), JSON.stringify({
        characters: [{ id: 'narrator', name: 'Narrator' }],
      }));
      writeFileSync(join(freshDir, '.audiobook', 'manuscript-edits.json'), JSON.stringify({
        sentences: [{ id: 1, chapterId: 1, characterId: 'narrator', text: 'Fresh sentence.' }],
      }));
      writeFileSync(join(freshDir, 'audio', '01-chapter-one.segments.json'), JSON.stringify({
        bookId: 'bk_fresh',
        chapterId: 1,
        chapterTitle: 'Chapter One',
        durationSec: 1,
        sampleRate: 24000,
        modelKey: 'kokoro-v1',
        synthesizedAt: new Date().toISOString(),
        segments: [
          {
            groupIndex: 0,
            characterId: 'narrator',
            sentenceIds: [1],
            startSec: 0,
            endSec: 1,
            textHash: textHashForStale('Fresh sentence.'),
          },
        ],
      }));
      const pcm = silencePcm(1);
      const mp3 = await encodePcmToAudio(pcm, 24000, { format: 'mp3', quality: 2 });
      writeFileSync(join(freshDir, 'audio', '01-chapter-one.mp3'), mp3);

      const result = await buildCaptions({
        bookDir: freshDir,
        state: { ...state, chapters: [state.chapters[0]] } as BookStateJson,
        captionFileFormat: 'srt',
        captionGranularity: 'sentence',
        captionScope: 'whole-book',
        outPath: join(freshDir, 'out.srt'),
      });
      expect(result.warning).toBeUndefined();
    } finally {
      rmSync(freshDir, { recursive: true, force: true });
    }
  });

  it('builds a per-chapter .zip with one entry per chapter', async () => {
    const outPath = join(bookDir, 'out.zip');
    const result = await buildCaptions({
      bookDir,
      state,
      captionFileFormat: 'vtt',
      captionGranularity: 'line',
      captionScope: 'per-chapter',
      outPath,
    });
    expect(result.sizeBytes).toBeGreaterThan(0);
  });

  it('throws ExportIncompleteError when a chapter has no audio file', async () => {
    const brokenState = {
      ...state,
      chapters: [...state.chapters, { id: 2, title: 'Missing', slug: '02-missing' }],
    } as BookStateJson;
    await expect(
      buildCaptions({
        bookDir,
        state: brokenState,
        captionFileFormat: 'srt',
        captionGranularity: 'sentence',
        captionScope: 'whole-book',
        outPath: join(bookDir, 'broken.srt'),
      }),
    ).rejects.toBeInstanceOf(ExportIncompleteError);
  });

  it('throws a clear error when manuscript-edits.json is missing', async () => {
    const bareDir = mkdtempSync(join(tmpdir(), 'build-captions-bare-'));
    mkdirSync(join(bareDir, 'audio'), { recursive: true });
    mkdirSync(join(bareDir, '.audiobook'), { recursive: true });
    try {
      await expect(
        buildCaptions({
          bookDir: bareDir,
          state: { ...state, chapters: [] } as BookStateJson,
          captionFileFormat: 'srt',
          captionGranularity: 'sentence',
          captionScope: 'whole-book',
          outPath: join(bareDir, 'x.srt'),
        }),
      ).rejects.toThrow(/manuscript-edits\.json/);
    } finally {
      rmSync(bareDir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd server && npx vitest run src/export/build-captions.test.ts`
Expected: FAIL — `Cannot find module './build-captions.js'`

- [ ] **Step 4: Implement**

Create `server/src/export/build-captions.ts`:

```ts
/* fs-52 — caption export orchestrator. Sibling to build-m4b.ts /
   build-mp3-zip.ts: both caption scopes (whole-book single file,
   per-chapter zip) are single-artifact builds, so this slots into
   runExportJob's existing single-file branch with no new job-lifecycle
   code. See
   docs/superpowers/specs/2026-07-10-fs52-caption-srt-export-design.md. */

import { createWriteStream } from 'node:fs';
import { stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ZipFile } from 'yazl';
import { audioDir, castJsonPath } from '../workspace/paths.js';
import { readJson } from '../workspace/state-io.js';
import { findChapterAudio } from '../workspace/chapter-audio-file.js';
import { probeDurationSec } from './build-m4b.js';
import { ExportIncompleteError, sanitiseForZip, pad2 } from './build-mp3-zip.js';
import { loadManuscriptSentencesByChapter } from './manuscript-sentences.js';
import {
  buildSentenceCues,
  buildLineCues,
  buildWordCues,
  hasUnverifiableTextHash,
  type SegmentInput,
} from './caption-cues.js';
import { writeSrt, writeVtt, type CaptionCue } from './caption-format.js';
import type { BookStateJson } from '../workspace/scan.js';
import type { ChapterSegmentsFile } from '../audio/finalize-chapter-write.js';

export { ExportIncompleteError } from './build-mp3-zip.js';

export interface BuildCaptionsOptions {
  bookDir: string;
  state: BookStateJson;
  captionFileFormat: 'srt' | 'vtt';
  captionGranularity: 'line' | 'sentence' | 'word';
  captionScope: 'whole-book' | 'per-chapter';
  outPath: string;
  onProgress?: (ratio: number) => void;
  signal?: AbortSignal;
}

export interface BuildCaptionsResult {
  sizeBytes: number;
  /** Round-2-of-plan-review decision: set when any sentence/line segment
      predates the `textHash` staleness stamp (#1105) and so couldn't be
      verified as still matching the current manuscript text — "can't
      tell", not "confirmed fresh." The export still succeeds; this is a
      non-fatal heads-up surfaced on the job, not a failure. Never set for
      word mode, which doesn't join manuscript text at all. */
  warning?: string;
}

const UNVERIFIABLE_STALENESS_WARNING =
  "Some of this book's chapters predate render-time staleness tracking, so we couldn't fully " +
  'verify these captions are still in sync with the audio. Re-render for a guaranteed-accurate export.';

interface CastJson {
  characters?: Array<{ id: string; name?: string }>;
}

function formatCues(cues: CaptionCue[], format: 'srt' | 'vtt'): string {
  return format === 'srt' ? writeSrt(cues) : writeVtt(cues);
}

function toSegmentInputs(file: ChapterSegmentsFile): SegmentInput[] {
  return file.segments.map((s) => ({
    characterId: s.characterId,
    sentenceIds: s.sentenceIds,
    startSec: s.startSec,
    endSec: s.endSec,
    kind: s.kind,
    textHash: s.textHash,
  }));
}

async function chapterCues(
  granularity: 'line' | 'sentence' | 'word',
  chapterAudioPath: string,
  segFile: ChapterSegmentsFile,
  sentenceText: Record<number, string>,
  speakerNames: Record<string, string>,
  language: string | null,
  signal?: AbortSignal,
): Promise<CaptionCue[]> {
  const segments = toSegmentInputs(segFile);
  if (granularity === 'word') {
    /* Spec §2 — ASR always passes the book's language via X-Language, same
       as segment-asr-qa.ts already does for non-English books. */
    return buildWordCues(chapterAudioPath, segments, segFile.chapterTitle, { language, signal });
  }
  return granularity === 'sentence'
    ? buildSentenceCues(segments, sentenceText, speakerNames, segFile.chapterTitle)
    : buildLineCues(segments, sentenceText, speakerNames, segFile.chapterTitle);
}

export async function buildCaptions(opts: BuildCaptionsOptions): Promise<BuildCaptionsResult> {
  const { bookDir, state, captionFileFormat, captionGranularity, captionScope, outPath, onProgress, signal } = opts;

  const chapters = [...state.chapters].filter((c) => !c.excluded).sort((a, b) => a.id - b.id);
  const root = audioDir(bookDir);

  const missing: string[] = [];
  const resolved: Array<{ chapter: (typeof chapters)[number]; audioPath: string }> = [];
  for (const chapter of chapters) {
    const audio = findChapterAudio(root, chapter.slug);
    if (!audio) {
      missing.push(chapter.slug);
      continue;
    }
    resolved.push({ chapter, audioPath: audio.path });
  }
  if (missing.length > 0) throw new ExportIncompleteError(missing);

  const sentencesByChapter = await loadManuscriptSentencesByChapter(bookDir);
  if (!sentencesByChapter) {
    throw new Error(
      'No manuscript data found for this book (manuscript-edits.json missing). ' +
        'Re-run analysis, then generate again before exporting captions.',
    );
  }

  const cast = await readJson<CastJson>(castJsonPath(bookDir));
  const speakerNames: Record<string, string> = {};
  for (const c of cast?.characters ?? []) {
    if (c.name) speakerNames[c.id] = c.name;
  }

  const perChapterCues: CaptionCue[][] = [];
  const perChapterDurations: number[] = [];
  let anyUnverifiable = false;
  for (let i = 0; i < resolved.length; i++) {
    signal?.throwIfAborted();
    const { chapter, audioPath } = resolved[i];
    const segFile = await readJson<ChapterSegmentsFile>(join(root, `${chapter.slug}.segments.json`));
    if (!segFile) throw new Error(`No segments.json found for rendered chapter ${chapter.slug}.`);
    const text = sentencesByChapter[chapter.id] ?? {};
    const sentenceText: Record<number, string> = {};
    for (const [id, s] of Object.entries(text)) sentenceText[Number(id)] = s.text;

    const cues = await chapterCues(
      captionGranularity,
      audioPath,
      segFile,
      sentenceText,
      speakerNames,
      state.language ?? null,
      signal,
    );
    perChapterCues.push(cues);
    /* Round-2-of-plan-review decision: word mode never joins manuscript
       text, so it's immune to the staleness class this flags — only check
       for sentence/line granularity. */
    if (captionGranularity !== 'word' && hasUnverifiableTextHash(toSegmentInputs(segFile))) {
      anyUnverifiable = true;
    }
    /* Plan-review fix: only probe duration for whole-book scope, which is
       the only branch that consumes perChapterDurations (the cumulative
       cross-chapter offset, computed from the SAME encoded-file duration
       source build-m4b.ts uses for its own chapter marks — see spec §2).
       Per-chapter scope never reads it — probing every chapter's duration
       there was pure wasted ffprobe work. */
    if (captionScope === 'whole-book') {
      perChapterDurations.push(await probeDurationSec(audioPath));
    }
    onProgress?.((i + 1) / resolved.length);
  }
  const warning = anyUnverifiable ? UNVERIFIABLE_STALENESS_WARNING : undefined;

  if (captionScope === 'whole-book') {
    let cursorSec = 0;
    const allCues: CaptionCue[] = [];
    for (let i = 0; i < perChapterCues.length; i++) {
      for (const cue of perChapterCues[i]) {
        allCues.push({ ...cue, startSec: cue.startSec + cursorSec, endSec: cue.endSec + cursorSec });
      }
      cursorSec += perChapterDurations[i];
    }
    const content = formatCues(allCues, captionFileFormat);
    /* No mkdir here — the caller (export.ts's POST handler) already
       ensures the exports dir exists before computing outPath, same
       guarantee build-m4b.ts/build-mp3-zip.ts rely on. */
    await writeFile(outPath, content, 'utf8');
    const st = await stat(outPath);
    return { sizeBytes: st.size, warning };
  }

  // per-chapter: zip of one caption file per chapter, each zero-based.
  return new Promise<BuildCaptionsResult>((resolve, reject) => {
    const zip = new ZipFile();
    const ws = createWriteStream(outPath);
    ws.on('error', reject);
    let bytes = 0;
    zip.outputStream.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
    });
    zip.outputStream.on('error', reject);
    zip.outputStream.pipe(ws).on('finish', () => resolve({ sizeBytes: bytes, warning }));

    for (let i = 0; i < resolved.length; i++) {
      const { chapter } = resolved[i];
      const content = formatCues(perChapterCues[i], captionFileFormat);
      const entryName = `${pad2(i + 1)} - ${sanitiseForZip(chapter.title)}.${captionFileFormat}`;
      zip.addBuffer(Buffer.from(content, 'utf8'), entryName, { mtime: new Date() });
    }
    zip.end();
  });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd server && npx vitest run src/export/build-captions.test.ts`
Expected: PASS (skipped entirely if ffmpeg isn't on PATH — matches the existing `build-mp3-zip.test.ts`/`build-m4b.test.ts` convention).

- [ ] **Step 6: Commit**

```bash
git add server/src/export/build-m4b.ts server/src/export/build-captions.ts server/src/export/build-captions.test.ts
git commit -m "feat(server): add buildCaptions orchestrator (whole-book + per-chapter)"
```

---

## Task 8: OpenAPI schema + regenerate frontend types

**Files:**
- Modify: `openapi.yaml`
- Regenerate: `src/lib/api-types.ts` (generated — do not hand-edit)

**Interfaces:**
- Produces: `BookExportRequest`/`BookExportJob` schemas gain `format: captions` plus `captionFileFormat`/`captionGranularity`/`captionScope`, consumed by `src/lib/types.ts`'s `BookExportRequest`/`BookExportJob` re-exports (Task 9 onward).

- [ ] **Step 1: Edit `BookExportRequest` in `openapi.yaml`**

Find the `BookExportRequest` schema (currently line 5310) and replace its `format` property + add the three new properties:

```yaml
    BookExportRequest:
      type: object
      required: [format, destination]
      properties:
        format:
          type: string
          enum: [mp3-zip, m4b, mp3-folder, aac-m4a-zip, opus-ogg-zip, captions]
          description: |
            Container format. `mp3-zip` packages per-chapter MP3s into
            a zip — universal compatibility, no re-encode (the LAME
            VBR V2 frames round-trip byte-identical). `m4b` produces
            a single AAC-LC file at 96 kbps mono 44.1 kHz with
            QuickTime chapter atoms; PocketBook surfaces it under
            Audiobooks with chapter UI + resume position. M4B
            re-encodes from MP3 → AAC. `mp3-folder` writes the per-
            chapter MP3s into a sub-folder named after the book
            (each tagged with the same ID3v2 + optional APIC cover
            as the zip variant) — the folder-scanning audiobook apps
            (Smart AudioBook Player, Audiobookshelf, BookPlayer via
            Files import) pick up a folder per book. `mp3-folder` is
            only valid with `destination: sync-folder` since the
            download endpoint serves single files.
            `aac-m4a-zip` and `opus-ogg-zip` (plan 72) are the codec-
            zip companions of `mp3-zip` — they package the per-chapter
            `.m4a` (AAC-LC ≈ 128 kbps in MP4/M4A) or `.ogg` (Opus ≈
            96 kbps VBR) files into a zip without re-tagging. Requires
            the book's `audioFormat` to match the export codec; books
            generated as mp3 can't be exported as `aac-m4a-zip`
            without re-running generation under the new format.
            `captions` (fs-52) emits `.srt`/`.vtt` caption files from
            the book's per-sentence render-time alignment. Requires
            `captionFileFormat`, `captionGranularity`, and
            `captionScope`. `whole-book` scope produces a single
            caption file (pairs with `m4b`'s single-file model);
            `per-chapter` produces a zip of one caption file per
            chapter (pairs with `mp3-zip`'s model).
        captionFileFormat:
          type: string
          enum: [srt, vtt]
          description: 'Required when format is captions. Caption container syntax.'
        captionGranularity:
          type: string
          enum: [line, sentence, word]
          description: |
            Required when format is captions. `sentence` is one cue per
            rendered sentence. `line` folds consecutive same-speaker
            sentences into one cue, capped at ~7s / ~200 chars (or a
            speaker change), whichever comes first. `word` is one cue per
            ASR-recognised word from a single whole-chapter Whisper pass
            (requires the sidecar's Whisper model — see
            `whisperPackageInstalled` on `GET /api/sidecar/health`).
        captionScope:
          type: string
          enum: [whole-book, per-chapter]
          description: |
            Required when format is captions. `whole-book` produces a
            single caption file with cumulative cross-chapter offsets;
            `per-chapter` produces a zip of one caption file per chapter,
            each zero-based.
        destination:
          type: string
          enum: [download, sync-folder]
          description: |
            `download` stages the file under the book's `.audiobook/exports/`
            for the user to pull via `downloadBookExport`. `sync-folder`
            additionally copies the finished archive into the user's
            configured `exportSyncFolder` (e.g. a OneDrive watch path) so
            it lands on their phone via sync. Requires `exportSyncFolder`
            to be set; the request 400s otherwise. `mp3-folder` requires
            this to be `sync-folder` (the download endpoint serves single
            files, not directory trees).
```

- [ ] **Step 2: Edit `BookExportJob` in `openapi.yaml`**

Find `BookExportJob` (currently line 5352) and widen its `format` enum + add the same three optional fields (mirroring the request):

```yaml
    BookExportJob:
      type: object
      required: [id, bookId, format, destination, status, filename, createdAt]
      properties:
        id: { type: string, description: 'Server-generated export id' }
        bookId: { type: string }
        format: { type: string, enum: [mp3-zip, m4b, mp3-folder, aac-m4a-zip, opus-ogg-zip, captions] }
        captionFileFormat: { type: string, enum: [srt, vtt], nullable: true }
        captionGranularity: { type: string, enum: [line, sentence, word], nullable: true }
        captionScope: { type: string, enum: [whole-book, per-chapter], nullable: true }
        destination: { type: string, enum: [download, sync-folder] }
        status:
          type: string
          enum: [queued, in_progress, done, failed, cancelled]
        filename: { type: string, description: "e.g. 'The Northern Star.zip'" }
```

Leave the remaining `BookExportJob` properties — `sizeBytes`, `progress`, `downloadUrl`, `syncPath`, `errorReason`, `createdAt`, `completedAt` — unchanged. Update the existing `warning` property's description (it already exists on this schema for the disk-guard case) to reflect that Task 9 widens its usage:

```yaml
        warning:
          type: string
          nullable: true
          description: |
            Non-fatal advisory attached to the job. Two independent sources:
            srv-28's disk-space guard sets it only on the POST 201 response
            body (never persisted on the job record) when free space is
            tight in `warn` mode. fs-52 sets it as a genuinely PERSISTED
            field once a `captions` job's build completes, when some
            sentence/line segments predate the render-time staleness stamp
            and so couldn't be verified as still matching the current
            manuscript text — the export still succeeds, this just flags
            it. Absent/null otherwise.
```

- [ ] **Step 3: Regenerate frontend types**

Run: `npm run openapi:types`
Expected: `src/lib/api-types.ts` regenerates with no errors; `git diff src/lib/api-types.ts` shows the new `captionFileFormat`/`captionGranularity`/`captionScope` fields and widened `format` union on both `BookExportRequest` and `BookExportJob`.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no consumer references the new fields yet, so nothing should break).

- [ ] **Step 5: Commit**

```bash
git add openapi.yaml src/lib/api-types.ts
git commit -m "feat(api): add captions format to BookExportRequest/BookExportJob schemas"
```

---

## Task 9: Server — wire `captions` into `export.ts`

**Files:**
- Modify: `server/src/routes/export.ts`
- Modify: `server/src/routes/export.test.ts`

**Interfaces:**
- Consumes: `buildCaptions`/`ExportIncompleteError` (Task 7), `BookExportRequest`/`BookExportJob` generated types (Task 8).
- Produces: `POST /api/books/:bookId/exports` accepts `format: 'captions'`; `runExportJob` dispatches to `buildCaptions`; `bookFilename`/`mimeForFormat`/`revokeStaleSameFormat` are caption-variant-aware; `BookExportJob.warning` is a real persisted field (not just a POST-response-only bolt-on like the existing disk-guard usage) so a caption job's staleness-unverifiable warning survives from build completion through the polling `GET`.

- [ ] **Step 1: Write the failing integration tests**

Add to `server/src/routes/export.test.ts` (find the existing `describeIfFfmpeg(...)` block with the mp3-zip/m4b tests and add a new sibling `describe` after it — the file already scaffolds `bookId`/`app`/chapter audio fixtures in `beforeAll`, reuse them):

```ts
describeIfFfmpeg('captions export', () => {
  beforeAll(async () => {
    const { writeFileSync: wfs } = await import('node:fs');
    wfs(
      join(bookDir, '.audiobook', 'manuscript-edits.json'),
      JSON.stringify({
        sentences: [
          { id: 1, chapterId: 1, characterId: 'narrator', text: 'Chapter one begins.' },
          { id: 1, chapterId: 2, characterId: 'narrator', text: 'Chapter two begins.' },
        ],
      }),
    );
    for (const [slug, chapterId] of [
      ['01-chapter-one', 1],
      ['02-chapter-two', 2],
    ] as const) {
      wfs(
        join(audioRoot, `${slug}.segments.json`),
        JSON.stringify({
          bookId,
          chapterId,
          chapterTitle: chapterId === 1 ? 'Chapter One' : 'Chapter Two',
          durationSec: 1,
          sampleRate: 24000,
          modelKey: 'kokoro-v1',
          synthesizedAt: new Date().toISOString(),
          segments: [
            { groupIndex: 0, characterId: 'narrator', sentenceIds: [1], startSec: 0, endSec: 1 },
          ],
        }),
      );
    }
  });

  it('creates a whole-book sentence .srt export and streams it with the right MIME type', async () => {
    const res = await request(app)
      .post(`/${bookId}/exports`)
      .send({
        format: 'captions',
        destination: 'download',
        captionFileFormat: 'srt',
        captionGranularity: 'sentence',
        captionScope: 'whole-book',
      });
    expect(res.status).toBe(201);
    const exportId = res.body.id as string;

    let job = res.body;
    for (let i = 0; i < 50 && job.status === 'in_progress'; i++) {
      await new Promise((r) => setTimeout(r, 50));
      job = (await request(app).get(`/${bookId}/exports/${exportId}`)).body;
    }
    expect(job.status).toBe('done');
    expect(job.filename).toMatch(/\.srt$/);

    const dl = await request(app).get(`/${bookId}/exports/${exportId}/download`);
    expect(dl.status).toBe(200);
    expect(dl.headers['content-type']).toContain('application/x-subrip');
    expect(dl.text).toContain('Chapter one begins.');
    expect(dl.text).toContain('Chapter two begins.');
  });

  it('creates a per-chapter line .vtt export as a downloadable zip', async () => {
    const res = await request(app)
      .post(`/${bookId}/exports`)
      .send({
        format: 'captions',
        destination: 'download',
        captionFileFormat: 'vtt',
        captionGranularity: 'line',
        captionScope: 'per-chapter',
      });
    expect(res.status).toBe(201);
    const exportId = res.body.id as string;

    let job = res.body;
    for (let i = 0; i < 50 && job.status === 'in_progress'; i++) {
      await new Promise((r) => setTimeout(r, 50));
      job = (await request(app).get(`/${bookId}/exports/${exportId}`)).body;
    }
    expect(job.status).toBe('done');
    expect(job.filename).toMatch(/\.vtt\.zip$/);

    const dl = await request(app).get(`/${bookId}/exports/${exportId}/download`);
    expect(dl.status).toBe(200);
    expect(dl.headers['content-type']).toBe('application/zip');
  });

  it('rejects a captions request missing captionGranularity', async () => {
    const res = await request(app)
      .post(`/${bookId}/exports`)
      .send({ format: 'captions', destination: 'download', captionFileFormat: 'srt', captionScope: 'whole-book' });
    expect(res.status).toBe(400);
  });

  it('persists a warning on the job once a sentence-mode build completes with unverifiable staleness', async () => {
    const res = await request(app)
      .post(`/${bookId}/exports`)
      .send({
        format: 'captions',
        destination: 'download',
        captionFileFormat: 'srt',
        captionGranularity: 'sentence',
        captionScope: 'whole-book',
      });
    let job = res.body;
    for (let i = 0; i < 50 && job.status === 'in_progress'; i++) {
      await new Promise((r) => setTimeout(r, 50));
      job = (await request(app).get(`/${bookId}/exports/${job.id}`)).body;
    }
    expect(job.status).toBe('done');
    // The fixture's segments.json (this describe block's beforeAll) carries
    // no textHash — round-2-of-plan-review decision: that's surfaced as a
    // persisted job warning, not silently ignored.
    expect(job.warning).toMatch(/couldn't fully verify/);
  });

  it('does not revoke a sentence-mode export when a word-mode export of the same book completes', async () => {
    const first = await request(app)
      .post(`/${bookId}/exports`)
      .send({
        format: 'captions',
        destination: 'download',
        captionFileFormat: 'srt',
        captionGranularity: 'sentence',
        captionScope: 'whole-book',
      });
    let firstJob = first.body;
    for (let i = 0; i < 50 && firstJob.status === 'in_progress'; i++) {
      await new Promise((r) => setTimeout(r, 50));
      firstJob = (await request(app).get(`/${bookId}/exports/${firstJob.id}`)).body;
    }
    expect(firstJob.status).toBe('done');

    // A different scope (per-chapter) is a different variant — must not
    // revoke the whole-book sentence job above.
    const second = await request(app)
      .post(`/${bookId}/exports`)
      .send({
        format: 'captions',
        destination: 'download',
        captionFileFormat: 'srt',
        captionGranularity: 'sentence',
        captionScope: 'per-chapter',
      });
    let secondJob = second.body;
    for (let i = 0; i < 50 && secondJob.status === 'in_progress'; i++) {
      await new Promise((r) => setTimeout(r, 50));
      secondJob = (await request(app).get(`/${bookId}/exports/${secondJob.id}`)).body;
    }
    expect(secondJob.status).toBe('done');

    const stillThere = await request(app).get(`/${bookId}/exports/${firstJob.id}`);
    expect(stillThere.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run src/routes/export.test.ts -t captions`
Expected: FAIL — `400 unsupported_format` on every request (captions isn't in `ALLOWED_FORMATS` yet).

- [ ] **Step 3: Implement — widen the `BookExportJob` interface + `ALLOWED_FORMATS`**

In `server/src/routes/export.ts`, replace the interface (currently lines 47–65):

```ts
export interface BookExportJob {
  id: string;
  bookId: string;
  format: 'mp3-zip' | 'm4b' | 'mp3-folder' | 'aac-m4a-zip' | 'opus-ogg-zip' | 'captions';
  /** fs-52 — only set (and only meaningful) when format === 'captions'.
      Persisted on the job record (not just the request) so revokeStaleSameFormat's
      de-dupe key survives a server restart via rehydrateBook. */
  captionFileFormat?: 'srt' | 'vtt';
  captionGranularity?: 'line' | 'sentence' | 'word';
  captionScope?: 'whole-book' | 'per-chapter';
  destination: 'download' | 'sync-folder';
  status: 'queued' | 'in_progress' | 'done' | 'failed' | 'cancelled';
  filename: string;
  sizeBytes: number | null;
  progress: number | null;
  downloadUrl: string | null;
  syncPath: string | null;
  errorReason: string | null;
  createdAt: string;
  completedAt: string | null;
  /** Round-2-of-plan-review decision (fs-52): a non-fatal, PERSISTED
      heads-up — distinct from the disk-guard's ad-hoc POST-response-only
      `warning` (bolted onto the 201 body via object spread, never stored
      on `job`). This one is set on the job object itself once the async
      build completes, so it survives into the manifest and the polling
      `GET`. Currently only `buildCaptions` sets it (unverifiable
      pre-#1105 staleness); `null`/absent otherwise. */
  warning?: string | null;
}

const ALLOWED_FORMATS: ReadonlySet<BookExportJob['format']> = new Set([
  'mp3-zip',
  'm4b',
  'mp3-folder',
  'aac-m4a-zip',
  'opus-ogg-zip',
  'captions',
]);
```

Add the import at the top (alongside the other `../export/build-*` imports):

```ts
import { buildCaptions } from '../export/build-captions.js';
```

(`build-captions.ts` re-exports `ExportIncompleteError` from `build-mp3-zip.js` — the exact same class this file already imports from there. Don't re-import it a second time under a different name; the existing `e instanceof ExportIncompleteError` check in `runExportJob`'s catch block already matches errors `buildCaptions` throws, since it's the identical class.)

- [ ] **Step 4: Implement — POST body validation**

In the POST handler, after the existing `destination` validation block and before the `mp3-folder` combo check, add:

```ts
  const captionFileFormat = body.captionFileFormat as 'srt' | 'vtt' | undefined;
  const captionGranularity = body.captionGranularity as 'line' | 'sentence' | 'word' | undefined;
  const captionScope = body.captionScope as 'whole-book' | 'per-chapter' | undefined;
  if (format === 'captions') {
    if (captionFileFormat !== 'srt' && captionFileFormat !== 'vtt') {
      return res.status(400).json({
        error: 'invalid_caption_file_format',
        message: `captionFileFormat must be 'srt' or 'vtt'; got ${captionFileFormat ?? '(missing)'}.`,
      });
    }
    if (
      captionGranularity !== 'line' &&
      captionGranularity !== 'sentence' &&
      captionGranularity !== 'word'
    ) {
      return res.status(400).json({
        error: 'invalid_caption_granularity',
        message: `captionGranularity must be 'line', 'sentence', or 'word'; got ${captionGranularity ?? '(missing)'}.`,
      });
    }
    if (captionScope !== 'whole-book' && captionScope !== 'per-chapter') {
      return res.status(400).json({
        error: 'invalid_caption_scope',
        message: `captionScope must be 'whole-book' or 'per-chapter'; got ${captionScope ?? '(missing)'}.`,
      });
    }
  }
```

And widen the `body` type annotation at the top of the handler to include the three optional fields:

```ts
  const body = (req.body ?? {}) as {
    format?: string;
    destination?: string;
    captionFileFormat?: string;
    captionGranularity?: string;
    captionScope?: string;
  };
```

Also update the existing `unsupported_format` 400 message to mention captions:

```ts
        message: `format must be 'mp3-zip', 'm4b', 'mp3-folder', 'aac-m4a-zip', 'opus-ogg-zip', or 'captions'; got ${body.format ?? '(missing)'}.`,
```

- [ ] **Step 5: Implement — `bookFilename` + job construction**

Replace `bookFilename` (currently lines ~180–194) with a caption-aware signature:

```ts
function bookFilename(
  state: BookStateJson,
  format: BookExportJob['format'],
  captionOpts?: {
    captionFileFormat?: 'srt' | 'vtt';
    captionGranularity?: 'line' | 'sentence' | 'word';
    captionScope?: 'whole-book' | 'per-chapter';
  },
): string {
  const base = slugify(state.title);
  if (format === 'mp3-zip') return `${base}.zip`;
  if (format === 'm4b') return `${base}.m4b`;
  if (format === 'aac-m4a-zip') return `${base}-aac.zip`;
  if (format === 'opus-ogg-zip') return `${base}-opus.zip`;
  if (format === 'captions') {
    const { captionFileFormat, captionGranularity, captionScope } = captionOpts ?? {};
    const variant = `${captionGranularity}.${captionFileFormat}`;
    return captionScope === 'per-chapter' ? `${base}.${variant}.zip` : `${base}.${variant}`;
  }
  return base;
}
```

Update the POST handler's call site (where `filename` is computed) to pass the caption options through:

```ts
  const filename = bookFilename(located.state, format, { captionFileFormat, captionGranularity, captionScope });
```

And in the `job` object literal, add the three fields (only meaningful/present for captions, `undefined` otherwise is fine since the interface marks them optional):

```ts
  const job: BookExportJob = {
    id: exportId,
    bookId: located.state.bookId,
    format,
    captionFileFormat: format === 'captions' ? captionFileFormat : undefined,
    captionGranularity: format === 'captions' ? captionGranularity : undefined,
    captionScope: format === 'captions' ? captionScope : undefined,
    destination: body.destination,
    status: 'in_progress',
    filename,
    sizeBytes: null,
    progress: 0,
    downloadUrl: null,
    syncPath: null,
    errorReason: null,
    createdAt: new Date().toISOString(),
    completedAt: null,
  };
```

- [ ] **Step 6: Implement — `revokeStaleSameFormat` variant-aware comparison**

Replace the function body's comparison line (currently `if (prior.bookId !== bookId || prior.format !== format) continue;`) with a caption-aware check. Update the function signature to accept the job so it has access to the caption fields:

```ts
async function revokeStaleSameFormat(
  bookDir: string,
  bookId: string,
  job: BookExportJob,
  keepId: string,
): Promise<void> {
  const dir = bookExportManifestsDir(bookDir);
  if (!existsSync(dir)) return;
  let entries: string[] = [];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const id = basename(name, '.json');
    if (id === keepId) continue;
    const path = join(dir, name);
    try {
      const raw = await readFile(path, 'utf8');
      const prior = JSON.parse(raw) as BookExportJob;
      if (prior.bookId !== bookId || prior.format !== job.format) continue;
      if (
        job.format === 'captions' &&
        (prior.captionFileFormat !== job.captionFileFormat ||
          prior.captionGranularity !== job.captionGranularity ||
          prior.captionScope !== job.captionScope)
      ) {
        continue; // different caption variant — not stale, don't revoke.
      }
      jobs.delete(prior.id);
      await unlink(path).catch(() => {});
    } catch {
      /* Corrupt manifest — leave alone; the rehydrate scan will see it. */
    }
  }
}
```

Update its call site inside `runExportJob` (currently `await revokeStaleSameFormat(bookDir, job.bookId, job.format, job.id);`):

```ts
    await revokeStaleSameFormat(bookDir, job.bookId, job, job.id);
```

- [ ] **Step 7: Implement — `runExportJob` dispatch**

In the single-file `else` branch's format ternary (currently `job.format === 'mp3-zip' ? ... : job.format === 'm4b' ? ... : await buildCodecZip(...)`), widen it:

```ts
        const result =
          job.format === 'mp3-zip'
            ? await buildMp3Zip({ bookDir, state, outPath: buildPath, onProgress, signal })
            : job.format === 'm4b'
              ? await buildM4b({ bookDir, state, outPath: buildPath, onProgress, signal })
              : job.format === 'captions'
                ? await buildCaptions({
                    bookDir,
                    state,
                    captionFileFormat: job.captionFileFormat!,
                    captionGranularity: job.captionGranularity!,
                    captionScope: job.captionScope!,
                    outPath: buildPath,
                    onProgress,
                    signal,
                  })
                : await buildCodecZip({
                    bookDir,
                    state,
                    outPath: buildPath,
                    format: job.format === 'aac-m4a-zip' ? 'aac-m4a' : 'opus',
                    onProgress,
                    signal,
                  });
        job.sizeBytes = result.sizeBytes;
        job.progress = 1;
        /* Round-2-of-plan-review decision: only buildCaptions's result
           carries `warning` — the other three builders' result shapes
           don't have the field at all, so narrow by format rather than
           reading `result.warning` unconditionally. */
        if (job.format === 'captions') {
          job.warning = (result as { warning?: string }).warning ?? null;
        }
        await renameWithRetry(buildPath, outPath);
```

(The existing `job.sizeBytes = result.sizeBytes; job.progress = 1; await renameWithRetry(buildPath, outPath);` lines right after the ternary are what this replaces — insert the new `job.warning` assignment between `job.progress = 1;` and `await renameWithRetry(...)`, keeping everything else in that block unchanged.)

- [ ] **Step 8: Implement — `mimeForFormat`**

Replace `mimeForFormat` to take the job (not just the format string), so it can branch on caption scope + file format:

```ts
function mimeForFormat(job: BookExportJob): string {
  if (job.format === 'm4b') return 'audio/mp4';
  if (job.format === 'captions' && job.captionScope === 'whole-book') {
    return job.captionFileFormat === 'vtt' ? 'text/vtt' : 'application/x-subrip';
  }
  /* Every other case (mp3-zip / aac-m4a-zip / opus-ogg-zip / per-chapter
     captions) is a zip archive. mp3-folder isn't downloadable (the route
     refuses it) so this branch never fires for that format. */
  return 'application/zip';
}
```

Update its one call site in the download route (currently `'Content-Type': mimeForFormat(job.format),`):

```ts
        'Content-Type': mimeForFormat(job),
```

- [ ] **Step 9: Implement — `estimateExportBytes` captions branch**

Widen the function signature to accept the format so it can special-case captions (text is tiny — no point sizing against chapter audio):

```ts
function estimateExportBytes(state: BookStateJson, bookDir: string, format: BookExportJob['format']): number {
  if (format === 'captions') {
    /* Captions are plain text derived from data already on disk — a few
       KB per chapter at most, nowhere near audio-file scale. A flat
       per-chapter estimate keeps the disk-guard meaningful without
       walking chapter audio sizes for a build that doesn't need them. */
    const chapterCount = state.chapters.filter((c) => !c.excluded).length;
    return chapterCount * 4096;
  }
  const root = join(bookDir, 'audio');
  let total = 0;
  for (const chapter of state.chapters) {
    if (chapter.excluded) continue;
    const audio = findChapterAudio(root, chapter.slug);
    if (!audio) continue;
    try {
      total += statSync(audio.path).size;
    } catch {
      total += AVG_CHAPTER_BYTES;
    }
  }
  return Math.round(total * 1.2);
}
```

Update its call site in the POST handler (currently `estimatedBytes: estimateExportBytes(located.state, located.bookDir),`):

```ts
        { estimatedBytes: estimateExportBytes(located.state, located.bookDir, format), basis: 'export' },
```

- [ ] **Step 10: Run tests to verify they pass**

Run: `cd server && npx vitest run src/routes/export.test.ts`
Expected: PASS (the whole file, including the pre-existing mp3-zip/m4b suites — confirms nothing regressed).

- [ ] **Step 11: Typecheck + full server suite**

Run: `npm run typecheck && cd server && npx vitest run`
Expected: PASS

- [ ] **Step 12: Commit**

```bash
git add server/src/routes/export.ts server/src/routes/export.test.ts
git commit -m "feat(server): wire captions format into the export-job route"
```

---

## Task 10: Frontend — `whisperPackageInstalled` on `SidecarHealth`

**Files:**
- Modify: `src/lib/api.ts`

**Interfaces:**
- Produces: `SidecarHealth.whisperPackageInstalled?: boolean` — the field already reaches the client in the real JSON payload from `server/src/routes/sidecar-health.ts`; this task only widens the TS type + the mock so the modal (Task 11) can read it.

- [ ] **Step 1: Write the failing test**

Add to `src/lib/api.test.ts` (find the existing `getSidecarHealth`/mock-health test block and add alongside it):

```ts
  it('mockGetSidecarHealth reports whisperPackageInstalled: true', async () => {
    const health = await api.getSidecarHealth();
    expect(health.whisperPackageInstalled).toBe(true);
  });
```

(If `src/lib/api.test.ts` doesn't already import `api` from the mock surface at module scope, check the top of the file for the existing import/mock-mode setup and reuse it rather than adding a second one.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/api.test.ts -t whisperPackageInstalled`
Expected: FAIL — `expected undefined to be true`

- [ ] **Step 3: Implement**

In `src/lib/api.ts`, add the field to the `SidecarHealth` interface (near `asrEnabled`/`asrLoaded`, currently around line 5744):

```ts
  /** fs-52 — pip-importability only (NOT weights-present); see the
      caption-export modal's Word-mode gate. Absent on an older server. */
  whisperPackageInstalled?: boolean;
  asrEnabled?: boolean;
  asrLoaded?: boolean;
```

In `mockGetSidecarHealth()` (currently around line 6902–6927), add:

```ts
    whisperPackageInstalled: true,
```

to the returned object (any position in the object literal is fine — pick right after `qwenWeightsPresent`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/api.test.ts -t whisperPackageInstalled`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/api.ts src/lib/api.test.ts
git commit -m "feat(frontend): surface whisperPackageInstalled on SidecarHealth"
```

---

## Task 11: Frontend — Captions UI in the export modal

**Files:**
- Modify: `src/modals/export-audiobook.tsx`
- Modify: `src/modals/export-audiobook.test.tsx`

**Interfaces:**
- Consumes: `api.getSidecarHealth` (Task 10), `BookExportRequest`/`BookExportJob` generated types (Task 8).
- Produces: a `'captions'` option in the generic format toggle; a `<CaptionsOptions>` block (file-format toggle, granularity radio, scope radio) rendered when `format === 'captions'`; `handleSubmit` includes the three caption fields on the request body.

- [ ] **Step 1: Write the failing tests**

Add to `src/modals/export-audiobook.test.tsx` (extend the existing `vi.mock('../lib/api', ...)` factory to add `getSidecarHealth: vi.fn(async () => ({ status: 'reachable', url: '(mock)', whisperPackageInstalled: true }))`, then add a new `describe` block):

```ts
describe('ExportAudiobookModal — Captions (fs-52)', () => {
  beforeEach(() => {
    mockedApi.createBookExport.mockReset();
  });

  it('shows a Captions format option and its sub-controls when selected', async () => {
    renderModal();
    fireEvent.click(screen.getByTestId('export-format-captions'));
    expect(screen.getByTestId('captions-file-format-srt')).toBeInTheDocument();
    expect(screen.getByTestId('captions-granularity-sentence')).toBeInTheDocument();
    expect(screen.getByTestId('captions-scope-whole-book')).toBeInTheDocument();
  });

  it('submits the selected caption sub-fields on the export request', async () => {
    mockedApi.createBookExport.mockResolvedValue({
      id: 'exp_1',
      bookId: 'demo__sa__test',
      format: 'captions',
      captionFileFormat: 'vtt',
      captionGranularity: 'word',
      captionScope: 'per-chapter',
      destination: 'download',
      status: 'in_progress',
      filename: 'book.word.vtt.zip',
      sizeBytes: null,
      progress: 0,
      downloadUrl: null,
      syncPath: null,
      errorReason: null,
      createdAt: new Date().toISOString(),
      completedAt: null,
    } as BookExportJob);

    renderModal();
    fireEvent.click(screen.getByTestId('export-format-captions'));
    fireEvent.click(screen.getByTestId('captions-file-format-vtt'));
    fireEvent.click(screen.getByTestId('captions-granularity-word'));
    fireEvent.click(screen.getByTestId('captions-scope-per-chapter'));
    fireEvent.click(screen.getByTestId('export-submit'));

    await waitFor(() => expect(mockedApi.createBookExport).toHaveBeenCalled());
    expect(mockedApi.createBookExport).toHaveBeenCalledWith(
      'demo__sa__test',
      expect.objectContaining({
        format: 'captions',
        captionFileFormat: 'vtt',
        captionGranularity: 'word',
        captionScope: 'per-chapter',
      }),
    );
  });

  it('disables the Word granularity option when whisperPackageInstalled is false', async () => {
    mockedApi.getSidecarHealth.mockResolvedValue({
      status: 'reachable',
      url: '(mock)',
      whisperPackageInstalled: false,
    });
    renderModal();
    fireEvent.click(screen.getByTestId('export-format-captions'));
    await waitFor(() => expect(screen.getByTestId('captions-granularity-word')).toBeDisabled());
  });
});
```

The file already has a `renderModal(overrides)` helper (around line 82) defaulting `bookId: 'demo__sa__test'` — the tests above use it as-is via plain `renderModal()`. Add `getSidecarHealth: vi.fn(async () => ({ status: 'reachable', url: '(mock)', whisperPackageInstalled: true }))` to the mocked `api` object in the existing `vi.mock('../lib/api', ...)` factory at the top of the file, and add `getSidecarHealth: ReturnType<typeof vi.fn>;` to the `mockedApi` type cast right below the mock.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/modals/export-audiobook.test.tsx -t Captions`
Expected: FAIL — `Unable to find an element by: [data-testid="export-format-captions"]`

- [ ] **Step 3: Implement**

In `src/modals/export-audiobook.tsx`:

Widen `FormatId` (currently line 66):

```ts
type FormatId = 'm4b' | 'mp3-zip' | 'mp3-folder' | 'aac-m4a-zip' | 'opus-ogg-zip' | 'captions';
```

Add caption sub-field state alongside the existing `format`/`tab` state (after `const [format, setFormat] = useState<FormatId>(...)`):

```ts
  const [captionFileFormat, setCaptionFileFormat] = useState<'srt' | 'vtt'>('srt');
  const [captionGranularity, setCaptionGranularity] = useState<'line' | 'sentence' | 'word'>('sentence');
  const [captionScope, setCaptionScope] = useState<'whole-book' | 'per-chapter'>('whole-book');
  const [whisperAvailable, setWhisperAvailable] = useState(true);
```

Hydrate `whisperAvailable` alongside the existing LAN-URL hydration effect (add a new effect right after it):

```ts
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    api
      .getSidecarHealth()
      .then((h) => {
        if (!cancelled) setWhisperAvailable(h.whisperPackageInstalled !== false);
      })
      .catch(() => {
        /* swallow — Word stays enabled optimistically if the probe fails */
      });
    return () => {
      cancelled = true;
    };
  }, [open]);
```

Add `'captions'` to the generic format toggle button list (currently in the `!tileHint` block):

```ts
                    [
                      { id: 'm4b', label: 'M4B' },
                      { id: 'mp3-zip', label: 'MP3.ZIP' },
                      { id: 'aac-m4a-zip', label: 'AAC (M4A)' },
                      { id: 'opus-ogg-zip', label: 'Opus (Ogg)' },
                      { id: 'captions', label: 'Captions' },
                    ] as Array<{ id: FormatId; label: string }>
```

Render `<CaptionsOptions>` above the tab body when `format === 'captions'` (in the body `<div>`, right before the `{tileHint ? ... : tab === 'download' ? ... : ...}` block):

```tsx
            {format === 'captions' && (
              <CaptionsOptions
                fileFormat={captionFileFormat}
                setFileFormat={setCaptionFileFormat}
                granularity={captionGranularity}
                setGranularity={setCaptionGranularity}
                scope={captionScope}
                setScope={setCaptionScope}
                wordAvailable={whisperAvailable}
              />
            )}
```

Include the caption fields in the submit body (in `handleSubmit`, currently building `body` as `{ format, destination }`):

```ts
      const body: BookExportRequest = {
        format,
        destination: tab === 'sync-folder' ? 'sync-folder' : 'download',
        ...(format === 'captions'
          ? {
              captionFileFormat,
              captionGranularity,
              captionScope,
            }
          : {}),
      };
```

Add the footer description case (in the footer's format-description ternary chain, add a branch before the final `else`):

```ts
                : format === 'captions'
                  ? 'Captions: .srt/.vtt from your book’s render-time alignment. Word mode needs the sidecar’s Whisper model.'
                  : format === 'aac-m4a-zip'
```

Add the `CaptionsOptions` component at module scope, alongside `DownloadTab`/`SyncFolderTab`:

```tsx
interface CaptionsOptionsProps {
  fileFormat: 'srt' | 'vtt';
  setFileFormat: (v: 'srt' | 'vtt') => void;
  granularity: 'line' | 'sentence' | 'word';
  setGranularity: (v: 'line' | 'sentence' | 'word') => void;
  scope: 'whole-book' | 'per-chapter';
  setScope: (v: 'whole-book' | 'per-chapter') => void;
  wordAvailable: boolean;
}
function CaptionsOptions({
  fileFormat,
  setFileFormat,
  granularity,
  setGranularity,
  scope,
  setScope,
  wordAvailable,
}: CaptionsOptionsProps) {
  return (
    <div className="space-y-4 mb-4" data-testid="captions-options">
      <div>
        <span className="text-[11px] uppercase tracking-wider text-ink/50 font-semibold">
          File format
        </span>
        <div className="mt-1 flex items-center gap-1 bg-ink/4 rounded-full p-0.5 text-xs w-fit">
          {(['srt', 'vtt'] as const).map((f) => (
            <button
              key={f}
              type="button"
              data-testid={`captions-file-format-${f}`}
              onClick={() => setFileFormat(f)}
              className={`px-3 py-1.5 rounded-full font-medium transition-colors ${fileFormat === f ? 'bg-white text-ink shadow-card' : 'text-ink/60'}`}
            >
              {f.toUpperCase()}
            </button>
          ))}
        </div>
      </div>
      <div>
        <span className="text-[11px] uppercase tracking-wider text-ink/50 font-semibold">
          Granularity
        </span>
        <div className="mt-1 flex items-center gap-1 bg-ink/4 rounded-full p-0.5 text-xs w-fit">
          {(
            [
              { id: 'line', label: 'Line' },
              { id: 'sentence', label: 'Sentence' },
              { id: 'word', label: 'Word' },
            ] as const
          ).map((g) => (
            <button
              key={g.id}
              type="button"
              data-testid={`captions-granularity-${g.id}`}
              disabled={g.id === 'word' && !wordAvailable}
              title={g.id === 'word' && !wordAvailable ? 'Whisper is not installed on the server.' : undefined}
              onClick={() => setGranularity(g.id)}
              className={`px-3 py-1.5 rounded-full font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${granularity === g.id ? 'bg-white text-ink shadow-card' : 'text-ink/60'}`}
            >
              {g.label}
            </button>
          ))}
        </div>
      </div>
      <div>
        <span className="text-[11px] uppercase tracking-wider text-ink/50 font-semibold">
          Scope
        </span>
        <div className="mt-1 flex items-center gap-1 bg-ink/4 rounded-full p-0.5 text-xs w-fit">
          {(
            [
              { id: 'whole-book', label: 'Whole book' },
              { id: 'per-chapter', label: 'Per chapter' },
            ] as const
          ).map((s) => (
            <button
              key={s.id}
              type="button"
              data-testid={`captions-scope-${s.id}`}
              onClick={() => setScope(s.id)}
              className={`px-3 py-1.5 rounded-full font-medium transition-colors ${scope === s.id ? 'bg-white text-ink shadow-card' : 'text-ink/60'}`}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/modals/export-audiobook.test.tsx`
Expected: PASS (whole file, including the pre-existing suites).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/modals/export-audiobook.tsx src/modals/export-audiobook.test.tsx
git commit -m "feat(frontend): add Captions format + options to the export modal"
```

---

## Task 12: Frontend — Captions download tile

**Files:**
- Modify: `src/components/listen/listen-download-section.tsx`
- Modify: `src/components/listen/listen-download-section.test.tsx`
- Modify: `src/views/listen.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: `ListenDownloadSectionProps.onOpenCaptionsExport?: () => void`; a 5th "Captions" tile in the "Or download a file" grid.

- [ ] **Step 1: Write the failing test**

Add to `src/components/listen/listen-download-section.test.tsx`:

```ts
describe('ListenDownloadSection — Captions tile (fs-52)', () => {
  it('renders the Captions tile alongside the existing four download tiles', () => {
    renderSection({ onOpenCaptionsExport: vi.fn() });
    expect(screen.getByTestId('download-tile-captions')).toBeInTheDocument();
    const tile = screen.getByTestId('download-tile-captions');
    expect(tile.textContent).toMatch(/Captions/i);
  });

  it('fires onOpenCaptionsExport when the tile button is clicked', () => {
    const onOpenCaptionsExport = vi.fn();
    renderSection({ onOpenCaptionsExport });
    const tile = screen.getByTestId('download-tile-captions');
    const button = tile.querySelector('button');
    fireEvent.click(button!);
    expect(onOpenCaptionsExport).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/listen/listen-download-section.test.tsx -t Captions`
Expected: FAIL — `Unable to find an element by: [data-testid="download-tile-captions"]`

- [ ] **Step 3: Implement**

In `src/components/listen/listen-download-section.tsx`, add the prop to `ListenDownloadSectionProps`:

```ts
  /** fs-52 — captions tile handler. Called when the user clicks Download
      on the "Captions" tile; the orchestrator opens the export modal
      pre-set to format='captions'. */
  onOpenCaptionsExport?: () => void;
```

Destructure it in the component signature and add a 5th `<DownloadCard>` to the grid (after the "Portable bundle" card):

```tsx
          <DownloadCard
            title="Captions"
            format="srt / vtt"
            size="—"
            description="Line, sentence, or word-level captions from your book's alignment. Great for demo clips."
            testid="download-tile-captions"
            onDownload={onOpenCaptionsExport}
          />
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/listen/listen-download-section.test.tsx`
Expected: PASS

- [ ] **Step 5: Wire `listen.tsx`**

In `src/views/listen.tsx`, add a handler alongside the existing `onOpenM4bExport`/`onOpenMp3ZipExport` wiring (currently around line 266–267):

```ts
        onOpenCaptionsExport={() => setExportModal({ tab: 'download', format: 'captions' })}
```

The `exportModal` local state's `format` field (currently `format?: 'm4b' | 'mp3-zip' | 'mp3-folder';`, in the `useState<{...}>` type argument right above its declaration) is narrower than the modal's `FormatId` and doesn't include `'captions'` yet. Widen it:

```ts
    format?: 'm4b' | 'mp3-zip' | 'mp3-folder' | 'captions';
```

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/components/listen/listen-download-section.tsx src/components/listen/listen-download-section.test.tsx src/views/listen.tsx
git commit -m "feat(frontend): add Captions download tile to the listen view"
```

---

## Task 13: Frontend — queue adapter, types, mock realism, and warning display

**Files:**
- Modify: `src/lib/types.ts`
- Create: `src/lib/export-queue-adapter.test.ts`
- Modify: `src/lib/export-queue-adapter.ts`
- Modify: `src/lib/api.ts` (`mockCreateBookExport`)
- Modify: `src/components/export-queue-row.tsx`
- Create: `src/components/export-queue-row.test.tsx`

**Interfaces:**
- Produces: `ExportQueueItem.format` gains `'srt' | 'vtt'`; `ExportQueueItem.wireFormat` gains `'captions'`; `ExportQueueItem.warning?: string` (round-2-of-plan-review decision — surfaces `BookExportJob.warning`, Task 9); `bookExportJobToQueueItem` maps a captions job's badge from its scope/fileFormat, not a static table lookup, and passes `warning` through; `ExportQueueRow` shows the warning (amber caption) on a `done` row that has one, same priority slot `errorReason` uses for a `failed` row.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/export-queue-adapter.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { bookExportJobToQueueItem } from './export-queue-adapter';
import type { BookExportJob } from './types';

function job(overrides: Partial<BookExportJob>): BookExportJob {
  return {
    id: 'exp_1',
    bookId: 'bk_1',
    format: 'mp3-zip',
    destination: 'download',
    status: 'done',
    filename: 'book.zip',
    sizeBytes: 1024,
    progress: 1,
    downloadUrl: '/download',
    syncPath: null,
    errorReason: null,
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    ...overrides,
  } as BookExportJob;
}

describe('bookExportJobToQueueItem — captions (fs-52)', () => {
  it('badges a whole-book .srt export as srt', () => {
    const item = bookExportJobToQueueItem(
      job({ format: 'captions', captionFileFormat: 'srt', captionScope: 'whole-book', filename: 'book.sentence.srt' }),
    );
    expect(item.format).toBe('srt');
  });

  it('badges a whole-book .vtt export as vtt', () => {
    const item = bookExportJobToQueueItem(
      job({ format: 'captions', captionFileFormat: 'vtt', captionScope: 'whole-book', filename: 'book.sentence.vtt' }),
    );
    expect(item.format).toBe('vtt');
  });

  it('badges a per-chapter caption export as zip regardless of file format', () => {
    const item = bookExportJobToQueueItem(
      job({ format: 'captions', captionFileFormat: 'srt', captionScope: 'per-chapter', filename: 'book.line.srt.zip' }),
    );
    expect(item.format).toBe('zip');
  });

  it('carries the persisted warning through to the queue item', () => {
    const item = bookExportJobToQueueItem(
      job({
        format: 'captions',
        captionFileFormat: 'srt',
        captionScope: 'whole-book',
        warning: "Some of this book's chapters predate render-time staleness tracking...",
      }),
    );
    expect(item.warning).toMatch(/predate render-time staleness/);
  });

  it('leaves warning undefined when the job has none', () => {
    const item = bookExportJobToQueueItem(job({ format: 'mp3-zip' }));
    expect(item.warning).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/export-queue-adapter.test.ts`
Expected: FAIL — `expected undefined to be 'srt'` (captions isn't in `FORMAT_TO_VIEW`, so `?? 'zip'` masks the failure for the zip case but not srt/vtt).

- [ ] **Step 3: Implement**

In `src/lib/types.ts`, widen `ExportQueueItem` (currently lines 749–773):

```ts
  format: 'm4b' | 'm4a' | 'mp3' | 'zip' | 'link' | 'srt' | 'vtt';
```

and

```ts
  wireFormat?: 'mp3-zip' | 'm4b' | 'mp3-folder' | 'aac-m4a-zip' | 'opus-ogg-zip' | 'captions';
```

and, on its own new line in the interface (round-2-of-plan-review decision — surfaces the persisted `BookExportJob.warning` from Task 9):

```ts
  /** Non-fatal advisory to show alongside a `done` row — e.g. captions
      built from segments that predate render-time staleness tracking. */
  warning?: string;
```

In `src/lib/export-queue-adapter.ts`, replace the static-table lookup for `format` with a function that special-cases captions:

```ts
function viewFormatFor(job: BookExportJob): ExportQueueItem['format'] {
  if (job.format === 'captions') {
    return job.captionScope === 'per-chapter' ? 'zip' : job.captionFileFormat === 'vtt' ? 'vtt' : 'srt';
  }
  return FORMAT_TO_VIEW[job.format] ?? 'zip';
}
```

Update the `FORMAT_TO_VIEW` record's type to exclude `'captions'` from its keys (since it's now handled separately) — change:

```ts
const FORMAT_TO_VIEW: Record<Exclude<BookExportJob['format'], 'captions'>, ExportQueueItem['format']> = {
```

And update `bookExportJobToQueueItem`'s return object to add `warning` alongside the existing `format:` line:

```ts
    format: viewFormatFor(job),
    warning: job.warning ?? undefined,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/export-queue-adapter.test.ts`
Expected: PASS

- [ ] **Step 5: Mock realism — `mockCreateBookExport` filename**

In `src/lib/api.ts`, update `mockCreateBookExport`'s `filename` computation (currently `body.format === 'mp3-zip' ? 'zip' : 'm4b'`):

```ts
    filename:
      body.format === 'captions'
        ? `Mock audiobook.${body.captionGranularity}.${body.captionFileFormat}${body.captionScope === 'per-chapter' ? '.zip' : ''}`
        : `Mock audiobook.${body.format === 'mp3-zip' ? 'zip' : 'm4b'}`,
```

Also copy the three caption fields onto the constructed `job` object so `bookExportJobToQueueItem` badges the mock row correctly:

```ts
  const job: BookExportJob = {
    id,
    bookId,
    format: body.format,
    captionFileFormat: body.captionFileFormat,
    captionGranularity: body.captionGranularity,
    captionScope: body.captionScope,
    destination: body.destination,
    ...
```

- [ ] **Step 6: `ExportQueueRow` warning display**

Write the failing test first. Create `src/components/export-queue-row.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ExportQueueRow } from './export-queue-row';
import type { ExportQueueItem } from '../lib/types';

function item(overrides: Partial<ExportQueueItem> = {}): ExportQueueItem {
  return {
    id: 'exp_1',
    filename: 'book.srt',
    format: 'srt',
    size: '4 KB',
    status: 'done',
    timestamp: 'just now',
    destination: 'Downloaded',
    ...overrides,
  };
}

describe('ExportQueueRow — warning display (fs-52)', () => {
  it('shows the warning caption on a done row that has one', () => {
    render(<ExportQueueRow item={item({ warning: 'Could not verify staleness for some chapters.' })} />);
    expect(screen.getByText(/Could not verify staleness/)).toBeInTheDocument();
  });

  it('falls back to the destination caption when there is no warning', () => {
    render(<ExportQueueRow item={item({ destination: 'Downloaded' })} />);
    expect(screen.getByText('Downloaded')).toBeInTheDocument();
  });

  it('prioritises errorReason over warning on a failed row (should never co-occur, but errorReason wins)', () => {
    render(
      <ExportQueueRow
        item={item({ status: 'failed', errorReason: 'Build failed.', warning: 'Ignored.' })}
      />,
    );
    expect(screen.getByText('Build failed.')).toBeInTheDocument();
    expect(screen.queryByText('Ignored.')).not.toBeInTheDocument();
  });
});
```

Run: `npx vitest run src/components/export-queue-row.test.tsx`
Expected: FAIL — the warning test finds no matching text (the row currently only ever renders `errorReason` or `destination`).

Implement. In `src/components/export-queue-row.tsx`, the caption line currently reads:

```tsx
        {item.errorReason ? (
          <span className="block text-[11px] text-rose-600 truncate mt-0.5">
            {item.errorReason}
          </span>
        ) : (
          <span className="block text-[11px] text-ink/55 truncate mt-0.5">{item.destination}</span>
        )}
```

Add a warning branch between them:

```tsx
        {item.errorReason ? (
          <span className="block text-[11px] text-rose-600 truncate mt-0.5">
            {item.errorReason}
          </span>
        ) : item.warning ? (
          <span className="block text-[11px] text-amber-700 truncate mt-0.5">{item.warning}</span>
        ) : (
          <span className="block text-[11px] text-ink/55 truncate mt-0.5">{item.destination}</span>
        )}
```

Run: `npx vitest run src/components/export-queue-row.test.tsx`
Expected: PASS

- [ ] **Step 7: Run the full frontend suite**

Run: `npx vitest run src/lib/api.test.ts src/lib/export-queue-adapter.test.ts src/components/export-queue-row.test.tsx`
Expected: PASS

- [ ] **Step 8: Typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/lib/types.ts src/lib/export-queue-adapter.ts src/lib/export-queue-adapter.test.ts src/lib/api.ts src/components/export-queue-row.tsx src/components/export-queue-row.test.tsx
git commit -m "feat(frontend): badge caption exports + surface the staleness-unverifiable warning in the queue rail"
```

---

## Task 14: E2E — Captions tile → modal → queue → download

**Files:**
- Create: `e2e/captions-export.spec.ts`

**Interfaces:**
- Consumes: mock API mode (`VITE_USE_MOCKS=true`), the Solway Bay fixture book (`#/books/sb/listen`) used by `e2e/download-tiles.spec.ts`.

- [ ] **Step 1: Write the spec**

Create `e2e/captions-export.spec.ts`:

```ts
import { test, expect } from '@playwright/test';
import { waitForRouteReady } from './helpers';

/**
 * fs-52 — Captions tile e2e. Mirrors e2e/download-tiles.spec.ts's pattern
 * for the M4B/MP3 ZIP tiles: open the tile, confirm the modal opens
 * pre-set to format='captions', pick a granularity/scope/file-format,
 * submit, and confirm the mock export job reaches 'done' with a download
 * link. Word-mode ASR is mocked (mockCreateBookExport) — no real Whisper
 * model needed to exercise the UI flow.
 *
 * Pairs with docs/features/2026-07-10-fs52-caption-srt-export.md.
 */
test.describe.configure({ mode: 'serial' });

test.describe('fs-52 — captions export tile', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/#/books/sb/listen');
    await expect(page.getByRole('heading', { name: /Solway Bay/i, level: 1 })).toBeVisible({
      timeout: 10_000,
    });
    await waitForRouteReady(page);
  });

  test('Captions tile opens the export modal with captions pre-selected', async ({ page }) => {
    const tile = page.getByTestId('download-tile-captions');
    await expect(tile).toBeVisible();
    const button = tile.getByRole('button', { name: /Download/i });
    await expect(button).toBeEnabled();
    await button.click();
    await expect(page.getByTestId('export-audiobook-modal')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('export-format-captions')).toBeVisible();
    await expect(page.getByTestId('captions-options')).toBeVisible();
  });

  test('picking word/vtt/per-chapter and submitting reaches a done job with a download link', async ({
    page,
  }) => {
    await page.getByTestId('download-tile-captions').getByRole('button', { name: /Download/i }).click();
    await expect(page.getByTestId('export-audiobook-modal')).toBeVisible({ timeout: 10_000 });

    await page.getByTestId('captions-file-format-vtt').click();
    await page.getByTestId('captions-granularity-word').click();
    await page.getByTestId('captions-scope-per-chapter').click();
    await page.getByTestId('export-submit').click();

    await expect(page.getByTestId('export-active-job')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('export-active-job')).toContainText(/Done/, { timeout: 10_000 });
  });
});
```

- [ ] **Step 2: Run the spec**

Run: `npm run test:e2e -- captions-export`
Expected: PASS — `ExportQueueRow`'s `statusUI.done` (`src/components/export-queue-row.tsx`) renders the literal text "Done" once the mock job's `status` flips, which `toContainText(/Done/)` matches.

- [ ] **Step 3: Commit**

```bash
git add e2e/captions-export.spec.ts
git commit -m "test(e2e): add Captions tile export flow spec"
```

---

## Task 15: Docs — regression plan, index, release notes, backlog

**Files:**
- Create: `docs/features/2026-07-10-fs52-caption-srt-export.md`
- Modify: `docs/features/INDEX.md`
- Modify: `docs/release-notes-next.md`
- Modify: `RELEASE_NOTES.md`
- Modify: `docs/BACKLOG.md`

- [ ] **Step 1: Write the regression plan**

Create `docs/features/2026-07-10-fs52-caption-srt-export.md` from `docs/features/TEMPLATE.md`'s structure, filled in from the design spec (`docs/superpowers/specs/2026-07-10-fs52-caption-srt-export-design.md`) and this plan:

```markdown
---
status: active
shipped: null
owner: null
---

# fs-52 — Caption/SRT export

> Status: active
> Key files: `server/src/export/build-captions.ts`, `server/src/export/caption-cues.ts`, `server/src/export/caption-format.ts`, `server/src/export/manuscript-sentences.ts`, `server/src/routes/export.ts`, `src/modals/export-audiobook.tsx`, `src/components/listen/listen-download-section.tsx`
> URL surface: `#/books/<id>/listen` (Captions download tile)
> OpenAPI ops: `POST /api/books/{id}/exports` (format: captions), `GET /api/books/{id}/exports/{exportId}`, `GET /api/books/{id}/exports/{exportId}/download`

## Benefit / Rationale

- **User:** export `.srt`/`.vtt` captions in line/sentence/word granularity, whole-book or per-chapter, for any finished book — abogen-parity feature that also feeds demo/social clips.
- **Technical:** line/sentence captions are pure metadata reconstructions over data already on disk (`segments.json` + `manuscript-edits.json`) — no new render-time cost. Word captions add one on-demand whole-chapter Whisper pass at export time only.
- **Architectural:** extends the existing `BookExportJob` queue rather than a parallel export subsystem — same progress polling, download endpoint, and queue-rail UI as every other export format.

## Architectural impact

- New sidecar capability: `/transcribe` accepts `X-Word-Timestamps`, gated additively — the existing ASR content-QA caller (`segment-asr-qa.ts`) never sets it, so its decode profile and tests are unaffected.
- `BookExportJob`'s de-dupe (`revokeStaleSameFormat`) and filename derivation (`bookFilename`) are now variant-aware for `format: 'captions'` (keyed on `captionFileFormat`/`captionGranularity`/`captionScope`, not `format` alone) — the 12 caption variants no longer collide.
- No `segments.json` schema change — the per-sentence shape from plan 70d already carries everything line/sentence captions need.
- Reversibility: every new file lives under `server/src/export/`; reverting is a multi-file `git revert` of this feature's commits, no data migration involved.

## Invariants to preserve

1. Line-mode cues never exceed `LINE_MAX_DURATION_SEC` (7s) or `LINE_MAX_CHARS` (200 chars) combined, and always close on a speaker change — `server/src/export/caption-cues.ts:LINE_MAX_DURATION_SEC/LINE_MAX_CHARS`.
2. Word-mode ASR is always one whole-chapter `/transcribe` call, never per-sentence — `server/src/export/caption-cues.ts:buildWordCues`.
3. Sentence text for line/sentence captions comes from `manuscript-edits.json`, never the analysis cache — `server/src/export/manuscript-sentences.ts`.
4. `condition_on_previous_text` is `True` only when `word_timestamps=True` — `server/tts-sidecar/main.py:WhisperEngine.transcribe`.
5. The captions de-dupe key includes `captionFileFormat`/`captionGranularity`/`captionScope`, not just `format` — `server/src/routes/export.ts:revokeStaleSameFormat`.
6. A sentence/line segment whose `textHash` no longer matches its current manuscript text fails the export with a clear "regenerate this chapter" error; a segment with no `textHash` at all (pre-#1105 render) instead sets a non-fatal, persisted `BookExportJob.warning` rather than silently proceeding OR silently blocking — `server/src/export/caption-cues.ts:assertNotStale/hasUnverifiableTextHash`.

## Test plan

### Automated coverage

- Pytest sidecar (`server/tts-sidecar/tests/test_transcribe.py`) — word_timestamps decode profile + route header threading.
- Vitest server (`server/src/tts/transcribe-client.test.ts`) — wire contract for `wordTimestamps`.
- Vitest server (`server/src/export/manuscript-sentences.test.ts`, `caption-format.test.ts`, `caption-cues.test.ts`, `build-captions.test.ts`) — pure cue/format logic + orchestration, including the staleness guard and the unverifiable-textHash warning.
- Vitest server (`server/src/routes/export.test.ts`) — end-to-end job creation, MIME type, de-dupe-by-variant, persisted warning surfacing on a completed job.
- Vitest frontend (`src/modals/export-audiobook.test.tsx`, `src/components/listen/listen-download-section.test.tsx`, `src/lib/export-queue-adapter.test.ts`, `src/components/export-queue-row.test.tsx`) — UI + queue badge + warning display.
- Playwright e2e (`e2e/captions-export.spec.ts`) — tile → modal → done job → download link, mock-mode.

### Manual acceptance walkthrough

Run in mock mode (`VITE_USE_MOCKS=true`) unless testing word-mode against a real Whisper install.

1. Open `#/books/sb/listen` → Captions tile visible in "Or download a file".
2. Click Download on the Captions tile → export modal opens with Captions pre-selected, granularity/scope/file-format controls visible.
3. Pick Sentence + Whole book + .srt → Build download → job reaches `done` → Download link streams a `.srt` starting `1\n00:00:00,000 --> ...`.
4. Pick Line + Per chapter + .vtt → job reaches `done` → downloaded `.zip` contains one `.vtt` per chapter.
5. Against a real backend with Whisper installed: pick Word + Whole book + .srt on a real rendered book → job completes → resulting `.srt` shows one cue per word with plausible timing.
6. Against a real backend WITHOUT Whisper installed: Word option is disabled with a tooltip; forcing the request via curl returns a clear `errorReason`, never a silent fallback to estimated timing.
7. Against a real backend, on a book rendered before segments carried `textHash` (or a fresh fixture with the field stripped): export Sentence + Whole book → job still reaches `done`, but the queue row shows an amber "couldn't fully verify" caption instead of the normal destination text.

## Out of scope

- Manual caption-cue editing UI.
- Burned-in/hardsub video generation.
- Running word-mode ASR during synthesis (export-time only).

## Ship notes

(Filled in when status flips to `stable`.)
```

- [ ] **Step 2: Add the INDEX.md entry**

In `docs/features/INDEX.md`, add a new entry under the appropriate area section (near other export-related plans):

```markdown
- [fs-52 — Caption/SRT export](2026-07-10-fs52-caption-srt-export.md) — `active`. Emits `.srt`/`.vtt` captions in line/sentence/word granularity, whole-book or per-chapter, extending the existing `BookExportJob` queue. Line/sentence are pure metadata reconstructions over `segments.json` + `manuscript-edits.json`; word mode runs one whole-chapter Whisper pass at export time.
```

- [ ] **Step 3: Add release-notes entries**

In `docs/release-notes-next.md`, add a bullet under the current in-progress version section (technical register, PR-refed once the PR number is known — use a placeholder `#PR` the PR author fills in at open time):

```markdown
- Caption/SRT export (fs-52, #PR): new `captions` `BookExportJob` format — `.srt`/`.vtt` in line/sentence/word granularity, whole-book or per-chapter scope. Line/sentence read `segments.json` + `manuscript-edits.json` directly (no new render-time data); word mode adds a `/transcribe` `word_timestamps` capability to the sidecar and runs one whole-chapter Whisper pass at export time.
```

In `RELEASE_NOTES.md`, add a brand-voice user-facing bullet to the in-progress version section at the top:

```markdown
- **Your book can now travel as captions.** A new Captions tile on the Listen screen exports `.srt`/`.vtt` files straight from your book's own performance — pick line-by-line, sentence-by-sentence, or word-by-word timing, one file per chapter or the whole book at once. Perfect for adding subtitles to a clip or sharing a scene.
```

- [ ] **Step 4: Remove the fs-52 row from BACKLOG.md**

In `docs/BACKLOG.md`, delete the `fs-52` entry (the `#### \`fs-52\` — Caption/SRT export...` block) — it's shipping, not backlog anymore.

- [ ] **Step 5: Commit**

```bash
git add docs/features/2026-07-10-fs52-caption-srt-export.md docs/features/INDEX.md docs/release-notes-next.md RELEASE_NOTES.md docs/BACKLOG.md
git commit -m "docs(docs): add fs-52 regression plan, release notes, and backlog cleanup"
```

---

## Final steps (after Task 15)

1. Run the full local battery: `npm run verify:fast:branch` (or `npm run verify` for the complete local suite, given this branch touches `server/tts-sidecar/**` — `test:sidecar` is scope-gated to fire).
2. Push the branch, open the PR with `Closes #975` in the body.
3. Run the mandatory `code-review` pass (per CLAUDE.md's model-routing table — this is a multi-scope `feat` PR spanning sidecar/server/frontend, so `high` effort) before merge.
