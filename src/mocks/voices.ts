/* Mock voice library used when VITE_USE_MOCKS=true.

   Mirrors the response shape of GET /api/voices. With mocks on, the workspace
   isn't scanned, so this stand-in supplies the same characters the prototype
   designed around. Pinned/source flags are inert in mock mode; ttsVoice values
   are picked to match what the real server's voice-mapping would resolve, and
   gradients are derived from those names so two voices on the same prebuilt
   share a palette — same rule the server applies in real mode. */

import type { VoiceLibraryResponse, Voice, BaseVoice } from '../lib/types';
import { gradientForTtsVoice } from '../lib/voice-palette';

const tts = (name: string, description: string) => ({
  provider: 'gemini' as const,
  name,
  description,
});

/* Bespoke Qwen voice assignment (plan 117). `name` is the designed voiceId
   (empty string when no voice has been designed yet). */
const qwenTts = (name: string, description: string) => ({
  provider: 'qwen' as const,
  name,
  description,
});

type MockVoice = Omit<Voice, 'gradient'> & {
  ttsVoice: { provider: 'gemini' | 'qwen'; name: string; description: string };
};

function withGradient(v: MockVoice): Voice {
  return { ...v, gradient: gradientForTtsVoice(v.ttsVoice.name, v.id) };
}

export const MOCK_VOICE_LIBRARY: VoiceLibraryResponse = {
  voices: [
    withGradient({
      id: 'v_halloran',
      character: 'Captain Halloran',
      bookTitle: 'The Northern Star',
      bookId: 'ns',
      bookSeries: 'Northern Coast Trilogy',
      attributes: ['Male', 'Baritone', 'Northern English', '60s', 'Authoritative'],
      usedIn: 3,
      source: 'current',
      ttsVoice: tts('Charon', 'Informative'),
    }),
    withGradient({
      id: 'v_eliza',
      character: 'Eliza Gray',
      bookTitle: 'The Northern Star',
      bookId: 'ns',
      bookSeries: 'Northern Coast Trilogy',
      attributes: ['Female', 'Alto', 'Working-class London', '20s', 'Defiant'],
      usedIn: 1,
      source: 'current',
      ttsVoice: tts('Kore', 'Firm'),
    }),
    withGradient({
      id: 'v_marcus',
      character: 'Marcus the Cook',
      bookTitle: 'The Northern Star',
      bookId: 'ns',
      bookSeries: 'Northern Coast Trilogy',
      attributes: ['Male', 'Tenor', 'Welsh', '50s', 'Wry'],
      usedIn: 0,
      source: 'current',
      ttsVoice: tts('Iapetus', 'Clear'),
    }),
    withGradient({
      id: 'v_anders',
      character: 'Narrator',
      bookTitle: 'Solway Bay',
      bookId: 'sb',
      bookSeries: 'Northern Coast Trilogy',
      attributes: ['Neutral', 'Mid-tempo', 'Mid-Atlantic', 'Warm'],
      usedIn: 11,
      source: 'library',
      inCurrentSeries: true,
      reusable: true,
      ttsVoice: tts('Sulafat', 'Warm'),
    }),
    /* Plan 101 — cross-book duplicate fixture. "Eliza" (Carrick's Compass)
       routes to the same Kore voice as "Eliza Gray" (Northern Star); the
       voices-view's auto-detection should normalise both to substring-
       match ('eliza' ⊂ 'elizagray') and flag the pair as a likely
       duplicate. Triggers the ⚠ pill on the Kore family card and the
       'Review duplicate ↗' swap when the pair is hand-selected.

       The partner lives in `cc` (NOT `sb`) on purpose: `cc`'s mock state
       carries a non-null cast (`buildCarricksCompassMockState`), so when
       the duplicate-review modal hydrates both books their characters
       resolve and the link/variant buttons enable. `sb` keeps `cast: null`
       to anchor the voices-compare spec, which is why it can't host the
       linkable duplicate.

       Deliberately NO `bookSeries` here (matches the sibling `cc` voice
       `v_navigator`): tagging a `cc` voice with the series would make `cc`
       — seriesPosition 3 — win `representativeBookIdBySeries`
       (voices.tsx) and become the rebaseline representative, but `cc`'s
       mock cast carries no line counts so `selectPrincipalCast` would
       pre-select nothing and break `rebaseline.spec.ts`. Cross-book
       duplicate detection reads series from the library slice, not this
       field, so leaving it off doesn't affect the ⚠ pill. */
    withGradient({
      id: 'v_eliza_cc',
      character: 'Eliza',
      bookTitle: "Carrick's Compass",
      bookId: 'cc',
      attributes: ['Female', 'Alto', 'Working-class London', '20s', 'Defiant'],
      usedIn: 4,
      source: 'library',
      ttsVoice: tts('Kore', 'Firm'),
    }),
    withGradient({
      id: 'v_keeper',
      character: 'The Lighthouse Keeper',
      bookTitle: 'Solway Bay',
      bookId: 'sb',
      bookSeries: 'Northern Coast Trilogy',
      attributes: ['Male', 'Bass', 'Scottish', '70s', 'Weathered'],
      usedIn: 1,
      source: 'library',
      inCurrentSeries: true,
      ttsVoice: tts('Algieba', 'Smooth'),
    }),
    withGradient({
      id: 'v_pemberton',
      character: 'Mrs. Pemberton',
      bookTitle: 'Solway Bay',
      bookId: 'sb',
      bookSeries: 'Northern Coast Trilogy',
      attributes: ['Female', 'Soprano', 'RP English', '60s', 'Crisp'],
      usedIn: 1,
      source: 'library',
      inCurrentSeries: true,
      ttsVoice: tts('Aoede', 'Breezy'),
    }),
    withGradient({
      id: 'v_boy',
      character: 'The Boy on the Pier',
      bookTitle: 'Solway Bay',
      bookId: 'sb',
      bookSeries: 'Northern Coast Trilogy',
      attributes: ['Male', 'Treble', 'Scottish', '12', 'Curious'],
      usedIn: 1,
      source: 'library',
      inCurrentSeries: true,
      ttsVoice: tts('Sadachbia', 'Lively'),
    }),
    withGradient({
      id: 'v_navigator',
      character: 'First Mate Greene',
      bookTitle: "Carrick's Compass",
      bookId: 'cc',
      attributes: ['Female', 'Mezzo', 'Irish', '40s', 'Pragmatic'],
      usedIn: 2,
      source: 'library',
      ttsVoice: tts('Leda', 'Youthful'),
    }),
    /* Plan 117 — bespoke Qwen voices in all three lifecycle states. These
       drive the status-first Qwen sections ("Needs a voice" / "Designed
       voices") that replace the degenerate 1-member voice families. Kept in
       the existing Northern Coast Trilogy series so the per-series Rebaseline
       button + series → book nesting resolve. Deliberately NOT on `cc` (see
       the v_eliza_cc note above re: rebaseline representative selection). */
    withGradient({
      id: 'v_bramble',
      character: 'Bramble',
      bookTitle: 'The Northern Star',
      bookId: 'ns',
      bookSeries: 'Northern Coast Trilogy',
      attributes: ['Male', 'Gruff', 'Older'],
      usedIn: 1,
      source: 'current',
      // none — no designed voiceId yet → "Qwen · Needs a voice"
      ttsVoice: qwenTts('', 'No voice designed yet'),
    }),
    withGradient({
      id: 'v_thistle',
      character: 'Thistle',
      bookTitle: 'The Northern Star',
      bookId: 'ns',
      bookSeries: 'Northern Coast Trilogy',
      attributes: ['Female', 'Sharp', 'Wry'],
      usedIn: 1,
      source: 'current',
      overrideTtsVoices: { qwen: { name: 'qwen-thistle' } },
      // designed but not yet generated → "Designed voices" with a Designed badge
      ttsVoice: qwenTts('qwen-thistle', 'Designed voice'),
    }),
    withGradient({
      id: 'v_wren',
      character: 'Wren',
      bookTitle: 'The Northern Star',
      bookId: 'ns',
      bookSeries: 'Northern Coast Trilogy',
      attributes: ['Female', 'Soft', 'Young'],
      usedIn: 1,
      source: 'current',
      overrideTtsVoices: { qwen: { name: 'qwen-wren' } },
      sampled: true,
      // designed AND auditioned but not yet rendered → "Designed voices" with a Sampled badge
      ttsVoice: qwenTts('qwen-wren', 'Designed voice'),
    }),
    withGradient({
      id: 'v_finch',
      character: 'Finch',
      bookTitle: 'Solway Bay',
      bookId: 'sb',
      bookSeries: 'Northern Coast Trilogy',
      attributes: ['Male', 'Bright', 'Young'],
      usedIn: 1,
      source: 'library',
      inCurrentSeries: true,
      overrideTtsVoices: { qwen: { name: 'qwen-finch' } },
      generated: true,
      // designed AND rendered → "Designed voices" with a Generated badge
      ttsVoice: qwenTts('qwen-finch', 'Designed voice'),
    }),
  ],
};

/* Base-voice catalog used when VITE_USE_MOCKS=true. Mirrors what the live
   server's GET /api/voices/base would return after a Coqui sidecar load and
   merges in the Gemini side. Kept small and representative — the test
   fixtures only care about the (engine, name) shape, not exhaustiveness. */
export const MOCK_BASE_VOICES: BaseVoice[] = [
  /* Coqui XTTS speakers — sample of the manifest. */
  { engine: 'coqui', name: 'Asya Anara' },
  { engine: 'coqui', name: 'Damien Black' },
  { engine: 'coqui', name: 'Ana Florence' },
  { engine: 'coqui', name: 'Aaron Dreschner' },
  { engine: 'coqui', name: 'Brenda Stern' },
  { engine: 'coqui', name: 'Claribel Dervla' },
  { engine: 'coqui', name: 'Sofia Hellen' },
  /* Gemini prebuilt voices — sample from the 30-voice published catalog. */
  { engine: 'gemini', name: 'Charon' },
  { engine: 'gemini', name: 'Kore' },
  { engine: 'gemini', name: 'Iapetus' },
  { engine: 'gemini', name: 'Aoede' },
  { engine: 'gemini', name: 'Sulafat' },
  { engine: 'gemini', name: 'Zephyr' },
];
