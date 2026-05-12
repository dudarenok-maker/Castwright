/* Canned mock data for the API.

   ─── BACKEND CONTRACTS ────────────────────────────────────────────────────
   These constants are what the real API endpoints must return. Front-end
   code reads them via lib/api.js — when wiring real endpoints, swap the mock
   implementations there to call fetch() and keep response shapes identical.

   The manuscript text below is kept in sync with
       app/mocks/manuscripts/the-northern-star.md
   ─────────────────────────────────────────────────────────────────────────── */

/** Mock for: GET /api/manuscripts/:id (sourceText field) — i.e. the raw upload. */
const SAMPLE_MANUSCRIPT_MD = `# The Northern Star

*Northern Coast Trilogy · Book 2*
By Mike Dudarenok

---

## Chapter 1 — The Berth at Liverpool

The wind had turned by the time Halloran reached the wheelhouse. He could feel it before he saw it — a pressure shift behind his right ear that thirty winters at sea had taught him to trust more than any instrument the Admiralty could nail to a wall.

"Hard to starboard," he said, not loudly, because Halloran had never had to be loud to be obeyed. "And send word below: tell the cook we'll not be eating warm tonight."

From the corner of his eye he saw the girl move — the same girl who'd been pretending for three days now to belong to no one in particular. She was thinner than the manifest she wasn't on. He pretended, in turn, not to notice.

"You'll get us all drowned, you old fool." She said it under her breath, which is how she said most of the things she meant.

"Possibly," Halloran allowed, "though not in the next hour, and not by my hand."

Below decks, Marcus was already moving. The cook had been at sea long enough to read the pitch of the deck the way other men read a clock. "Cold supper it is, then." He said it to the empty galley, which is the only place a man like Marcus ever truly spoke first.

## Chapter 2 — A Manifest Two Names Short

The ledger lay open on the captain's table, two names short of the count of bodies aboard. Halloran ran a thumb down the column, paused, and ran it down again.

"You knew?" Eliza asked, from the doorway. She had not been invited.

"I suspected."

"And said nothing."

"I am saying something now."

She crossed her arms. "What did you suspect?"

"That you were not a girl who'd come aboard by accident."

## Chapter 3 — What the Captain Knew

(Manuscript continues.)
`;

/* ── Mock for: POST /api/manuscripts/:id/analysis ─────────────────────────────
   Full AnalyseResponse contract. Pulls forward the previously-static fixtures
   (initialCharacters, initialChapters, initialSentences) into the single
   payload shape the backend should return.

   Shape:
     {
       bookId:        string                — id under which the book is stored
       manuscriptId:  string                — echo of the upload id
       title:         string                — inferred from H1
       phaseTimings:  Array<{id, label, detail, durationMs}>
       characters:    Array<Character>      — see app/data/characters.js
       chapters:      Array<Chapter>        — see app/data/chapters.js
       sentences:     Array<Sentence>       — Chapter-1 only in this mock
       libraryMatches: Array<{characterId, fromBookTitle, fromVoiceId, confidence}>
     }                                                                          */
const ANALYSIS_NORTHERN_STAR = {
  bookId: 'ns',
  manuscriptId: null, // filled by the mock fn
  title: 'The Northern Star',
  phaseTimings: [
    { id: 0, label: 'Reading manuscript',   detail: 'Parsing markdown, mapping chapters and scenes.',                            durationMs: 1500 },
    { id: 1, label: 'Detecting characters', detail: 'Named-entity extraction, dialogue attribution, speaker resolution.',        durationMs: 2200 },
    { id: 2, label: 'Profiling voices',     detail: 'Inferring age, register, regional cues, sentence rhythm from each speaker.', durationMs: 2400 },
    { id: 3, label: 'Matching library',     detail: 'Reconciling against voices from your previous books.',                       durationMs: 1500 },
  ],
  /* characters, chapters, sentences references — populated at bottom of file
     so we can reuse the existing fixtures. */
  get characters()  { return initialCharacters; },
  get chapters()    { return initialChapters; },
  get sentences()   { return initialSentences; },
  libraryMatches: [
    { characterId: 'narrator', fromBookTitle: 'Solway Bay', fromVoiceId: 'v_anders', confidence: 0.94 },
  ],
};

Object.assign(window, { SAMPLE_MANUSCRIPT_MD, ANALYSIS_NORTHERN_STAR });
