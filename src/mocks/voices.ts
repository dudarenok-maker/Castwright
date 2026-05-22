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

type MockVoice = Omit<Voice, 'gradient'> & {
  ttsVoice: { provider: 'gemini'; name: string; description: string };
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
      attributes: ['Neutral', 'Mid-tempo', 'Mid-Atlantic', 'Warm'],
      usedIn: 11,
      source: 'library',
      reusable: true,
      ttsVoice: tts('Sulafat', 'Warm'),
    }),
    /* Plan 101 — cross-book duplicate fixture. "Eliza" (Solway Bay) routes
       to the same Kore voice as "Eliza Gray" (Northern Star); the
       voices-view's auto-detection should normalise both to substring-
       match ('eliza' ⊂ 'elizagray') and flag the pair as a likely
       duplicate. Triggers the ⚠ pill on the Kore family card and the
       'Review duplicate ↗' swap when the pair is hand-selected. */
    withGradient({
      id: 'v_eliza_sb',
      character: 'Eliza',
      bookTitle: 'Solway Bay',
      bookId: 'sb',
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
      attributes: ['Male', 'Bass', 'Scottish', '70s', 'Weathered'],
      usedIn: 1,
      source: 'library',
      ttsVoice: tts('Algieba', 'Smooth'),
    }),
    withGradient({
      id: 'v_pemberton',
      character: 'Mrs. Pemberton',
      bookTitle: 'Solway Bay',
      bookId: 'sb',
      attributes: ['Female', 'Soprano', 'RP English', '60s', 'Crisp'],
      usedIn: 1,
      source: 'library',
      ttsVoice: tts('Aoede', 'Breezy'),
    }),
    withGradient({
      id: 'v_boy',
      character: 'The Boy on the Pier',
      bookTitle: 'Solway Bay',
      bookId: 'sb',
      attributes: ['Male', 'Treble', 'Scottish', '12', 'Curious'],
      usedIn: 1,
      source: 'library',
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
