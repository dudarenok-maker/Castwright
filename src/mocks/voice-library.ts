/* fs-38 Wave 1, Task 12 — mock fixtures for the book-independent voice
   library ("My voices", GET /api/voice-library and friends). Distinct from
   ../mocks/voices.ts, which mocks GET /api/voices (the confirmed-cast-
   derived list) — see the doc comment on api-types.ts's listVoiceLibrary
   operation for the split.

   Four entries cover the states the voice-library view + assign flows need
   to exercise under VITE_USE_MOCKS: a pinned voice, a voice promoted from a
   confirmed cast member, a voice whose Qwen base model has moved on since it
   was designed (stale), and a voice currently assigned to a confirmed cast
   member so DELETE-without-confirm has something real to 409 against. */

import type { components } from '../lib/api-types';

export type VoiceLibraryEntry = components['schemas']['VoiceLibraryEntry'];

const CREATED_AT = '2026-06-01T09:00:00.000Z';
const UPDATED_AT = '2026-06-15T14:30:00.000Z';

export const MOCK_VOICE_LIBRARY_ENTRIES: VoiceLibraryEntry[] = [
  {
    voiceUuid: 'lib-pinned',
    name: 'Captain Halloran',
    provenance: 'designed',
    tags: ['narrator', 'gruff'],
    pinned: true,
    persona: 'A weathered ship captain, baritone, northern English, authoritative.',
    engines: { qwen: { status: 'ready', baseModel: 'qwen3-tts-0.6b-2026-05' } },
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
  },
  {
    voiceUuid: 'lib-promoted',
    name: 'Eliza Gray',
    provenance: 'designed',
    tags: [],
    pinned: false,
    persona: 'A defiant working-class Londoner in her 20s, alto.',
    engines: { qwen: { status: 'ready', baseModel: 'qwen3-tts-0.6b-2026-05' } },
    promotedFrom: { bookId: 'ns', characterId: 'eliza' },
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
  },
  {
    voiceUuid: 'lib-stale',
    name: 'Marcus the Cook',
    provenance: 'designed',
    tags: [],
    pinned: false,
    persona: 'A wry Welsh ship cook, tenor, 50s.',
    engines: { qwen: { status: 'stale', baseModel: 'qwen3-tts-0.6b-2026-01' } },
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
  },
  {
    voiceUuid: 'lib-used',
    name: 'The Lighthouse Keeper',
    provenance: 'designed',
    tags: [],
    pinned: false,
    persona: 'A weathered Scottish lighthouse keeper, bass, 70s.',
    engines: { qwen: { status: 'ready', baseModel: 'qwen3-tts-0.6b-2026-05' } },
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
  },
  {
    voiceUuid: 'lib-cloned-demo',
    name: 'Mum (cloned)',
    provenance: 'cloned',
    tags: [],
    pinned: false,
    consent: {
      personName: 'Mum',
      relationship: 'family-with-permission',
      permittedUse: 'personal',
      attestedAt: '2026-07-20T00:00:00Z',
      attestedBy: 'me',
    },
    master: {
      clipFile: 'master.wav',
      sampleRate: 24_000,
      durationSeconds: 12,
      transcript: 'demo',
      transcriptSource: 'whisper',
      captureMethod: 'record',
    },
    engines: {},
    createdAt: '2026-07-20T00:00:00Z',
    updatedAt: '2026-07-20T00:00:00Z',
  },
];

/* Returned by DELETE /api/voice-library/lib-used without ?confirm=1 — mirrors
   the server's scanLibraryVoiceUsage shape (server/src/routes/voice-library.ts).
   Points at the "sb"/"keeper" fixtures already used by ../mocks/voices.ts's
   MOCK_VOICE_LIBRARY (v_keeper), so the 409 usage list reads like a real
   cross-reference instead of a made-up placeholder. */
export const MOCK_VOICE_LIBRARY_USAGE: {
  bookId: string;
  bookTitle: string;
  characterId: string;
  characterName: string;
}[] = [
  {
    bookId: 'sb',
    bookTitle: 'Solway Bay',
    characterId: 'keeper',
    characterName: 'The Lighthouse Keeper',
  },
];
