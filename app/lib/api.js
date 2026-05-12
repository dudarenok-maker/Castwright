/* Mock API client.

   ─── PURPOSE ─────────────────────────────────────────────────────────────
   Provides the surface a real backend would expose, with hand-mocked
   responses. Front-end code imports ONLY through this layer — when the
   backend ships, swap the function bodies for fetch() calls and keep the
   response shapes identical (documented as JSDoc typedefs below).
   ────────────────────────────────────────────────────────────────────────── */

/** @typedef  {Object} UploadResponse
 *  @property {string} manuscriptId  Server-assigned id.
 *  @property {string} format        'md' | 'txt' | 'epub' | 'docx'
 *  @property {string} title         Inferred from first H1, else filename.
 *  @property {number} wordCount
 *  @property {number} byteSize
 *  @property {string} uploadedAt    ISO 8601.
 *  @property {string} sourceText    Full manuscript text — returned for
 *                                   client-side preview (large books may
 *                                   move this to a separate GET).            */

/** @typedef  {Object} AnalyseResponse
 *  @property {string} bookId
 *  @property {string} manuscriptId
 *  @property {string} title
 *  @property {Array<{id:number,label:string,detail:string,durationMs:number}>} phaseTimings
 *  @property {Array<Character>} characters
 *  @property {Array<Chapter>}   chapters
 *  @property {Array<Sentence>}  sentences
 *  @property {Array<{characterId:string,fromBookTitle:string,fromVoiceId:string,confidence:number}>} libraryMatches
 */

/** Real endpoint: POST /api/manuscripts  (multipart or JSON {text, fileName, format})
 *  @returns {Promise<UploadResponse>}                                        */
async function mockUploadManuscript({ text, fileName, format }) {
  await wait(350);
  const h1 = text.match(/^#\s+(.+)$/m);
  const title = (h1 && h1[1].trim())
              || (fileName ? fileName.replace(/\.[^.]+$/, '') : 'Untitled manuscript');
  return {
    manuscriptId: 'mns_' + Math.random().toString(36).slice(2, 10),
    format: format || inferFormat(fileName) || 'md',
    title,
    wordCount: text.trim().split(/\s+/).filter(Boolean).length,
    byteSize: new Blob([text]).size,
    uploadedAt: new Date().toISOString(),
    sourceText: text,
  };
}

/** Real endpoint: POST /api/manuscripts/:id/analysis
 *  In production this would be long-running — likely SSE/WebSocket pushing
 *  phase updates, then a final payload. The `onPhase` callback simulates
 *  that streaming surface here.
 *  @param {string} manuscriptId
 *  @param {{onPhase?: (e:{phaseId:number, progress:number}) => void}} opts
 *  @returns {Promise<AnalyseResponse>}                                       */
async function mockAnalyseManuscript(manuscriptId, { onPhase } = {}) {
  const res = ANALYSIS_NORTHERN_STAR;
  for (const ph of res.phaseTimings) {
    const start = Date.now();
    await new Promise(resolve => {
      const t = setInterval(() => {
        const progress = Math.min(1, (Date.now() - start) / ph.durationMs);
        onPhase?.({ phaseId: ph.id, progress });
        if (progress >= 1) { clearInterval(t); resolve(); }
      }, 60);
    });
  }
  return {
    bookId: res.bookId,
    manuscriptId,
    title: res.title,
    phaseTimings: res.phaseTimings,
    characters: res.characters,
    chapters: res.chapters,
    sentences: res.sentences,
    libraryMatches: res.libraryMatches,
  };
}

function inferFormat(fileName) {
  if (!fileName) return null;
  const m = fileName.toLowerCase().match(/\.([a-z0-9]+)$/);
  if (!m) return null;
  return { md: 'md', markdown: 'md', txt: 'txt', text: 'txt', epub: 'epub', docx: 'docx' }[m[1]] || null;
}

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
function parseDuration(str) {
  // accepts "MM:SS" or "HH:MM:SS"
  const parts = String(str).split(':').map(Number);
  if (parts.some(isNaN)) return 0;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

/* ─── 4. VOICE MATCHING ────────────────────────────────────────────────────
   Real endpoint: POST /api/books/:bookId/voice-match
     body: { characters: [{id, attributes, tone, evidenceQuotes}], libraryVoiceIds: [...] }
   Response shape: VoiceMatchResponse
     {
       matches: [
         {
           characterId: string,
           candidates: [
             {
               voiceId: string,
               fromBookTitle: string,
               score: number,              // 0..1 overall similarity
               factors: [{ id, label, score, detail }]   // why this voice matched
             }
           ]
         }
       ]
     }
   The backend computes similarity from embeddings (timbre + prosody) and rule
   features (regional cues, age inference, sentence rhythm). Mock returns one
   candidate per character with a hand-authored factor breakdown.            */
async function mockMatchVoices({ bookId, characters }) {
  await wait(450);
  const matches = (characters || []).map(c => {
    const factors = MATCH_FACTORS[c.id] || [];
    if (!c.matchedFrom || !factors.length) {
      return { characterId: c.id, candidates: [] };
    }
    return {
      characterId: c.id,
      candidates: [{
        voiceId: c.voiceId,
        fromBookTitle: c.matchedFrom.bookTitle,
        score: c.matchedFrom.confidence,
        factors: factors.map(f => ({ id: f.id, label: f.label, score: f.score, detail: f.detail })),
      }],
    };
  });
  return { bookId, matches };
}

/* ─── 5. GENERATION ────────────────────────────────────────────────────────
   Real endpoint: POST /api/books/:bookId/generation/start  (kicks off jobs)
                  GET  /api/books/:bookId/generation/stream  (SSE/WebSocket)
   Stream events: GenerationTick
     {
       type: 'progress' | 'chapter_complete' | 'chapter_failed' | 'idle',
       chapterId: number,
       characterId: string | null,    // null = chapter-wide tick
       progress: number,              // 0..1 for this chapter
       currentLine: number,
       totalLines: number,
       errorReason?: string
     }
   Mock drives ticks off a wall-clock timer; backend should emit on actual
   audio-chunk completion.                                                   */
function mockStreamGeneration({ bookId, getChapters, onTick }) {
  const tick = () => {
    const chapters = getChapters();
    const active = chapters.find(c => c.state === 'in_progress');
    if (!active) { onTick({ type: 'idle' }); return; }
    const nextProgress = Math.min(1, (active.progress || 0) + 0.02);
    onTick({
      type: nextProgress >= 1 ? 'chapter_complete' : 'progress',
      chapterId: active.id,
      characterId: null,
      progress: nextProgress,
      currentLine: Math.round((active.totalLines || 600) * nextProgress),
      totalLines: active.totalLines || 600,
    });
  };
  const handle = setInterval(tick, 1200);
  return () => clearInterval(handle);   // cancel handle
}

/* ─── 6. AUDIO PLAYBACK ────────────────────────────────────────────────────
   Real endpoint: GET /api/books/:bookId/chapters/:chapterId/audio
   Response: ChapterAudio
     {
       url: string,           // signed MP3/Opus URL
       durationSec: number,
       peaks: number[],       // pre-computed waveform peaks (0..1)
       sampleRate: number,
       segments: [{ start, end, characterId, sentenceId }]
     }
   Front-end uses a real <audio> element with currentTime tracking — see
   MiniPlayer. Mock returns no url (silent), real duration + faked peaks so
   the scrubber + waveform behave authentically.                             */
async function mockGetChapterAudio({ bookId, chapterId, duration }) {
  await wait(120);
  const totalSec = parseDuration(duration || '10:00');
  const peakCount = 240;
  const peaks = Array.from({ length: peakCount }, (_, i) => {
    // pseudo-realistic envelope: low at edges, mid-energy with variation
    const base = 0.35 + 0.45 * Math.sin((i / peakCount) * Math.PI);
    return Math.max(0.05, Math.min(1, base + (Math.random() - 0.5) * 0.35));
  });
  return {
    url: null,            // real backend returns a signed URL; mock plays via timer
    durationSec: totalSec,
    peaks,
    sampleRate: 44100,
    segments: [],         // backend would populate from alignment data
  };
}

/* ─── 7. REVISIONS & DRIFT ─────────────────────────────────────────────────
   Real endpoint: GET /api/books/:bookId/revisions
   Response: RevisionsResponse
     {
       pending: [Revision],          // A/B diffs awaiting accept/reject
       drift:   [DriftEvent]         // continuous detector output
     }
   Polled every 30s, or pushed via the same generation stream.               */
async function mockPollRevisions({ bookId }) {
  await wait(200);
  return {
    pending: PENDING_REVISIONS,
    drift:   VOICE_DRIFT_EVENTS,
  };
}

window.api = {
  uploadManuscript:  mockUploadManuscript,
  analyseManuscript: mockAnalyseManuscript,
  matchVoices:       mockMatchVoices,
  streamGeneration:  mockStreamGeneration,
  getChapterAudio:   mockGetChapterAudio,
  pollRevisions:     mockPollRevisions,
};
