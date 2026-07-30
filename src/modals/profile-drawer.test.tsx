// Pairs with docs/features/archive/10-profile-drawer.md

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { uiSlice } from '../store/ui-slice';
import { voicesSlice, voicesActions } from '../store/voices-slice';
import { castSlice, castActions } from '../store/cast-slice';
import { castDesignSlice, castDesignActions } from '../store/cast-design-slice';
import { librarySlice } from '../store/library-slice';
import { voiceLibrarySlice, type VoiceLibraryEntry } from '../store/voice-library-slice';
import { ProfileDrawer, type PriorMergeCandidate } from './profile-drawer';
import {
  playSampleWithAutoLoad,
  playBaseVoiceSampleWithAutoLoad,
} from '../lib/play-sample-with-auto-load';
import type { BaseVoice, Character, LibraryBook, Voice } from '../lib/types';
import type { PromoteQwenVoiceResponse } from '../lib/api';

vi.mock('../lib/play-sample-with-auto-load', () => ({
  playSampleWithAutoLoad: vi.fn().mockResolvedValue({ analyzerEvicted: false }),
  playBaseVoiceSampleWithAutoLoad: vi.fn().mockResolvedValue({ analyzerEvicted: false }),
}));

vi.mock('../lib/use-sample-playback', () => ({
  useSamplePlayback: () => ({
    isPlaying: false,
    currentUrl: null,
    play: vi.fn(),
    stop: vi.fn(),
    pause: vi.fn(),
  }),
}));

const setVoiceOverride = vi.fn(
  (_voiceId: string, _override: BaseVoice | null, _opts?: { scope?: string; bookId?: string }) =>
    Promise.resolve(),
);
const generateVoiceStyle = vi.fn((_bookId: string, _characterId: string) =>
  Promise.resolve({ voiceStyle: 'a bright, confident teenage voice' }),
);
const designQwenVoice = vi.fn((_bookId: string, _characterId: string, _args?: unknown) =>
  Promise.resolve({
    voiceId: 'qwen-halloran',
    previewUrl: '/audio/voices/char-halloran-qwen3-tts-0.6b-mock.mp3',
  }),
);
const fetchDesignedPersona = vi.fn((_bookId: string, _characterId: string) =>
  Promise.resolve({ instruct: '' }),
);
/* Plan 161 — the A/B compare modal promotes the preview on approve. */
const promoteQwenVoice = vi.fn(
  (_bookId: string, _characterId: string, args?: unknown): Promise<PromoteQwenVoiceResponse> =>
    Promise.resolve({
      voiceId: String(
        (args as { previewVoiceId?: string })?.previewVoiceId ?? 'qwen-halloran',
      ).replace(/-preview$/, ''),
      url: '/audio/voices/char-halloran-qwen3-tts-0.6b-mock.mp3',
    }),
);
const discardQwenPreview = vi.fn((_bookId: string, _characterId: string, _args?: unknown) =>
  Promise.resolve(),
);
/* fs-38 Wave 1, Task 16 — "My voices" picker + "Save to my voices". */
const assignLibraryVoice = vi.fn(
  (_voiceUuid: string, _args: { bookId: string; characterId: string }) =>
    Promise.resolve<{ updated: number; written: ('qwen' | 'coqui')[]; warning?: string }>({
      updated: 1,
      written: ['qwen'],
    }),
);
/* GATE 1, owner-decided [DELTA-I5] — the "Remove voice" wire call. */
const unassignLibraryVoice = vi.fn(
  (_voiceUuid: string, _args: { bookId: string; characterId: string }) =>
    Promise.resolve<{ cleared: ('qwen' | 'coqui')[] }>({ cleared: ['qwen', 'coqui'] }),
);
const promoteToLibrary = vi.fn(
  (_args: { bookId: string; characterId: string; name: string }) =>
    Promise.resolve({ voiceUuid: 'lib-new', name: 'New' }),
);
vi.mock('../lib/api', () => ({
  api: {
    assignLibraryVoice: (voiceUuid: string, args: { bookId: string; characterId: string }) =>
      assignLibraryVoice(voiceUuid, args),
    unassignLibraryVoice: (voiceUuid: string, args: { bookId: string; characterId: string }) =>
      unassignLibraryVoice(voiceUuid, args),
    promoteToLibrary: (args: { bookId: string; characterId: string; name: string }) =>
      promoteToLibrary(args),
    listVoiceLibrary: () => Promise.resolve({ voices: [] }),
    /* Forward exactly the args received — a 2-arg call stays 2-arg so the
       existing override-write assertions (toHaveBeenCalledWith(id, null))
       keep matching after the optional scope arg landed. */
    setVoiceOverride: (...args: unknown[]) =>
      (setVoiceOverride as unknown as (...a: unknown[]) => Promise<void>)(...args),
    generateVoiceStyle: (bookId: string, characterId: string) =>
      generateVoiceStyle(bookId, characterId),
    designQwenVoice: (bookId: string, characterId: string, args?: unknown) =>
      designQwenVoice(bookId, characterId, args),
    fetchDesignedPersona: (bookId: string, characterId: string) =>
      fetchDesignedPersona(bookId, characterId),
    promoteQwenVoice: (bookId: string, characterId: string, args?: unknown) =>
      promoteQwenVoice(bookId, characterId, args),
    discardQwenPreview: (bookId: string, characterId: string, args?: unknown) =>
      discardQwenPreview(bookId, characterId, args),
  },
}));

interface StoreSetup {
  baseVoices?: BaseVoice[];
  voices?: Voice[];
  libraryBook?: LibraryBook;
  myVoices?: VoiceLibraryEntry[];
}

function makeStore({ baseVoices, voices, libraryBook, myVoices }: StoreSetup = {}) {
  const store = configureStore({
    reducer: {
      ui: uiSlice.reducer,
      voices: voicesSlice.reducer,
      cast: castSlice.reducer,
      castDesign: castDesignSlice.reducer,
      library: librarySlice.reducer,
      voiceLibrary: voiceLibrarySlice.reducer,
    },
    preloadedState: myVoices
      ? { voiceLibrary: { ...voiceLibrarySlice.getInitialState(), entries: myVoices } }
      : undefined,
  });
  if (baseVoices) store.dispatch(voicesActions.hydrateBaseVoices(baseVoices));
  if (voices) store.dispatch(voicesActions.hydrate({ voices }));
  if (libraryBook) store.dispatch(librarySlice.actions.addBook(libraryBook));
  return store;
}

function renderDrawer(
  character: Character,
  extra: {
    mergeCandidates?: Character[];
    mergeCandidatesPrior?: PriorMergeCandidate[];
    onMerge?: (sourceId: string, targetId: string) => Promise<void>;
    onLinkPrior?: (
      sourceId: string,
      targetBookId: string,
      targetCharacterId: string,
    ) => Promise<void>;
    onUnlinkAlias?: (
      sourceCharacterId: string,
      aliasName: string,
      destination: { mode: 'split' } | { mode: 'move'; targetCharacterId: string },
    ) => Promise<void>;
    onAddAlias?: (characterId: string, aliasName: string) => Promise<void>;
    onRename?: (characterId: string, name: string) => void;
    voice?: Voice;
    baseVoices?: BaseVoice[];
    voices?: Voice[];
    duplicateOther?: { name: string; bookTitle: string } | null;
    onReviewDuplicate?: () => void;
    renderedFallbackEngine?: string | null;
    bookId?: string;
    libraryBook?: LibraryBook;
    onReassignLines?: (characterId: string) => void;
    myVoices?: VoiceLibraryEntry[];
    onSave?: (next: Character, meta: { hadConflict: boolean }) => void;
  } = {},
) {
  const store = makeStore({
    baseVoices: extra.baseVoices,
    voices: extra.voices,
    libraryBook: extra.libraryBook,
    myVoices: extra.myVoices,
  });
  return {
    store,
    ...render(
      <Provider store={store}>
        <ProfileDrawer
          character={character}
          bookId={extra.bookId}
          voice={extra.voice}
          onClose={() => {}}
          onSave={extra.onSave ?? (() => {})}
          onLock={() => {}}
          mergeCandidates={extra.mergeCandidates}
          mergeCandidatesPrior={extra.mergeCandidatesPrior}
          onMerge={extra.onMerge}
          onLinkPrior={extra.onLinkPrior}
          onUnlinkAlias={extra.onUnlinkAlias}
          onAddAlias={extra.onAddAlias}
          onRename={extra.onRename}
          duplicateOther={extra.duplicateOther}
          onReviewDuplicate={extra.onReviewDuplicate}
          renderedFallbackEngine={extra.renderedFallbackEngine}
          onReassignLines={extra.onReassignLines}
        />
      </Provider>,
    ),
  };
}

const evidenceLongFirst = [
  {
    quote: 'A long-form excerpt that the analyzer marks as the voice-cloning sample.',
    note: 'long',
  },
  { quote: 'A medium-length quote for tonal context.', note: 'medium' },
  { quote: 'Short quip.', note: 'short' },
];

const baseChar: Character = {
  id: 'halloran',
  name: 'Captain Halloran',
  role: 'Captain',
  color: 'halloran',
  lines: 100,
  scenes: 5,
};

describe('ProfileDrawer evidence rendering', () => {
  it('renders the first 3 evidence quotes by default, in array order', () => {
    renderDrawer({ ...baseChar, evidence: evidenceLongFirst });

    /* All three quotes visible — no "Show more" needed. */
    expect(screen.getByText(evidenceLongFirst[0].quote)).toBeTruthy();
    expect(screen.getByText(evidenceLongFirst[1].quote)).toBeTruthy();
    expect(screen.getByText(evidenceLongFirst[2].quote)).toBeTruthy();

    /* The drawer trusts the server-provided order (longest-first); the
       UI does NOT re-sort. Verify by reading the rendered blockquote
       elements in DOM order. */
    const blockquotes = document.querySelectorAll('blockquote');
    const texts = Array.from(blockquotes).map((b) => b.textContent);
    expect(texts).toEqual(evidenceLongFirst.map((e) => e.quote));
  });

  it('hides quotes beyond the first 3 behind a "Show more" affordance', () => {
    const extras = [
      ...evidenceLongFirst,
      { quote: 'Fourth quote, only revealed after expand.', note: 'extra' },
    ];
    renderDrawer({ ...baseChar, evidence: extras });

    /* Fourth quote not in the DOM yet. */
    expect(screen.queryByText(extras[3].quote)).toBeNull();

    /* The toggle button shows the residual count. */
    const toggle = screen.getByRole('button', { name: /\+ Show 1 more/i });
    fireEvent.click(toggle);

    expect(screen.getByText(extras[3].quote)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Show fewer/i })).toBeTruthy();
  });

  it('does not render the toggle when the character has exactly 3 quotes', () => {
    renderDrawer({ ...baseChar, evidence: evidenceLongFirst });
    expect(screen.queryByRole('button', { name: /Show \d+ more/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Show fewer/i })).toBeNull();
  });
});

describe('ProfileDrawer Qwen emotion-variant persistence (regression)', () => {
  /* Designing a whisper variant persists `overrideTtsVoices.qwen.variants` to
     cast.json server-side. The drawer's Save handler then rebuilt the qwen slot
     as a bare `{ name }` — dropping `variants` — and onSave → setCharacters →
     persist wrote the whole cast back WITHOUT the variant, erasing the
     server-written whisper variant from disk on the next Save. This guards the
     fix: Save must preserve the existing qwen slot (variants included). */
  it('preserves designed emotion variants in the qwen slot on Save', () => {
    const onSave = vi.fn();
    const character: Character = {
      ...baseChar,
      id: 'marlow',
      name: 'Marlow Halden',
      voiceId: 'marlow',
      ttsEngine: 'qwen',
      voiceStyle: 'a charming, smooth-talking teenage boy',
      overrideTtsVoices: {
        qwen: { name: 'qwen-marlow', variants: { whisper: { name: 'qwen-marlow__whisper' } } },
      },
    };
    const store = makeStore();
    render(
      <Provider store={store}>
        <ProfileDrawer
          character={character}
          voice={undefined}
          onClose={() => {}}
          onSave={onSave}
          onLock={() => {}}
        />
      </Provider>,
    );

    fireEvent.click(screen.getByRole('button', { name: /Save changes/i }));

    expect(onSave).toHaveBeenCalledTimes(1);
    const next = onSave.mock.calls[0][0] as Character;
    expect(next.overrideTtsVoices?.qwen).toEqual({
      name: 'qwen-marlow',
      variants: { whisper: { name: 'qwen-marlow__whisper' } },
    });
  });
});

describe('ProfileDrawer cast roster (merge + aliases)', () => {
  const wren: Character = {
    id: 'wren',
    name: 'Wren',
    role: 'protagonist',
    color: 'eliza',
    lines: 5,
    scenes: 2,
  };
  const wrenFoster: Character = {
    id: 'wren-sparrow',
    name: 'Wren Sparrow',
    role: 'protagonist',
    color: 'eliza',
    lines: 12,
    scenes: 4,
  };
  const marlow: Character = {
    id: 'marlow',
    name: 'Marlow Halden',
    role: 'sidekick',
    color: 'halloran',
    lines: 7,
    scenes: 3,
  };

  it('renders aliases as chips when the character already has merge history', () => {
    renderDrawer({ ...wrenFoster, aliases: ['Wren', 'Foster'] });
    /* "Also known as" header is shown plus a pill per alias. */
    expect(screen.getByText(/Also known as/i)).toBeTruthy();
    expect(screen.getByText('Wren')).toBeTruthy();
    expect(screen.getByText('Foster')).toBeTruthy();
  });

  it('hides the merge button when no candidates or onMerge handler are provided', () => {
    renderDrawer(wren);
    /* No expandable picker, no merge button. */
    expect(screen.queryByRole('button', { name: /Merge .* into another character/i })).toBeNull();
  });

  it('opens the picker, calls onMerge with (source, target), and surfaces errors', async () => {
    const onMerge = vi.fn().mockResolvedValueOnce(undefined);
    renderDrawer(wren, { mergeCandidates: [wrenFoster, marlow], onMerge });

    /* Toggle the merge card open. */
    fireEvent.click(screen.getByRole('button', { name: /Merge Wren into another character/i }));

    /* Open the SearchablePicker popover off the merge-target trigger. */
    fireEvent.click(screen.getByRole('button', { name: /Merge target/i }));
    /* Pick the survivor by clicking its row inside the portalled dialog. */
    fireEvent.click(screen.getByRole('option', { name: /Wren Sparrow/i }));
    /* Confirmation sentence appears once a target is picked. */
    expect(screen.getByText(/folded into/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /^Merge$/i }));
    /* Microtask flush so the async onMerge call resolves. */
    await Promise.resolve();
    expect(onMerge).toHaveBeenCalledWith('wren', 'wren-sparrow');
  });

  it('surfaces an error message when onMerge rejects', async () => {
    const onMerge = vi.fn().mockRejectedValueOnce(new Error('Server said no.'));
    renderDrawer(wren, { mergeCandidates: [wrenFoster], onMerge });
    fireEvent.click(screen.getByRole('button', { name: /Merge Wren into another character/i }));
    fireEvent.click(screen.getByRole('button', { name: /Merge target/i }));
    fireEvent.click(screen.getByRole('option', { name: /Wren Sparrow/i }));
    fireEvent.click(screen.getByRole('button', { name: /^Merge$/i }));
    /* Let the rejected promise settle before assertions. */
    await Promise.resolve();
    await Promise.resolve();
    expect(await screen.findByText(/Server said no\./)).toBeTruthy();
  });

  it('typeahead narrows the picker list to the searched character', async () => {
    const onMerge = vi.fn().mockResolvedValueOnce(undefined);
    renderDrawer(wren, { mergeCandidates: [wrenFoster, marlow], onMerge });
    fireEvent.click(screen.getByRole('button', { name: /Merge Wren into another character/i }));
    fireEvent.click(screen.getByRole('button', { name: /Merge target/i }));
    const searchInput = screen.getByPlaceholderText('Search character…');
    fireEvent.change(searchInput, { target: { value: 'sparrow' } });
    /* Scope to the picker dialog — the drawer also renders native
       <select>s (gender, age) whose <option>s share the option role. */
    const dialog = screen.getByRole('dialog');
    const options = within(dialog).getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent(/Wren Sparrow/i);
    fireEvent.click(options[0]);
    fireEvent.click(screen.getByRole('button', { name: /^Merge$/i }));
    await Promise.resolve();
    expect(onMerge).toHaveBeenCalledWith('wren', 'wren-sparrow');
  });
});

describe('ProfileDrawer manual continuity link (prior-series optgroup)', () => {
  const hartwell: Character = {
    id: 'hartwell-brennan-vale',
    name: 'Hartwell Brennan Vale',
    role: 'character',
    color: 'eliza',
    lines: 271,
    scenes: 9,
  };
  const inBookSibling: Character = {
    id: 'wren-sparrow',
    name: 'Wren Sparrow',
    role: 'protagonist',
    color: 'eliza',
    lines: 12,
    scenes: 4,
  };
  const priorHart: PriorMergeCandidate = {
    id: 'hart',
    name: 'Hart',
    bookId: 'the Hollow Tide_1',
    bookTitle: 'The Hollow Tide',
  };
  const priorMarlow: PriorMergeCandidate = {
    id: 'marlow',
    name: 'Marlow',
    bookId: 'the Hollow Tide_1',
    bookTitle: 'The Hollow Tide',
  };

  it('renders the merge button when only prior candidates are available (no in-book siblings)', () => {
    /* The user might be on a tiny scene with just one new character —
       no in-book candidates, but prior series characters exist. The
       manual-link affordance must still surface. */
    renderDrawer(hartwell, { mergeCandidatesPrior: [priorHart], onLinkPrior: vi.fn() });
    expect(
      screen.getByRole('button', { name: /Merge Hartwell into another character/i }),
    ).toBeTruthy();
  });

  it('renders both groups under the prior-books separator when both sets are non-empty', () => {
    renderDrawer(hartwell, {
      mergeCandidates: [inBookSibling],
      mergeCandidatesPrior: [priorHart],
      onMerge: vi.fn(),
      onLinkPrior: vi.fn(),
    });
    fireEvent.click(screen.getByRole('button', { name: /Merge Hartwell into another character/i }));
    fireEvent.click(screen.getByRole('button', { name: /Merge target/i }));
    const dialog = screen.getByRole('dialog');
    /* The prior-books separator labels the second group. */
    expect(within(dialog).getByText('From prior books in this series')).toBeInTheDocument();
    /* Both options reachable inside the portalled popover. */
    expect(within(dialog).getByRole('option', { name: /Wren Sparrow/ })).toBeTruthy();
    expect(
      within(dialog).getByRole('option', { name: /Hart.*The Hollow Tide/i }),
    ).toBeTruthy();
  });

  it('routes a prior-option pick to onLinkPrior with (sourceId, targetBookId, targetCharacterId) and a "Link" button label', async () => {
    const onLinkPrior = vi.fn().mockResolvedValueOnce(undefined);
    renderDrawer(hartwell, {
      mergeCandidates: [inBookSibling],
      mergeCandidatesPrior: [priorHart, priorMarlow],
      onMerge: vi.fn(),
      onLinkPrior,
    });
    fireEvent.click(screen.getByRole('button', { name: /Merge Hartwell into another character/i }));
    fireEvent.click(screen.getByRole('button', { name: /Merge target/i }));
    /* Click the second prior row (Marlow) — picker fires onPickRosterEntry
       which writes `prior:1` to mergeTargetId. */
    fireEvent.click(screen.getByRole('option', { name: /Marlow.*The Hollow Tide/i }));
    /* Confirmation copy shifts to the link wording when a prior is picked. */
    expect(screen.getByText(/linked as the same person as/i)).toBeTruthy();
    /* Button label flips from "Merge" to "Link" when a prior is selected. */
    fireEvent.click(screen.getByRole('button', { name: /^Link$/i }));
    await Promise.resolve();
    expect(onLinkPrior).toHaveBeenCalledWith('hartwell-brennan-vale', 'the Hollow Tide_1', 'marlow');
  });

  it('still routes an in-book pick to onMerge when both groups are present', async () => {
    const onMerge = vi.fn().mockResolvedValueOnce(undefined);
    const onLinkPrior = vi.fn();
    renderDrawer(hartwell, {
      mergeCandidates: [inBookSibling],
      mergeCandidatesPrior: [priorHart],
      onMerge,
      onLinkPrior,
    });
    fireEvent.click(screen.getByRole('button', { name: /Merge Hartwell into another character/i }));
    fireEvent.click(screen.getByRole('button', { name: /Merge target/i }));
    fireEvent.click(screen.getByRole('option', { name: /Wren Sparrow/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Merge$/i }));
    await Promise.resolve();
    expect(onMerge).toHaveBeenCalledWith('hartwell-brennan-vale', 'wren-sparrow');
    expect(onLinkPrior).not.toHaveBeenCalled();
  });

  it('hides the merge button entirely when both groups are empty', () => {
    renderDrawer(hartwell, {
      mergeCandidates: [],
      mergeCandidatesPrior: [],
      onMerge: vi.fn(),
      onLinkPrior: vi.fn(),
    });
    expect(screen.queryByRole('button', { name: /Merge .* into another character/i })).toBeNull();
  });

  it('surfaces an error when onLinkPrior rejects', async () => {
    const onLinkPrior = vi.fn().mockRejectedValueOnce(new Error('Cross-series link refused.'));
    renderDrawer(hartwell, {
      mergeCandidatesPrior: [priorHart],
      onLinkPrior,
    });
    fireEvent.click(screen.getByRole('button', { name: /Merge Hartwell into another character/i }));
    fireEvent.click(screen.getByRole('button', { name: /Merge target/i }));
    fireEvent.click(screen.getByRole('option', { name: /Hart.*The Hollow Tide/i }));
    fireEvent.click(screen.getByRole('button', { name: /^Link$/i }));
    await Promise.resolve();
    await Promise.resolve();
    await waitFor(() => {
      expect(screen.getByText(/Cross-series link refused\./)).toBeTruthy();
    });
  });
});

describe('ProfileDrawer rename + promote alias', () => {
  it('reveals the name input on Rename and fires onRename on Enter', () => {
    const onRename = vi.fn();
    renderDrawer({ ...baseChar }, { onRename });
    fireEvent.click(screen.getByRole('button', { name: /Rename character/i }));
    const input = screen.getByLabelText('Character name') as HTMLInputElement;
    expect(input.value).toBe('Captain Halloran');
    fireEvent.change(input, { target: { value: 'Admiral Halloran' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onRename).toHaveBeenCalledWith('halloran', 'Admiral Halloran');
  });

  it('rejects an empty name without calling onRename', () => {
    const onRename = vi.fn();
    renderDrawer({ ...baseChar }, { onRename });
    fireEvent.click(screen.getByRole('button', { name: /Rename character/i }));
    const input = screen.getByLabelText('Character name');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onRename).not.toHaveBeenCalled();
    expect(screen.getByText(/Name cannot be empty/i)).toBeTruthy();
  });

  it('promotes an alias to the primary name via the chip star', () => {
    const onRename = vi.fn();
    renderDrawer({ ...baseChar, aliases: ['Cap'] }, { onRename });
    fireEvent.click(screen.getByRole('button', { name: /Make Cap the primary name/i }));
    expect(onRename).toHaveBeenCalledWith('halloran', 'Cap');
  });

  it('hides both affordances when onRename is not provided', () => {
    renderDrawer({ ...baseChar, aliases: ['Cap'] });
    expect(screen.queryByRole('button', { name: /Rename character/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Make Cap the primary name/i })).toBeNull();
  });

  it('hides rename for a background bucket character', () => {
    renderDrawer(
      { ...baseChar, id: 'unknown-male', name: 'Unknown male', aliases: ['Cap'] },
      { onRename: vi.fn() },
    );
    expect(screen.queryByRole('button', { name: /Rename character/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Make Cap the primary name/i })).toBeNull();
  });
});

describe('ProfileDrawer Play sample (auto-load path)', () => {
  const brann: Character = {
    id: 'brann',
    name: 'Brann',
    role: 'Telepath',
    color: 'halloran',
    lines: 426,
    scenes: 12,
    evidence: [{ quote: 'Brann provides the necessary pressure and support.', note: 'long' }],
  };

  it('routes Play through the auto-load helper, not raw api.getVoiceSample', async () => {
    vi.mocked(playSampleWithAutoLoad).mockClear();
    vi.mocked(playSampleWithAutoLoad).mockResolvedValueOnce({ analyzerEvicted: false });
    render(
      <Provider store={makeStore()}>
        <ProfileDrawer
          character={brann}
          voice={undefined}
          onClose={() => {}}
          onSave={() => {}}
          onLock={() => {}}
        />
      </Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Play 12s sample/i }));
    await waitFor(() => expect(playSampleWithAutoLoad).toHaveBeenCalledTimes(1));
    /* The voiceId for an unmatched character is namespaced char-<id> so
       cached sample files for the library voice can't collide with the
       in-progress character voice. */
    expect(vi.mocked(playSampleWithAutoLoad).mock.calls[0][0].args.voiceId).toBe('char-brann');
  });

  it('surfaces the inline eviction banner when the helper reports the analyzer was unloaded', async () => {
    vi.mocked(playSampleWithAutoLoad).mockClear();
    vi.mocked(playSampleWithAutoLoad).mockImplementationOnce(async ({ onStatus }) => {
      /* Drive the same status sequence prepareSidecar would emit on a
         cold-start path: evict → load-tts → synth. */
      onStatus?.('evicting', { analyzerEvicted: false });
      onStatus?.('loading-tts', { analyzerEvicted: true });
      onStatus?.('synthesizing', { analyzerEvicted: true });
      return { analyzerEvicted: true };
    });
    render(
      <Provider store={makeStore()}>
        <ProfileDrawer
          character={brann}
          voice={undefined}
          onClose={() => {}}
          onSave={() => {}}
          onLock={() => {}}
        />
      </Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Play 12s sample/i }));
    expect(
      await screen.findByText(/Analyzer unloaded to free VRAM for the voice engine\./),
    ).toBeTruthy();
  });

  it('renders the helper error in the drawer when prep or synth fails', async () => {
    vi.mocked(playSampleWithAutoLoad).mockClear();
    vi.mocked(playSampleWithAutoLoad).mockRejectedValueOnce(
      new Error('TTS sidecar process is not running. Launch the app via start-app.ps1.'),
    );
    render(
      <Provider store={makeStore()}>
        <ProfileDrawer
          character={brann}
          voice={undefined}
          onClose={() => {}}
          onSave={() => {}}
          onLock={() => {}}
        />
      </Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Play 12s sample/i }));
    expect(await screen.findByText(/TTS sidecar process is not running\./)).toBeTruthy();
  });

  it('routes a gradient-swatch click through the same auto-load helper', async () => {
    /* Regression for the bug where the drawer's big circle had no
       onSelect wired — the hover overlay promised playback but clicking
       did nothing. After the fix, clicking the swatch is an alternate
       trigger for the same sample synth as the "Play 12s sample" pill. */
    vi.mocked(playSampleWithAutoLoad).mockClear();
    vi.mocked(playSampleWithAutoLoad).mockResolvedValueOnce({ analyzerEvicted: false });
    render(
      <Provider store={makeStore()}>
        <ProfileDrawer
          character={brann}
          voice={undefined}
          onClose={() => {}}
          onSave={() => {}}
          onLock={() => {}}
        />
      </Provider>,
    );
    /* The unmatched character has no library Voice, so the swatch falls
       back to its default voice-named accessible label. We match by
       prefix because the label suffix depends on whether a voice is
       present. */
    fireEvent.click(screen.getByRole('button', { name: /^Play sample for/i }));
    await waitFor(() => expect(playSampleWithAutoLoad).toHaveBeenCalledTimes(1));
    expect(vi.mocked(playSampleWithAutoLoad).mock.calls[0][0].args.voiceId).toBe('char-brann');
  });

  it("prefers the character's own voiceUuid over a stale/foreign one on the matched library voice (Qwen)", async () => {
    /* Regression: `stagedVoiceUuid` (the top of the fallback chain) is
       seeded ONCE at mount from `character.voiceUuid ?? voice?.voiceUuid`
       and nothing re-syncs it afterward. So the only way `character.voiceUuid`
       vs `voice?.voiceUuid` ordering actually matters is when BOTH are
       absent at mount (stagedVoiceUuid stays undefined) and the `character`
       prop is later updated in place — e.g. the parent's cast refetches
       while the drawer stays open — to carry a real voiceUuid, while
       `voice` (a derived, cross-book lookup — the same collision class
       cast.tsx's playSampleFor was fixed for) still carries an unrelated,
       stale/foreign one. The character's fresh, unambiguous voiceUuid must
       win. Mirrors the equivalent fix in src/views/cast.tsx's playSampleFor. */
    const qwenCharNoUuidYet: Character = {
      ...brann,
      ttsEngine: 'qwen',
      overrideTtsVoices: { qwen: { name: 'qwen-brann' } },
    };
    const foreignVoiceNoUuidYet: Voice = {
      id: 'brann',
      character: 'Brann',
      bookTitle: 'Some Other Book',
      bookId: 'other-book',
      attributes: [],
      gradient: ['#000', '#fff'],
      usedIn: 1,
      source: 'library',
      ttsVoice: { provider: 'qwen', name: 'qwen-brann', description: 'Designed voice' },
    };
    vi.mocked(playSampleWithAutoLoad).mockClear();
    vi.mocked(playSampleWithAutoLoad).mockResolvedValueOnce({ analyzerEvicted: false });
    const { rerender } = render(
      <Provider store={makeStore()}>
        <ProfileDrawer
          character={qwenCharNoUuidYet}
          voice={foreignVoiceNoUuidYet}
          onClose={() => {}}
          onSave={() => {}}
          onLock={() => {}}
        />
      </Provider>,
    );
    /* Same component instance, updated props: the character's own cast.json
       now carries its real voiceUuid; the matched library voice (an
       unrelated book's same-id entry) carries a different, foreign one. */
    rerender(
      <Provider store={makeStore()}>
        <ProfileDrawer
          character={{ ...qwenCharNoUuidYet, voiceUuid: 'own-uuid-correct' }}
          voice={{ ...foreignVoiceNoUuidYet, voiceUuid: 'foreign-uuid-from-other-book' }}
          onClose={() => {}}
          onSave={() => {}}
          onLock={() => {}}
        />
      </Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Play 12s sample/i }));
    await waitFor(() => expect(playSampleWithAutoLoad).toHaveBeenCalledTimes(1));
    const args = vi.mocked(playSampleWithAutoLoad).mock.calls[0][0].args;
    expect(args.voice.voiceUuid).toBe('own-uuid-correct');
  });
});

describe('ProfileDrawer downgrade to background bucket', () => {
  /* Rescuer-shaped fixture mirroring the screenshot the user filed: a
     descriptor-named speaker the auto-fold missed (≥3 lines) that the user
     wants to manually downgrade. */
  const rescuer: Character = {
    id: 'rescuer',
    name: 'Rescuer',
    role: 'background',
    color: 'halloran',
    lines: 26,
    scenes: 2,
  };
  const unknownMale: Character = {
    id: 'unknown-male',
    name: 'Unknown male',
    role: 'background',
    color: 'narrator',
    lines: 129,
    scenes: 6,
  };

  it('fires onMerge with the bucket id when "Unknown male" is clicked', async () => {
    const onMerge = vi.fn().mockResolvedValueOnce(undefined);
    renderDrawer(rescuer, { onMerge });
    fireEvent.click(screen.getByRole('button', { name: /Downgrade to Unknown male/i }));
    /* Flush the awaited onMerge call. */
    await Promise.resolve();
    expect(onMerge).toHaveBeenCalledWith('rescuer', 'unknown-male');
  });

  it('fires onMerge with the female bucket id when "Unknown female" is clicked', async () => {
    const onMerge = vi.fn().mockResolvedValueOnce(undefined);
    renderDrawer(rescuer, { onMerge });
    fireEvent.click(screen.getByRole('button', { name: /Downgrade to Unknown female/i }));
    await Promise.resolve();
    expect(onMerge).toHaveBeenCalledWith('rescuer', 'unknown-female');
  });

  it('shows the downgrade buttons even when the cast has no other merge candidates', () => {
    const onMerge = vi.fn();
    /* No mergeCandidates → the regular merge picker is hidden. Downgrade
       buttons must still be reachable, because the server creates the
       bucket on the fly. */
    renderDrawer(rescuer, { onMerge });
    expect(
      screen.queryByRole('button', { name: /Merge Rescuer into another character/i }),
    ).toBeNull();
    expect(screen.getByRole('button', { name: /Downgrade to Unknown male/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Downgrade to Unknown female/i })).toBeTruthy();
  });

  it('hides the downgrade buttons for the bucket character itself', () => {
    const onMerge = vi.fn();
    renderDrawer(unknownMale, { onMerge });
    expect(screen.queryByRole('button', { name: /Downgrade to Unknown male/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Downgrade to Unknown female/i })).toBeNull();
  });

  it('hides the downgrade buttons when no onMerge handler is wired', () => {
    renderDrawer(rescuer);
    expect(screen.queryByRole('button', { name: /Downgrade to Unknown male/i })).toBeNull();
  });

  it('surfaces the server error when the downgrade merge rejects', async () => {
    const onMerge = vi.fn().mockRejectedValueOnce(new Error('Disk full.'));
    renderDrawer(rescuer, { onMerge });
    fireEvent.click(screen.getByRole('button', { name: /Downgrade to Unknown male/i }));
    await Promise.resolve();
    await Promise.resolve();
    expect(await screen.findByText(/Disk full\./)).toBeTruthy();
  });
});

describe('ProfileDrawer model-voice override picker', () => {
  const brann: Character = {
    id: 'brann',
    name: 'Brann',
    role: 'protagonist',
    color: 'eliza',
    lines: 50,
    scenes: 5,
    gender: 'male',
    ageRange: 'teen',
  };

  const brannVoice: Voice = {
    id: 'v_brann',
    character: 'Brann',
    bookTitle: 'Book One',
    bookId: 'b1',
    attributes: ['Male', 'Teen'],
    gradient: ['#3C194F', '#0F0E0D'],
    usedIn: 1,
    source: 'current',
    ttsVoice: { provider: 'coqui', name: 'Aaron Dreschner', description: 'Mid · Male' },
  };

  const baseCatalog: BaseVoice[] = [
    { engine: 'coqui', name: 'Asya Anara' },
    { engine: 'coqui', name: 'Damien Black' },
    { engine: 'gemini', name: 'Charon' },
  ];

  it('renders engine tabs (one per available engine) and labels the Auto trigger with the resolved voice', async () => {
    renderDrawer(brann, { voice: brannVoice, voices: [brannVoice], baseVoices: baseCatalog });
    const trigger = await screen.findByRole('button', { name: /Model voice override/i });
    /* The trigger button shows the Auto label until the user picks an
       explicit override — same content the legacy <select>'s auto
       <option> carried. */
    expect(trigger).toHaveTextContent(/Auto — currently Coqui · Aaron Dreschner/i);
    expect(screen.getByRole('tab', { name: /Coqui/i })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Gemini/i })).toBeTruthy();
  });

  it('persists an override via api.setVoiceOverride when the user picks a base voice', async () => {
    setVoiceOverride.mockClear();
    renderDrawer(brann, { voice: brannVoice, voices: [brannVoice], baseVoices: baseCatalog });
    const trigger = await screen.findByRole('button', { name: /Model voice override/i });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('option', { name: /Asya Anara/ }));
    await waitFor(() => {
      expect(setVoiceOverride).toHaveBeenCalledWith('v_brann', {
        engine: 'coqui',
        name: 'Asya Anara',
      });
    });
  });

  it('clears the override when the user picks "Auto"', async () => {
    setVoiceOverride.mockClear();
    const overridden: Voice = {
      ...brannVoice,
      overrideTtsVoices: { coqui: { name: 'Asya Anara' } },
    };
    renderDrawer(brann, { voice: overridden, voices: [overridden], baseVoices: baseCatalog });
    const trigger = await screen.findByRole('button', { name: /Model voice override/i });
    expect(trigger).toHaveTextContent(/Asya Anara/);
    fireEvent.click(trigger);
    /* Auto row is always first in the popover; clicking it clears the
       override (passes null to setVoiceOverride). */
    fireEvent.click(screen.getByRole('option', { name: /Auto — currently Coqui/i }));
    await waitFor(() => {
      expect(setVoiceOverride).toHaveBeenCalledWith('v_brann', null);
    });
  });

  it('surfaces a 409 refusal and does not leave the optimistic clear as the settled state (fs-38 Wave 3c Task 4)', async () => {
    /* A character whose Coqui slot is a CONSENTED CLONE. Clicking "Auto" to
       clear it applies optimistically (voicesActions.setOverride(null))
       before the server round-trips — the server (voices.ts's clear branch)
       refuses this with a 409 since it would silently revert a real
       person's voice to a catalog voice. The refusal must (a) surface as an
       error and (b) not leave the clear as the final redux state. */
    setVoiceOverride.mockClear();
    setVoiceOverride.mockRejectedValueOnce(
      new Error(
        'Voice override update failed (409): refused — a linked character carries a consented cloned voice.',
      ),
    );
    const cloned: Voice = {
      ...brannVoice,
      overrideTtsVoices: {
        coqui: { name: 'Asya Anara', libraryUuid: 'lib-clone-1', provenance: 'cloned' },
      },
    };
    const { store } = renderDrawer(brann, {
      voice: cloned,
      voices: [cloned],
      baseVoices: baseCatalog,
    });
    const trigger = await screen.findByRole('button', { name: /Model voice override/i });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('option', { name: /Auto — currently Coqui/i }));

    /* The refusal is surfaced to the user. */
    await waitFor(() => {
      expect(screen.getByText(/409/)).toBeTruthy();
    });

    /* The optimistic clear (overrideTtsVoices: null) must not survive as
       the settled redux state — the slot is restored, not left cleared.
       Assert the FULL restored slot, not just the name: a fixture that only
       checks `.name` can't tell a verbatim restore from a revert that
       rebuilds `{name}` from scratch — which is exactly what silently drops
       `libraryUuid`/`provenance` and de-marks a consented clone. */
    const brannState = store
      .getState()
      .voices.voices.find((v: Voice) => v.id === 'v_brann');
    expect(brannState?.overrideTtsVoices?.coqui).toEqual({
      name: 'Asya Anara',
      libraryUuid: 'lib-clone-1',
      provenance: 'cloned',
    });
  });

  it('locks the coqui tab and refuses further picks when this character\'s coqui slot is a consented clone (fs-38 Wave 3c Task 26 fix round 1 [F1])', async () => {
    /* This picker writes the VOICES slice via PUT /api/voices/:id/override;
       the "My voices" panel writes the CAST slice via setOverrideVoiceName.
       Neither invalidates the other — an unguarded pick here would clobber
       a cloned coqui slot server-side. The lock reads off the CAST-slice
       `character` prop (what "My voices" actually writes), not the `voice`
       prop this picker otherwise reads from. */
    setVoiceOverride.mockClear();
    const clonedCharacter: Character = {
      ...brann,
      ttsEngine: 'coqui',
      overrideTtsVoices: {
        coqui: { name: 'Asya Anara', libraryUuid: 'lib-clone-1', provenance: 'cloned' },
      },
    };
    const clonedVoice: Voice = {
      ...brannVoice,
      overrideTtsVoices: {
        coqui: { name: 'Asya Anara', libraryUuid: 'lib-clone-1', provenance: 'cloned' },
      },
    };
    renderDrawer(clonedCharacter, {
      voice: clonedVoice,
      voices: [clonedVoice],
      baseVoices: baseCatalog,
    });

    const trigger = await screen.findByRole('button', { name: /Model voice override/i });
    expect(trigger).toBeDisabled();
    expect(screen.getByTestId('coqui-clone-locked-note')).toBeInTheDocument();

    /* Drive the click anyway (not just assert the attribute) — a disabled
       native <button> doesn't fire its click handler even via fireEvent,
       so this proves the popover never opens and the write path is
       genuinely unreachable, not just visually greyed out. */
    fireEvent.click(trigger);
    expect(screen.queryByRole('option', { name: /Damien Black/i })).toBeNull();
    await Promise.resolve();
    expect(setVoiceOverride).not.toHaveBeenCalled();
  });

  it('does not lock the coqui tab when the coqui slot is a plain catalog pick (no provenance)', async () => {
    /* Guards against the lock being over-broad: a character with an
       ordinary (non-cloned) coqui override must keep the picker usable. */
    renderDrawer(brann, {
      voice: { ...brannVoice, overrideTtsVoices: { coqui: { name: 'Asya Anara' } } },
      voices: [brannVoice],
      baseVoices: baseCatalog,
    });
    const trigger = await screen.findByRole('button', { name: /Model voice override/i });
    expect(trigger).not.toBeDisabled();
    expect(screen.queryByTestId('coqui-clone-locked-note')).toBeNull();
  });

  it('force-closes an already-open popover when the lock flips on mid-session, so Auto cannot null the clone slot (fs-38 Wave 3c Task 26 fix round 2 [F1 residual])', async () => {
    /* The gap the first F1 fix missed: picking "Auto" calls onChange(null),
       which carries no engine info at all, so a guard keyed on
       `next?.engine === 'coqui'` never fires for it — and `disabled` alone
       doesn't close an ALREADY-open popover. Reproduces the exact sequence
       the reviewer described: starts unlocked (popover openable), the
       character's coqui slot flips to a consented clone WHILE the popover is
       open (mirrors a cross-tab BroadcastChannel sync updating the cast
       slice mid-session — layout.tsx re-selects `character` from
       `s.cast.characters` and passes a fresh prop down), then Auto must be
       unreachable. */
    setVoiceOverride.mockClear();
    const unlockedCharacter: Character = {
      ...brann,
      ttsEngine: 'coqui',
      overrideTtsVoices: { coqui: { name: 'Asya Anara' } }, // no provenance yet — unlocked
    };
    const unlockedVoice: Voice = {
      ...brannVoice,
      overrideTtsVoices: { coqui: { name: 'Asya Anara' } },
    };
    const { store, rerender } = renderDrawer(unlockedCharacter, {
      voice: unlockedVoice,
      voices: [unlockedVoice],
      baseVoices: baseCatalog,
    });

    const trigger = await screen.findByRole('button', { name: /Model voice override/i });
    expect(trigger).not.toBeDisabled();
    fireEvent.click(trigger);
    /* Popover genuinely open — Auto is a reachable option right now. */
    expect(screen.getByRole('option', { name: /Auto — currently Coqui/i })).toBeTruthy();

    /* Flip the lock ON while the popover stays open — simulates the clone
       landing via a source other than this drawer's own click handler. */
    const lockedCharacter: Character = {
      ...unlockedCharacter,
      overrideTtsVoices: {
        coqui: { name: 'Asya Anara', libraryUuid: 'lib-clone-1', provenance: 'cloned' },
      },
    };
    rerender(
      <Provider store={store}>
        <ProfileDrawer
          character={lockedCharacter}
          voice={unlockedVoice}
          onClose={() => {}}
          onSave={() => {}}
          onLock={() => {}}
        />
      </Provider>,
    );

    /* The popover force-closes — Auto is no longer in the DOM at all, not
       merely unclickable. */
    expect(screen.queryByRole('option', { name: /Auto — currently Coqui/i })).toBeNull();
    expect(screen.getByRole('button', { name: /Model voice override/i })).toBeDisabled();

    await Promise.resolve();
    expect(setVoiceOverride).not.toHaveBeenCalled();
  });

  it('shows a filled-slot indicator on the engine tab when that engine has an override', async () => {
    /* The "dot" badge on a tab tells the user at a glance which engines
       have a manual assignment without having to click each tab. */
    const overridden: Voice = {
      ...brannVoice,
      overrideTtsVoices: { gemini: { name: 'Charon' } },
    };
    renderDrawer(brann, { voice: overridden, voices: [overridden], baseVoices: baseCatalog });
    const geminiTab = await screen.findByRole('tab', { name: /Gemini/i });
    /* Filled-slot dot is added inside the tab button when that engine
       has a non-empty slot. */
    expect(geminiTab.querySelector('.bg-magenta')).toBeTruthy();
  });

  it("switching tabs swaps which engine's catalog the picker shows", async () => {
    renderDrawer(brann, { voice: brannVoice, voices: [brannVoice], baseVoices: baseCatalog });
    /* Default tab (Coqui) — open the picker, only Coqui voices listed
       (besides Auto). */
    const coquiTrigger = await screen.findByRole('button', {
      name: /Model voice override.*coqui/i,
    });
    fireEvent.click(coquiTrigger);
    expect(screen.queryByRole('option', { name: 'Charon' })).toBeNull();
    expect(screen.getByRole('option', { name: /Asya Anara/ })).toBeTruthy();
    /* Close the popover, switch to Gemini tab, re-open. */
    fireEvent.click(coquiTrigger);
    fireEvent.click(screen.getByRole('tab', { name: /Gemini/i }));
    const geminiTrigger = await screen.findByRole('button', {
      name: /Model voice override.*gemini/i,
    });
    fireEvent.click(geminiTrigger);
    expect(screen.getByRole('option', { name: /Charon/ })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'Asya Anara' })).toBeNull();
  });
});

describe('ProfileDrawer voice-preview while editing', () => {
  const brann: Character = {
    id: 'brann',
    name: 'Brann',
    role: 'protagonist',
    color: 'eliza',
    lines: 50,
    scenes: 5,
    gender: 'male',
    ageRange: 'teen',
  };
  const brannVoice: Voice = {
    id: 'v_brann',
    character: 'Brann',
    bookTitle: 'Book One',
    bookId: 'b1',
    attributes: ['Male', 'Teen'],
    gradient: ['#3C194F', '#0F0E0D'],
    usedIn: 1,
    source: 'current',
    ttsVoice: { provider: 'coqui', name: 'Aaron Dreschner', description: 'Mid · Male' },
  };
  const baseCatalog: BaseVoice[] = [
    { engine: 'coqui', name: 'Asya Anara' },
    { engine: 'coqui', name: 'Damien Black' },
    { engine: 'gemini', name: 'Charon' },
  ];

  it('keeps the candidate-preview list collapsed by default; toggle expands it', async () => {
    renderDrawer(brann, { voice: brannVoice, voices: [brannVoice], baseVoices: baseCatalog });
    /* List + textarea are hidden until the user opens the section — keeps
       the drawer tidy on first open. */
    expect(screen.queryByTestId('voice-preview-candidates')).toBeNull();
    expect(screen.queryByTestId('voice-preview-sample-text')).toBeNull();

    fireEvent.click(screen.getByTestId('voice-preview-toggle'));
    expect(screen.getByTestId('voice-preview-candidates')).toBeTruthy();
    /* Default sample text is the pangram + follow-on. */
    expect((screen.getByTestId('voice-preview-sample-text') as HTMLTextAreaElement).value).toMatch(
      /quick brown fox/i,
    );
  });

  it('clicking Play on a candidate row routes through playBaseVoiceSampleWithAutoLoad with the user-edited text', async () => {
    vi.mocked(playBaseVoiceSampleWithAutoLoad).mockClear();
    renderDrawer(brann, { voice: brannVoice, voices: [brannVoice], baseVoices: baseCatalog });
    fireEvent.click(screen.getByTestId('voice-preview-toggle'));
    /* User edits the sample line before auditioning. */
    fireEvent.change(screen.getByTestId('voice-preview-sample-text'), {
      target: { value: 'Halloran takes the bridge.' },
    });
    fireEvent.click(screen.getByTestId('voice-preview-play-Asya Anara'));
    await waitFor(() => expect(playBaseVoiceSampleWithAutoLoad).toHaveBeenCalledTimes(1));
    expect(vi.mocked(playBaseVoiceSampleWithAutoLoad).mock.calls[0][0].args).toMatchObject({
      engine: 'coqui',
      speakerName: 'Asya Anara',
      text: 'Halloran takes the bridge.',
    });
  });

  it('clicking Play on a SECOND candidate forwards the new voice (read-only audition, no commit)', async () => {
    vi.mocked(playBaseVoiceSampleWithAutoLoad).mockClear();
    const onSave = vi.fn();
    renderDrawer(brann, { voice: brannVoice, voices: [brannVoice], baseVoices: baseCatalog });
    fireEvent.click(screen.getByTestId('voice-preview-toggle'));

    fireEvent.click(screen.getByTestId('voice-preview-play-Asya Anara'));
    await waitFor(() => expect(playBaseVoiceSampleWithAutoLoad).toHaveBeenCalledTimes(1));
    expect(vi.mocked(playBaseVoiceSampleWithAutoLoad).mock.calls[0][0].args.speakerName).toBe(
      'Asya Anara',
    );

    /* Audition a second candidate — both calls fire, both with their own
       speakerName. The override-picker select is untouched, so onSave is
       never called: preview is strictly read-only. */
    fireEvent.click(screen.getByTestId('voice-preview-play-Damien Black'));
    await waitFor(() => expect(playBaseVoiceSampleWithAutoLoad).toHaveBeenCalledTimes(2));
    expect(vi.mocked(playBaseVoiceSampleWithAutoLoad).mock.calls[1][0].args.speakerName).toBe(
      'Damien Black',
    );
    expect(onSave).not.toHaveBeenCalled();
  });

  it('switching the engine tab swaps which catalog the preview list shows', async () => {
    renderDrawer(brann, { voice: brannVoice, voices: [brannVoice], baseVoices: baseCatalog });
    fireEvent.click(screen.getByTestId('voice-preview-toggle'));
    /* Default tab (Coqui) lists Asya + Damien but not Charon. */
    expect(screen.getByTestId('voice-preview-row-Asya Anara')).toBeTruthy();
    expect(screen.getByTestId('voice-preview-row-Damien Black')).toBeTruthy();
    expect(screen.queryByTestId('voice-preview-row-Charon')).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: /Gemini/i }));
    expect(screen.getByTestId('voice-preview-row-Charon')).toBeTruthy();
    expect(screen.queryByTestId('voice-preview-row-Asya Anara')).toBeNull();
  });

  it('persists the sample text to localStorage so it survives drawer re-opens', async () => {
    /* The drawer is the only consumer; jsdom backs localStorage with an
       in-memory map so the assertion is deterministic. */
    window.localStorage.removeItem('voice-preview-sample-text');
    renderDrawer(brann, { voice: brannVoice, voices: [brannVoice], baseVoices: baseCatalog });
    fireEvent.click(screen.getByTestId('voice-preview-toggle'));
    fireEvent.change(screen.getByTestId('voice-preview-sample-text'), {
      target: { value: 'Bespoke preview line.' },
    });
    expect(window.localStorage.getItem('voice-preview-sample-text')).toBe('Bespoke preview line.');
  });
});

describe('ProfileDrawer alias chip editing', () => {
  const charWithAliases: Character = {
    ...baseChar,
    aliases: ['Sior', 'Jurek', 'Garrow', 'Shopkeeper'],
  };

  it('renders each alias as a chip with an Unlink X button when onUnlinkAlias is provided', () => {
    renderDrawer(charWithAliases, { onUnlinkAlias: vi.fn().mockResolvedValue(undefined) });
    /* Aliases section visible. */
    expect(screen.getByText('Also known as')).toBeTruthy();
    /* Each alias chip carries its own labelled close button. */
    expect(screen.getByRole('button', { name: 'Unlink Sior' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Unlink Jurek' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Unlink Garrow' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Unlink Shopkeeper' })).toBeTruthy();
  });

  it('omits the X button when onUnlinkAlias is not provided (read-only fallback)', () => {
    /* No onUnlinkAlias → chips render with the names but no buttons,
       preserving the pre-feature behaviour for surfaces that don't wire
       the callback. */
    renderDrawer(charWithAliases);
    expect(screen.getByText('Sior')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Unlink Sior' })).toBeNull();
  });

  it('clicking the X opens the dialog; confirming split dispatches onUnlinkAlias', async () => {
    const onUnlinkAlias = vi.fn().mockResolvedValue(undefined);
    renderDrawer(charWithAliases, { onUnlinkAlias, mergeCandidates: [{ id: 'wren', name: 'Wren' }] as never });
    fireEvent.click(screen.getByRole('button', { name: 'Unlink Garrow' }));
    // Dialog opens; default = split.
    fireEvent.click(await screen.findByRole('button', { name: /continue/i }));
    await waitFor(() => {
      expect(onUnlinkAlias).toHaveBeenCalledWith('halloran', 'Garrow', { mode: 'split' });
    });
  });

  it('choosing "move to X" dispatches onUnlinkAlias with the move destination', async () => {
    const onUnlinkAlias = vi.fn().mockResolvedValue(undefined);
    renderDrawer(charWithAliases, { onUnlinkAlias, mergeCandidates: [{ id: 'wren', name: 'Wren' }] as never });
    fireEvent.click(screen.getByRole('button', { name: 'Unlink Garrow' }));
    fireEvent.click(await screen.findByRole('radio', { name: /move/i }));
    fireEvent.change(screen.getByRole('combobox', { name: /move .* to/i }), { target: { value: 'wren' } });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    await waitFor(() => {
      expect(onUnlinkAlias).toHaveBeenCalledWith('halloran', 'Garrow', { mode: 'move', targetCharacterId: 'wren' });
    });
  });

  it('disables the dialog buttons while the unlink is in flight (no double-fire)', async () => {
    let resolveIt!: () => void;
    const onUnlinkAlias = vi.fn(() => new Promise<void>((r) => { resolveIt = r; }));
    renderDrawer(charWithAliases, { onUnlinkAlias, mergeCandidates: [{ id: 'wren', name: 'Wren' }] as never });
    fireEvent.click(screen.getByRole('button', { name: 'Unlink Garrow' }));
    fireEvent.click(await screen.findByRole('button', { name: /continue/i }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /continue/i })).toHaveProperty('disabled', true);
    });
    resolveIt();
  });

  it('surfaces a server error inside the dialog without closing it', async () => {
    const onUnlinkAlias = vi.fn().mockRejectedValue(new Error('Backend exploded'));
    renderDrawer(charWithAliases, { onUnlinkAlias, mergeCandidates: [{ id: 'wren', name: 'Wren' }] as never });
    fireEvent.click(screen.getByRole('button', { name: 'Unlink Garrow' }));
    fireEvent.click(await screen.findByRole('button', { name: /continue/i }));
    await screen.findByText(/Backend exploded/);
    // Dialog still open (Continue button still present).
    expect(screen.getByRole('button', { name: /continue/i })).toBeTruthy();
  });

  it('does not leak a stale add-alias error into a freshly-opened unlink dialog', async () => {
    /* Regression for a task-5 review finding: aliasError is shared between
       the add-alias and unlink-alias failure paths. A failed "+ Add alias"
       attempt used to leave its error message visible when the unlink
       dialog was opened right after, via the dialog's error={aliasError}
       prop. Opening the dialog must clear it, same as the "+ Add alias"
       open-handler already does. */
    const onAddAlias = vi.fn().mockRejectedValue(new Error('Add boom'));
    const onUnlinkAlias = vi.fn().mockResolvedValue(undefined);
    renderDrawer(charWithAliases, {
      onAddAlias,
      onUnlinkAlias,
      mergeCandidates: [{ id: 'wren', name: 'Wren' }] as never,
    });

    // Fail an add-alias attempt so `aliasError` gets set.
    fireEvent.click(screen.getByRole('button', { name: 'Add alias' }));
    const input = screen.getByRole('textbox', { name: 'New alias name' });
    fireEvent.change(input, { target: { value: 'Captain' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await screen.findByText(/Add boom/);

    // Now open the unlink dialog for a chip.
    fireEvent.click(screen.getByRole('button', { name: 'Unlink Garrow' }));
    const dialog = await screen.findByRole('dialog', { name: 'Unlink alias' });

    // The stale add-alias error must not have leaked into the dialog.
    expect(within(dialog).queryByText(/Add boom/)).toBeNull();
  });

  it('reopens the unlink dialog after Cancel (chip ✕ is not disabled post-cancel)', async () => {
    const onUnlinkAlias = vi.fn().mockResolvedValue(undefined);
    renderDrawer(charWithAliases, { onUnlinkAlias, mergeCandidates: [{ id: 'wren', name: 'Wren' }] as never });

    fireEvent.click(screen.getByRole('button', { name: 'Unlink Garrow' }));
    await screen.findByRole('dialog', { name: 'Unlink alias' });

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Unlink alias' })).toBeNull();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Unlink Garrow' }));
    const dialog = await screen.findByRole('dialog', { name: 'Unlink alias' });
    // No stale error banner in the reopened dialog.
    expect(within(dialog).queryByText(/⚠/)).toBeNull();
  });

  it('shows the "+ Add alias" button when onAddAlias is provided', () => {
    renderDrawer(charWithAliases, { onAddAlias: vi.fn().mockResolvedValue(undefined) });
    expect(screen.getByRole('button', { name: 'Add alias' })).toBeTruthy();
  });

  it('clicking + Add alias reveals an input that submits via Enter', async () => {
    const onAddAlias = vi.fn().mockResolvedValue(undefined);
    renderDrawer(baseChar, { onAddAlias });
    fireEvent.click(screen.getByRole('button', { name: 'Add alias' }));
    const input = screen.getByRole('textbox', { name: 'New alias name' });
    fireEvent.change(input, { target: { value: 'Captain' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect(onAddAlias).toHaveBeenCalledWith('halloran', 'Captain');
    });
  });

  it('Escape cancels the inline add input without dispatching', async () => {
    const onAddAlias = vi.fn().mockResolvedValue(undefined);
    renderDrawer(baseChar, { onAddAlias });
    fireEvent.click(screen.getByRole('button', { name: 'Add alias' }));
    const input = screen.getByRole('textbox', { name: 'New alias name' });
    fireEvent.change(input, { target: { value: 'Captain' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    /* Input collapses back to the +Add button; nothing dispatched. */
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Add alias' })).toBeTruthy();
    });
    expect(onAddAlias).not.toHaveBeenCalled();
  });

  it('renders the "Also known as" header + add affordance even when the character has no aliases', () => {
    /* The Add button needs to be reachable on aliasless characters so the
       user can stitch in a name the analyzer missed. */
    renderDrawer(baseChar, { onAddAlias: vi.fn().mockResolvedValue(undefined) });
    expect(screen.getByText('Also known as')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add alias' })).toBeTruthy();
  });
});

describe('ProfileDrawer per-character engine + Qwen bespoke voice (plan 108)', () => {
  /* Renders the drawer WITH a bookId + an onSave spy so the Qwen
     design + series-scoped override path can be exercised. */
  function renderWithBook(character: Character, onSave = vi.fn()) {
    const store = makeStore({});
    /* Spy on dispatch BEFORE render so the component's useAppDispatch captures
       the spied reference — lets the background-design tests assert the
       designSingleRequested dispatch fired on click. */
    const dispatchSpy = vi.spyOn(store, 'dispatch');
    const utils = render(
      <Provider store={store}>
        <ProfileDrawer
          character={character}
          voice={undefined}
          bookId="book-1"
          onClose={() => {}}
          onSave={onSave}
          onLock={() => {}}
        />
      </Provider>,
    );
    return { store, onSave, dispatchSpy, ...utils };
  }

  function selectQwen() {
    const select = screen.getByLabelText('Voice engine for this character');
    fireEvent.change(select, { target: { value: 'qwen' } });
  }

  it('shows the persona textarea + Regenerate + Design buttons when Qwen is selected', async () => {
    renderWithBook({ ...baseChar, voiceStyle: 'a steady adult voice' });
    selectQwen();
    expect(screen.getByTestId('qwen-design-panel')).toBeTruthy();
    expect((screen.getByTestId('qwen-persona-text') as HTMLTextAreaElement).value).toBe(
      'a steady adult voice',
    );
    expect(screen.getByTestId('qwen-regenerate-persona')).toBeTruthy();
    expect(screen.getByTestId('qwen-design-voice')).toBeTruthy();
  });

  it('auto-generates a persona on first switch to Qwen when none exists', async () => {
    generateVoiceStyle.mockClear();
    renderWithBook(baseChar); // no voiceStyle
    selectQwen();
    await waitFor(() => {
      expect(generateVoiceStyle).toHaveBeenCalledWith('book-1', 'halloran');
    });
    await waitFor(() => {
      expect((screen.getByTestId('qwen-persona-text') as HTMLTextAreaElement).value).toBe(
        'a bright, confident teenage voice',
      );
    });
  });

  it('seeds the persona textarea from the designed voice sidecar when voiceStyle is empty (plan 149)', async () => {
    /* A reused/origin Qwen character whose persona lives only on the voice
       sidecar (no `voiceStyle`): the drawer lazily reads `instruct` and seeds
       the textarea so it isn't wrongly blank and a re-design isn't blocked. */
    fetchDesignedPersona.mockClear();
    fetchDesignedPersona.mockResolvedValueOnce({
      instruct: 'A relatable teen girl, clear and earnest',
    });
    renderWithBook({
      ...baseChar,
      ttsEngine: 'qwen',
      voiceId: 'halloran',
      overrideTtsVoices: { qwen: { name: 'qwen-halloran' } },
      // deliberately no voiceStyle
    });
    await waitFor(() => {
      expect(fetchDesignedPersona).toHaveBeenCalledWith('book-1', 'halloran');
    });
    await waitFor(() => {
      expect((screen.getByTestId('qwen-persona-text') as HTMLTextAreaElement).value).toBe(
        'A relatable teen girl, clear and earnest',
      );
    });
  });

  it('does NOT look up the sidecar persona when the character already has a voiceStyle (plan 149)', async () => {
    /* An existing persona must not be clobbered — the effect guards on an
       empty voiceStyle, so the sidecar GET is never fired. */
    fetchDesignedPersona.mockClear();
    renderWithBook({
      ...baseChar,
      ttsEngine: 'qwen',
      overrideTtsVoices: { qwen: { name: 'qwen-halloran' } },
      voiceStyle: 'an existing user persona',
    });
    expect((screen.getByTestId('qwen-persona-text') as HTMLTextAreaElement).value).toBe(
      'an existing user persona',
    );
    await Promise.resolve();
    expect(fetchDesignedPersona).not.toHaveBeenCalled();
  });

  it('regenerates the persona via the api on Regenerate click', async () => {
    generateVoiceStyle.mockClear();
    generateVoiceStyle.mockResolvedValueOnce({ voiceStyle: 'a regenerated gravelly voice' });
    renderWithBook({ ...baseChar, voiceStyle: 'old persona' });
    selectQwen();
    fireEvent.click(screen.getByTestId('qwen-regenerate-persona'));
    await waitFor(() => {
      expect((screen.getByTestId('qwen-persona-text') as HTMLTextAreaElement).value).toBe(
        'a regenerated gravelly voice',
      );
    });
  });

  it('RE-design (existing voice) dispatches a redesign request; the slice opens the A/B compare; approve promotes it (plan 161 + single-design slice)', async () => {
    /* A character that ALREADY has a designed bespoke voice has something to
       put on Side A, so re-designing opens the A/B compare against it. The
       drawer now DISPATCHES a background redesign instead of awaiting the API;
       the middleware drives the slice to `ready-to-compare`, which the drawer
       reflects by opening the compare modal. Here we seed that slice state
       directly (no middleware in this store). */
    promoteQwenVoice.mockClear();
    const { store, dispatchSpy } = renderWithBook({
      ...baseChar,
      ttsEngine: 'qwen',
      voiceId: 'v_hal',
      overrideTtsVoices: { qwen: { name: 'qwen-halloran' } },
      voiceStyle: 'a steady adult voice',
    });
    selectQwen();
    /* The button reads "Design & compare" when there's an existing voice. */
    expect(screen.getByTestId('qwen-design-voice').textContent).toMatch(/Design & compare/i);
    fireEvent.click(screen.getByTestId('qwen-design-voice'));
    /* The click dispatched a background redesign request (mode:'redesign'). */
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: castDesignActions.designSingleRequested.type,
        payload: expect.objectContaining({
          bookId: 'book-1',
          characterId: 'halloran',
          persona: 'a steady adult voice',
          mode: 'redesign',
          modelKey: 'qwen3-tts-0.6b',
        }),
      }),
    );

    /* Simulate the middleware completing the redesign: the preview is staged
       and the slice flips to ready-to-compare. */
    act(() => {
      store.dispatch(
        castDesignActions.beginSingle({
          bookId: 'book-1',
          characterId: 'halloran',
          name: 'Captain Halloran',
          mode: 'redesign',
          lastTickAt: 1,
        }),
      );
      store.dispatch(
        castDesignActions.previewReady({
          bookId: 'book-1',
          characterId: 'halloran',
          previewVoiceId: 'qwen-halloran-preview',
          previewUrl: '/audio/voices/char-halloran-preview.mp3',
          persona: 'a steady adult voice',
          lastTickAt: 2,
        }),
      );
    });

    /* The compare modal opens; staging the promoted voice is deferred to approve
       (promote not called until the user keeps the proposed voice). */
    await waitFor(() => expect(screen.getByTestId('voice-compare-overlay')).toBeTruthy());
    expect(promoteQwenVoice).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('voice-compare-approve'));
    await waitFor(() => expect(promoteQwenVoice).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByTestId('voice-compare-overlay')).toBeNull());
    /* Resolving the compare cleared the slice. */
    expect(store.getState().castDesign.active).toBeNull();
  });

  it('approving a redesign clears the character’s stale emotion variants from redux (regression: Save would re-persist them, clobbering the server teardown)', async () => {
    /* promote-voice tears the variants off cast.json + disk on approve. If the
       drawer kept them in redux, onSave → cast/setCharacters → persistence
       middleware would re-write the deleted slots back into cast.json (pointing
       at .pt files that no longer exist). Approve must mirror the server
       teardown by clearing them locally. */
    promoteQwenVoice.mockClear();
    const { store, dispatchSpy } = renderWithBook({
      ...baseChar,
      ttsEngine: 'qwen',
      voiceId: 'v_hal',
      voiceUuid: 'v_hal',
      overrideTtsVoices: {
        qwen: { name: 'qwen-v_hal', variants: { angry: { name: 'qwen-v_hal__angry' } } },
      },
      voiceStyle: 'a steady adult voice',
    });
    selectQwen();
    fireEvent.click(screen.getByTestId('qwen-design-voice'));
    act(() => {
      store.dispatch(
        castDesignActions.beginSingle({
          bookId: 'book-1',
          characterId: 'halloran',
          name: 'Captain Halloran',
          mode: 'redesign',
          lastTickAt: 1,
        }),
      );
      store.dispatch(
        castDesignActions.previewReady({
          bookId: 'book-1',
          characterId: 'halloran',
          previewVoiceId: 'qwen-halloran-preview',
          previewUrl: '/audio/voices/char-halloran-preview.mp3',
          persona: 'a steady adult voice',
          lastTickAt: 2,
        }),
      );
    });
    await waitFor(() => expect(screen.getByTestId('voice-compare-overlay')).toBeTruthy());

    fireEvent.click(screen.getByTestId('voice-compare-approve'));
    await waitFor(() => expect(promoteQwenVoice).toHaveBeenCalledTimes(1));

    /* Approve dispatched the redux mirror of the server teardown… */
    expect(dispatchSpy).toHaveBeenCalledWith(
      castActions.clearCharacterEmotionVariants({ characterId: 'halloran' }),
    );
    /* …and the variants are actually gone from the slice. */
    const hal = store.getState().cast.characters.find((c) => c.id === 'halloran');
    expect(hal?.overrideTtsVoices?.qwen?.variants).toBeUndefined();
  });

  it('persists the freshly-approved voiceUuid on Save (regression: srv-43 uuid was staged in-drawer only, dropped on Save)', async () => {
    /* A character whose row has NO voiceUuid yet (e.g. designed before srv-43,
       or never stamped) redesigns via the A/B compare and approves — approve
       seeds `stagedVoiceUuid` from the server's response, which was
       previously read ONLY by the in-drawer "Play 12s" button and never
       carried into the Character object handed to onSave. Without it, the
       saved cast row keeps overrideTtsVoices.qwen.name (correct) but a null
       voiceUuid, so pickVoiceForEngine (server/src/tts/voice-mapping.ts)
       falls back to `qwen-<character.id>` instead of the real uuid-keyed
       file at synth time — a 409 voice_not_designed even though the row
       shows "Designed". */
    promoteQwenVoice.mockClear();
    promoteQwenVoice.mockResolvedValueOnce({
      voiceId: 'qwen-fresh-uuid-abc123',
      url: '/audio/voices/char-halloran-qwen3-tts-0.6b-mock.mp3',
      voiceUuid: 'fresh-uuid-abc123',
    });
    const { store, onSave } = renderWithBook({
      ...baseChar,
      ttsEngine: 'qwen',
      voiceId: 'v_hal',
      overrideTtsVoices: { qwen: { name: 'qwen-halloran' } },
      voiceStyle: 'a steady adult voice',
      // deliberately no voiceUuid — mirrors a row that never had one stamped.
    });
    selectQwen();
    /* This test's store has no middleware, so — unlike the "RE-design
       (existing voice)..." test above, which asserts the click dispatches
       designSingleRequested — a click on qwen-design-voice here would have
       no observable effect. The compare overlay is driven directly by the
       beginSingle/previewReady dispatches below, mirroring what the
       middleware would do once the (unmocked) redesign request resolves. */
    act(() => {
      store.dispatch(
        castDesignActions.beginSingle({
          bookId: 'book-1',
          characterId: 'halloran',
          name: 'Captain Halloran',
          mode: 'redesign',
          lastTickAt: 1,
        }),
      );
      store.dispatch(
        castDesignActions.previewReady({
          bookId: 'book-1',
          characterId: 'halloran',
          previewVoiceId: 'qwen-fresh-uuid-abc123-preview',
          previewUrl: '/audio/voices/char-halloran-preview.mp3',
          persona: 'a steady adult voice',
          lastTickAt: 2,
        }),
      );
    });
    await waitFor(() => expect(screen.getByTestId('voice-compare-overlay')).toBeTruthy());

    fireEvent.click(screen.getByTestId('voice-compare-approve'));
    await waitFor(() => expect(promoteQwenVoice).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByTestId('voice-compare-overlay')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: /Save changes/i }));

    expect(onSave).toHaveBeenCalledTimes(1);
    const next = onSave.mock.calls[0][0] as Character;
    expect(next.voiceUuid).toBe('fresh-uuid-abc123');
  });

  it('FIRST design (no existing voice) dispatches a first-design request; never opens the compare modal', async () => {
    /* A/B compare is only useful when there is something to compare to. A
       first-time design has no current bespoke voice, so it dispatches a
       background first design (mode:'first'). The middleware persists + mirrors
       the qwen override into the cast slice; the drawer reflects that into its
       local designedVoiceId. No compare modal is ever opened. */
    promoteQwenVoice.mockClear();
    const { store, dispatchSpy } = renderWithBook({ ...baseChar, voiceStyle: 'a steady adult voice' });
    selectQwen();
    /* No existing voice → the button reads "Design & preview". */
    expect(screen.getByTestId('qwen-design-voice').textContent).toMatch(/Design & preview/i);
    fireEvent.click(screen.getByTestId('qwen-design-voice'));
    /* The click dispatched a first-design request (mode:'first'). */
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: castDesignActions.designSingleRequested.type,
        payload: expect.objectContaining({ characterId: 'halloran', mode: 'first' }),
      }),
    );

    /* Simulate the middleware completing the first design + persisting the
       override into the cast slice. */
    store.dispatch(castActions.setCharacters([{ ...baseChar }]));
    store.dispatch(castActions.setQwenOverrideName({ characterId: 'halloran', voiceId: 'qwen-halloran' }));

    /* The drawer mirrors the new qwen override into its local designedVoiceId
       (designed-confirm) and never opens the compare modal or promotes. */
    await waitFor(() => expect(screen.getByTestId('qwen-designed-confirm')).toBeTruthy());
    expect(screen.queryByTestId('voice-compare-overlay')).toBeNull();
    expect(promoteQwenVoice).not.toHaveBeenCalled();
  });

  /* GATE 2 C-6 — mirrors server/src/routes/single-design.ts's 409
     `clone_protected` guard: a FIRST design on a character already carrying
     a cloned voice (on EITHER clone-capable engine) would silently retarget
     it off that clone. api.ts's mock layer is deliberately stateless for
     cast, so nothing in mock mode would ever refuse this without the
     client-side mirror added alongside the server fix — this pins that the
     drawer refuses BEFORE ever dispatching, with the specific "cloned
     voice" message, not a generic failure. */
  it('[C-6] refuses a FIRST design when the character already has a cloned Coqui voice, with the specific message — never dispatches', async () => {
    const { dispatchSpy } = renderWithBook({
      ...baseChar,
      ttsEngine: 'coqui',
      voiceStyle: 'a steady adult voice',
      overrideTtsVoices: {
        coqui: { name: 'xtts-lib-1', libraryUuid: 'lib-1', provenance: 'cloned' },
      },
    });
    dispatchSpy.mockClear();
    selectQwen();
    fireEvent.click(screen.getByTestId('qwen-design-voice'));

    expect(screen.getByTestId('qwen-design-error')).toHaveTextContent(
      'already has a cloned voice',
    );
    /* THE discriminator: pre-fix nothing stops the dispatch — the mock
       cast-design layer has no cast state to refuse it against, so the
       character would be silently "designed" onto Qwen, off its clone. */
    expect(dispatchSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: castDesignActions.designSingleRequested.type }),
    );
  });

  it('renders DesignProgress when a single design is in flight for this character', async () => {
    const { store } = renderWithBook({ ...baseChar, voiceStyle: 'a steady adult voice' });
    selectQwen();
    act(() => {
      store.dispatch(
        castDesignActions.beginSingle({
          bookId: 'book-1',
          characterId: 'halloran',
          name: 'Captain Halloran',
          mode: 'first',
          lastTickAt: 1,
        }),
      );
    });
    expect(await screen.findByTestId('design-waveform')).toBeInTheDocument();
    // beginSingle seeds phase:'loading-model' (#1092 — avoids the freeing-vram
    // flash); the real phase still flows through via the SSE relay.
    expect(screen.getByText(/loading the design model/i)).toBeInTheDocument();
  });

  it('opens the compare modal when the slice is ready-to-compare for this character', async () => {
    const { store } = renderWithBook({
      ...baseChar,
      ttsEngine: 'qwen',
      voiceId: 'v_hal',
      overrideTtsVoices: { qwen: { name: 'qwen-halloran' } },
      voiceStyle: 'a steady adult voice',
    });
    act(() => {
      store.dispatch(
        castDesignActions.beginSingle({
          bookId: 'book-1',
          characterId: 'halloran',
          name: 'Captain Halloran',
          mode: 'redesign',
          lastTickAt: 1,
        }),
      );
      store.dispatch(
        castDesignActions.previewReady({
          bookId: 'book-1',
          characterId: 'halloran',
          previewVoiceId: 'qwen-halloran-preview',
          previewUrl: '/audio/voices/char-halloran-preview.mp3',
          persona: 'a steady adult voice',
          lastTickAt: 2,
        }),
      );
    });
    expect(await screen.findByRole('dialog', { name: /compare/i })).toBeInTheDocument();
  });

  it('portals the compare modal OUTSIDE the clip-path drawer aside (regression: compare rendered clipped underneath the drawer)', async () => {
    /* The drawer aside carries `scrollbar-thin`, whose `clip-path: inset(...)`
       clips ALL descendants — including `position: fixed` ones. If the
       full-screen A/B compare overlay renders as a DOM child of the aside it is
       clipped to the ~520px drawer column ("rendered underneath the drawer"),
       so it MUST be portaled out to document.body. jsdom can't see clip-path,
       but it CAN assert the overlay is not nested in the clipped aside. */
    const { store } = renderWithBook({
      ...baseChar,
      ttsEngine: 'qwen',
      voiceId: 'v_hal',
      overrideTtsVoices: { qwen: { name: 'qwen-halloran' } },
      voiceStyle: 'a steady adult voice',
    });
    act(() => {
      store.dispatch(
        castDesignActions.beginSingle({
          bookId: 'book-1',
          characterId: 'halloran',
          name: 'Captain Halloran',
          mode: 'redesign',
          lastTickAt: 1,
        }),
      );
      store.dispatch(
        castDesignActions.previewReady({
          bookId: 'book-1',
          characterId: 'halloran',
          previewVoiceId: 'qwen-halloran-preview',
          previewUrl: '/audio/voices/char-halloran-preview.mp3',
          persona: 'a steady adult voice',
          lastTickAt: 2,
        }),
      );
    });
    const overlay = await screen.findByTestId('voice-compare-overlay');
    const drawerAside = document.querySelector('[data-tour-id="profile-drawer"]');
    expect(drawerAside).toBeTruthy();
    expect(drawerAside!.contains(overlay)).toBe(false);
  });

  it('on Save writes ttsEngine=qwen + the qwen override series-scoped', async () => {
    setVoiceOverride.mockClear();
    const onSave = vi.fn();
    const char = { ...baseChar, voiceId: 'v_hal', voiceStyle: 'a steady adult voice' };
    const { store } = renderWithBook(char, onSave);
    selectQwen();
    /* First design dispatches a background request; the middleware persists +
       mirrors the qwen override into the cast slice, which the drawer reflects
       into designedVoiceId. Seed that mirror here (no middleware in this store). */
    fireEvent.click(screen.getByTestId('qwen-design-voice'));
    store.dispatch(castActions.setCharacters([char]));
    store.dispatch(castActions.setQwenOverrideName({ characterId: 'halloran', voiceId: 'qwen-halloran' }));
    await waitFor(() => expect(screen.getByTestId('qwen-designed-confirm')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /Save changes/i }));

    /* onSave carries the per-character engine + the qwen override slot. */
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const saved = onSave.mock.calls[0][0] as Character;
    expect(saved.ttsEngine).toBe('qwen');
    expect(saved.overrideTtsVoices?.qwen?.name).toBe('qwen-halloran');

    /* Series-scoped override write fired with scope:'series' + bookId. */
    expect(setVoiceOverride).toHaveBeenCalledWith(
      'v_hal',
      { engine: 'qwen', name: 'qwen-halloran' },
      { scope: 'series', bookId: 'book-1' },
    );
  });

  it('hides the preset Model voice picker while Qwen is selected', async () => {
    renderWithBook({ ...baseChar, voiceStyle: 'a steady adult voice' }, vi.fn());
    /* Preset picker label present before switching. */
    expect(screen.getByText('Model voice')).toBeTruthy();
    selectQwen();
    expect(screen.queryByText('Model voice')).toBeNull();
  });

  it('shows a bespoke Qwen card line (not the preset descriptor) when the character is Qwen', async () => {
    /* The Voice profile card must resolve against the CHARACTER's engine,
       not the project engine. A Qwen character with no designed voice shows
       "Qwen · No voice designed yet"; a designed one shows the voiceId +
       "Designed voice". Either way the preset descriptor (e.g. a Kokoro
       "Light · Male · US" line) must NOT appear. */
    renderWithBook({
      ...baseChar,
      ttsEngine: 'qwen',
      voiceStyle: 'a steady adult voice',
      overrideTtsVoices: { qwen: { name: 'qwen-halloran' } },
    });
    /* Card shows the bespoke Qwen line. */
    expect(screen.getByText(/Designed voice/)).toBeTruthy();
    expect(screen.getByText('qwen-halloran')).toBeTruthy();
    /* No preset register/gender descriptor leaks through. */
    expect(screen.queryByText(/· Male · US/)).toBeNull();
  });

  it('updates the card to a Qwen bespoke line live when switching engine to Qwen', async () => {
    /* The in-drawer engineChoice must drive the card immediately — before
       Save — so the user sees the engine switch reflected. A character
       whose project engine is the Kokoro default starts with a preset
       line; switching to Qwen flips the card to the bespoke line. */
    renderWithBook({ ...baseChar, voiceStyle: 'a steady adult voice' });
    selectQwen();
    /* With no designed voice yet, the card reads the "not designed" copy. */
    expect(screen.getByText(/No voice designed yet/)).toBeTruthy();
  });

  /* Regression: "Play 12s sample" used to send the project modelKey + a
     subject with no qwen override, so the server resolved engine=qwen with an
     empty voice name and the sidecar 400'd ("`voice` is required."). The
     sample must route to the Qwen model key and carry the designed voiceId. */
  it('Play sample for a Qwen character routes to the Qwen model key + injects the designed voiceId', async () => {
    vi.mocked(playSampleWithAutoLoad).mockClear();
    vi.mocked(playSampleWithAutoLoad).mockResolvedValueOnce({ analyzerEvicted: false });
    renderWithBook({
      ...baseChar,
      ttsEngine: 'qwen',
      voiceStyle: 'a steady adult voice',
      overrideTtsVoices: { qwen: { name: 'qwen-halloran' } },
    });
    const playBtn = screen.getByRole('button', { name: /Play 12s sample/i }) as HTMLButtonElement;
    expect(playBtn.disabled).toBe(false);
    fireEvent.click(playBtn);
    await waitFor(() => expect(playSampleWithAutoLoad).toHaveBeenCalledTimes(1));
    const args = vi.mocked(playSampleWithAutoLoad).mock.calls[0][0].args;
    expect(args.modelKey).toBe('qwen3-tts-0.6b');
    expect(args.voice.overrideTtsVoices?.qwen?.name).toBe('qwen-halloran');
  });

  it('disables Play sample for a Qwen character with no designed voice (no API call)', async () => {
    vi.mocked(playSampleWithAutoLoad).mockClear();
    renderWithBook({ ...baseChar, ttsEngine: 'qwen', voiceStyle: 'a steady adult voice' });
    const playBtn = screen.getByRole('button', { name: /Play 12s sample/i }) as HTMLButtonElement;
    expect(playBtn.disabled).toBe(true);
    expect(screen.getByText(/Design a Qwen voice below before sampling\./)).toBeTruthy();
    fireEvent.click(playBtn);
    expect(playSampleWithAutoLoad).not.toHaveBeenCalled();
  });

  it('enables Play sample after designing a voice this session, with the staged voiceId', async () => {
    vi.mocked(playSampleWithAutoLoad).mockClear();
    vi.mocked(playSampleWithAutoLoad).mockResolvedValueOnce({ analyzerEvicted: false });
    /* No persisted override yet → Play starts disabled. */
    const char = { ...baseChar, ttsEngine: 'qwen' as const, voiceStyle: 'a steady adult voice' };
    const { store } = renderWithBook(char);
    expect(
      (screen.getByRole('button', { name: /Play 12s sample/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
    /* First design dispatches a background request; once the middleware mirrors
       the qwen override into the cast slice (seeded here), the drawer reflects
       it into designedVoiceId and the sample unblocks. */
    fireEvent.click(screen.getByTestId('qwen-design-voice'));
    store.dispatch(castActions.setCharacters([char]));
    store.dispatch(castActions.setQwenOverrideName({ characterId: 'halloran', voiceId: 'qwen-halloran' }));
    await waitFor(() => expect(screen.getByTestId('qwen-designed-confirm')).toBeTruthy());
    const playBtn = screen.getByRole('button', { name: /Play 12s sample/i }) as HTMLButtonElement;
    expect(playBtn.disabled).toBe(false);
    fireEvent.click(playBtn);
    await waitFor(() => expect(playSampleWithAutoLoad).toHaveBeenCalledTimes(1));
    const args = vi.mocked(playSampleWithAutoLoad).mock.calls[0][0].args;
    expect(args.modelKey).toBe('qwen3-tts-0.6b');
    expect(args.voice.overrideTtsVoices?.qwen?.name).toBe('qwen-halloran');
  });

  it('Play sample for a non-Qwen character keeps the project model key + injects no qwen override', async () => {
    vi.mocked(playSampleWithAutoLoad).mockClear();
    vi.mocked(playSampleWithAutoLoad).mockResolvedValueOnce({ analyzerEvicted: false });
    const { store } = renderDrawer({ ...baseChar, evidence: evidenceLongFirst });
    fireEvent.click(screen.getByRole('button', { name: /Play 12s sample/i }));
    await waitFor(() => expect(playSampleWithAutoLoad).toHaveBeenCalledTimes(1));
    const args = vi.mocked(playSampleWithAutoLoad).mock.calls[0][0].args;
    expect(args.modelKey).toBe(store.getState().ui.ttsModelKey);
    expect(args.voice.overrideTtsVoices?.qwen).toBeUndefined();
  });

  it('auditions a Kokoro-overridden character in Kokoro, not the book default engine (#1839)', async () => {
    /* Book default is Coqui XTTS; this character is overridden to Kokoro via the
       engine picker (which offers coqui — profile-drawer.tsx:1163). Before the
       fix the request carried the PROJECT key (coqui-xtts-v2) and
       voice-sample.ts:121 derives the engine FROM that key on the
       character-audition branch, so the preview played in Coqui. */
    vi.mocked(playSampleWithAutoLoad).mockClear();
    vi.mocked(playSampleWithAutoLoad).mockResolvedValueOnce({ analyzerEvicted: false });
    const { store } = renderWithBook({ ...baseChar, ttsEngine: 'kokoro' });
    act(() => {
      store.dispatch(uiSlice.actions.setTtsModelKey('coqui-xtts-v2'));
    });

    fireEvent.click(screen.getByRole('button', { name: /Play 12s sample/i }));

    await waitFor(() => expect(playSampleWithAutoLoad).toHaveBeenCalledTimes(1));
    expect(vi.mocked(playSampleWithAutoLoad).mock.calls[0][0].args.modelKey).toBe('kokoro-v1');
  });

  it('auditions a Qwen character at the book tier, not the 0.6B floor (#1839)', async () => {
    /* The Start-generation modal writes ui.ttsModelKey and the cast pins
       together (layout.tsx:1731-1760), so a 1.7B session key means "this book
       renders at 1.7B" — the preview must match. */
    vi.mocked(playSampleWithAutoLoad).mockClear();
    vi.mocked(playSampleWithAutoLoad).mockResolvedValueOnce({ analyzerEvicted: false });
    const { store } = renderWithBook({
      ...baseChar,
      ttsEngine: 'qwen',
      voiceStyle: 'a steady adult voice',
      overrideTtsVoices: { qwen: { name: 'qwen-halloran' } },
    });
    act(() => {
      store.dispatch(uiSlice.actions.setTtsModelKey('qwen3-tts-1.7b'));
    });

    fireEvent.click(screen.getByRole('button', { name: /Play 12s sample/i }));

    await waitFor(() => expect(playSampleWithAutoLoad).toHaveBeenCalledTimes(1));
    expect(vi.mocked(playSampleWithAutoLoad).mock.calls[0][0].args.modelKey).toBe(
      'qwen3-tts-1.7b',
    );
  });
});

describe('ProfileDrawer "My voices" picker + "Save to my voices" (fs-38 Wave 1, Task 16)', () => {
  const myVoicesFixture: VoiceLibraryEntry[] = [
    {
      voiceUuid: 'lib1',
      name: 'Captain Halloran (library)',
      provenance: 'designed',
      tags: [],
      pinned: false,
      engines: { qwen: { status: 'ready' } },
      createdAt: '2026-06-01T09:00:00.000Z',
      updatedAt: '2026-06-01T09:00:00.000Z',
    },
  ];

  beforeEach(() => {
    assignLibraryVoice.mockClear();
    unassignLibraryVoice.mockClear();
    promoteToLibrary.mockClear();
  });

  it('lists "My voices" entries when Qwen is the effective engine', () => {
    renderDrawer(
      { ...baseChar, ttsEngine: 'qwen' },
      { bookId: 'book-1', myVoices: myVoicesFixture },
    );
    expect(screen.getByTestId('profile-drawer-my-voice-lib1')).toHaveTextContent(
      'Captain Halloran (library)',
    );
  });

  it('hides the "My voices" group + Save button on a non-Qwen character', () => {
    renderDrawer(
      { ...baseChar, ttsEngine: 'kokoro', overrideTtsVoices: { qwen: { name: 'qwen-halloran' } } },
      { bookId: 'book-1', myVoices: myVoicesFixture },
    );
    expect(screen.queryByTestId('profile-drawer-my-voice-lib1')).toBeNull();
    expect(screen.queryByTestId('profile-drawer-save-to-my-voices')).toBeNull();
  });

  it('clicking a "My voices" entry dispatches assignVoice(uuid, {bookId, characterId, modelKey}) — modelKey reflects the qwen engine choice', async () => {
    assignLibraryVoice.mockResolvedValue({ updated: 1, written: ['qwen'] });
    renderDrawer(
      { ...baseChar, ttsEngine: 'qwen' },
      { bookId: 'book-1', myVoices: myVoicesFixture },
    );
    fireEvent.click(screen.getByTestId('profile-drawer-my-voice-lib1'));
    await waitFor(() =>
      expect(assignLibraryVoice).toHaveBeenCalledWith('lib1', {
        bookId: 'book-1',
        characterId: 'halloran',
        modelKey: 'qwen3-tts-0.6b',
      }),
    );
  });

  /* Fix wave 2 (review) — the "ordering trap". The engine picker's choice is
     held in LOCAL drawer state (`engineChoice`) and only written onto
     `character.ttsEngine` on Save; useMyVoice fires the assign IMMEDIATELY,
     ahead of Save. A character with NO saved ttsEngine (so the "My voices"
     group is hidden until Qwen is picked) proves the assign call reads the
     drawer's PENDING engine choice, not the character's still-empty saved
     one — the bug this fix wave closes. */
  it('sends the PENDING (not-yet-Saved) engine choice as modelKey — the ordering-trap fix', async () => {
    assignLibraryVoice.mockResolvedValue({ updated: 1, written: ['qwen'] });
    renderDrawer(
      { ...baseChar, ttsEngine: undefined },
      { bookId: 'book-1', myVoices: myVoicesFixture },
    );
    // The character has no saved ttsEngine yet, so "My voices" isn't shown
    // until the (unsaved) engine picker is switched to Qwen.
    expect(screen.queryByTestId('profile-drawer-my-voice-lib1')).toBeNull();
    fireEvent.change(screen.getByLabelText('Voice engine for this character'), {
      target: { value: 'qwen' },
    });
    fireEvent.click(screen.getByTestId('profile-drawer-my-voice-lib1'));
    await waitFor(() =>
      expect(assignLibraryVoice).toHaveBeenCalledWith('lib1', {
        bookId: 'book-1',
        characterId: 'halloran',
        modelKey: 'qwen3-tts-0.6b',
      }),
    );
  });

  it('shows "Save to my voices" once the character has a designed Qwen voice', () => {
    renderDrawer(
      {
        ...baseChar,
        ttsEngine: 'qwen',
        overrideTtsVoices: { qwen: { name: 'qwen-halloran' } },
      },
      { bookId: 'book-1' },
    );
    expect(screen.getByTestId('profile-drawer-save-to-my-voices')).toBeInTheDocument();
  });

  it('does not show "Save to my voices" before any Qwen voice is designed', () => {
    renderDrawer({ ...baseChar, ttsEngine: 'qwen' }, { bookId: 'book-1' });
    expect(screen.queryByTestId('profile-drawer-save-to-my-voices')).toBeNull();
  });

  it('clicking "Save to my voices" dispatches promoteCharacterVoice({bookId, characterId, name})', async () => {
    promoteToLibrary.mockResolvedValue({ voiceUuid: 'lib-new', name: 'Captain Halloran' });
    renderDrawer(
      {
        ...baseChar,
        ttsEngine: 'qwen',
        overrideTtsVoices: { qwen: { name: 'qwen-halloran' } },
      },
      { bookId: 'book-1' },
    );
    fireEvent.click(screen.getByTestId('profile-drawer-save-to-my-voices'));
    await waitFor(() =>
      expect(promoteToLibrary).toHaveBeenCalledWith({
        bookId: 'book-1',
        characterId: 'halloran',
        name: 'Captain Halloran',
      }),
    );
  });

  /* fs-38 Wave 3c Task 26 — coqui is the OTHER clone-capable engine
     (tts-voice-mapping.ts resolveTtsVoiceForCharacter's coqui branch).
     "My voices" now surfaces there too, and useMyVoice must route the
     optimistic write to the coqui slot instead of hardcoding qwen. */
  it('lists "My voices" entries when Coqui is the effective engine', () => {
    renderDrawer(
      { ...baseChar, ttsEngine: 'coqui' },
      { bookId: 'book-1', myVoices: myVoicesFixture },
    );
    expect(screen.getByTestId('profile-drawer-my-voice-lib1')).toHaveTextContent(
      'Captain Halloran (library)',
    );
  });

  it('filters out "imported" entries from the coqui My-voices list (fs-38 Wave 3c Task 26 fix round 1 [F2])', () => {
    /* resolveTtsVoiceForCharacter's coqui branch only recognises provenance
       'cloned' | 'designed' (tts-voice-mapping.ts); an 'imported' entry
       assigned here would write a slot the resolver can't read, so the card
       line + Play sample would silently show a stock catalog voice until
       the next cast refetch. */
    const importedEntry: VoiceLibraryEntry = {
      voiceUuid: 'lib-imported-1',
      name: 'Imported voice',
      provenance: 'imported',
      tags: [],
      pinned: false,
      engines: { xtts: { status: 'ready' } },
      createdAt: '2026-07-01T09:00:00.000Z',
      updatedAt: '2026-07-01T09:00:00.000Z',
    };
    renderDrawer(
      { ...baseChar, ttsEngine: 'coqui' },
      { bookId: 'book-1', myVoices: [...myVoicesFixture, importedEntry] },
    );
    /* The 'designed' fixture entry (lib1) is still offered — only the
       provenance the resolver can't read is filtered. */
    expect(screen.getByTestId('profile-drawer-my-voice-lib1')).toBeInTheDocument();
    expect(screen.queryByTestId('profile-drawer-my-voice-lib-imported-1')).toBeNull();
  });

  it('does NOT filter "imported" entries for a qwen-routed character (the resolver never gates on provenance for qwen)', () => {
    const importedEntry: VoiceLibraryEntry = {
      voiceUuid: 'lib-imported-1',
      name: 'Imported voice',
      provenance: 'imported',
      tags: [],
      pinned: false,
      engines: { qwen: { status: 'ready' } },
      createdAt: '2026-07-01T09:00:00.000Z',
      updatedAt: '2026-07-01T09:00:00.000Z',
    };
    renderDrawer(
      { ...baseChar, ttsEngine: 'qwen' },
      { bookId: 'book-1', myVoices: [importedEntry] },
    );
    expect(screen.getByTestId('profile-drawer-my-voice-lib-imported-1')).toBeInTheDocument();
  });

  it('clicking a "My voices" entry on a coqui-routed character writes overrideTtsVoices.coqui, not qwen', async () => {
    /* The load-bearing case per the task: a QWEN-routed character can't
       distinguish "always writes qwen" from "writes the routed engine" — the
       assertion would pass either way. Only a coqui-routed fixture proves the
       write actually follows the routed engine. */
    /* GATE 1 [F1] — a CLONED entry is clone-capable on both engines, so the
       real route writes both slots and says so. The coqui slot is still the
       discriminator: a client that ignored `written` and hardwired qwen would
       leave it undefined. */
    assignLibraryVoice.mockResolvedValue({ updated: 1, written: ['qwen', 'coqui'] });
    fetchDesignedPersona.mockClear();
    const clonedEntry: VoiceLibraryEntry = {
      voiceUuid: 'lib-clone-1',
      name: 'Halloran (cloned)',
      provenance: 'cloned',
      tags: [],
      pinned: false,
      engines: { xtts: { status: 'ready' } },
      createdAt: '2026-07-01T09:00:00.000Z',
      updatedAt: '2026-07-01T09:00:00.000Z',
    };
    const coquiChar: Character = { ...baseChar, ttsEngine: 'coqui' };
    const { store } = renderDrawer(coquiChar, { bookId: 'book-1', myVoices: [clonedEntry] });
    /* Mirror what a real cast hydrate provides — the optimistic write needs
       a character in the cast slice to land on (renderDrawer's store starts
       with an empty cast slice; the drawer itself reads `character` from
       its own prop, not the store). */
    store.dispatch(castActions.setCharacters([coquiChar]));

    fireEvent.click(screen.getByTestId('profile-drawer-my-voice-lib-clone-1'));

    await waitFor(() =>
      expect(assignLibraryVoice).toHaveBeenCalledWith('lib-clone-1', {
        bookId: 'book-1',
        characterId: 'halloran',
        modelKey: 'coqui-xtts-v2',
      }),
    );

    const halloran = store.getState().cast.characters.find((c) => c.id === 'halloran');
    expect(halloran?.overrideTtsVoices?.coqui).toEqual({
      name: 'xtts-lib-clone-1',
      libraryUuid: 'lib-clone-1',
      provenance: 'cloned',
    });
    /* The route writes qwen unconditionally alongside coqui, and `written`
       reports both — so the mirror carries the qwen storage key too, NOT the
       xtts one (which would mean the loop ignored the per-slot prefix). */
    expect(halloran?.overrideTtsVoices?.qwen).toEqual({
      name: 'qwen-lib-clone-1',
      libraryUuid: 'lib-clone-1',
      provenance: 'cloned',
    });

    /* [F3] Pins the routedEngine === 'qwen' guard on setDesignedVoiceId: an
       xtts-prefixed designedVoiceId would leak into the plan-149 persona-fetch
       effect (guarded only on `!designedVoiceId`, not on engine) and fire
       fetchDesignedPersona for a coqui character. The guard is otherwise
       unpinned — every other assertion in this describe block never observes
       designedVoiceId at all. */
    await Promise.resolve();
    expect(fetchDesignedPersona).not.toHaveBeenCalled();
  });

  /* GATE 1 [F1] — the review finding this closes. `POST /assign` always
     writes qwen but writes coqui only when `shouldWriteCoquiSlot` holds (a
     designed entry needs its retained reference clip still on disk). Before
     the fix the drawer mirrored a coqui assignment on ANY 200, so this exact
     server response produced a "My voice" coqui slot cast.json never carried
     — and the assign thunk refetches the LIBRARY, not the cast, so nothing
     ever reconciled it. */
  it('[F1] does NOT write the coqui slot when the assign response says only qwen was written', async () => {
    assignLibraryVoice.mockResolvedValue({ updated: 1, written: ['qwen'] });
    const designedNoClipEntry: VoiceLibraryEntry = {
      voiceUuid: 'lib-designed-noclip',
      name: 'Halloran (designed)',
      provenance: 'designed',
      tags: [],
      pinned: false,
      engines: { qwen: { status: 'ready' } },
      createdAt: '2026-07-01T09:00:00.000Z',
      updatedAt: '2026-07-01T09:00:00.000Z',
    };
    const coquiChar: Character = { ...baseChar, ttsEngine: 'coqui' };
    const { store } = renderDrawer(coquiChar, {
      bookId: 'book-1',
      myVoices: [designedNoClipEntry],
    });
    store.dispatch(castActions.setCharacters([coquiChar]));

    fireEvent.click(screen.getByTestId('profile-drawer-my-voice-lib-designed-noclip'));

    await waitFor(() =>
      expect(assignLibraryVoice).toHaveBeenCalledWith('lib-designed-noclip', {
        bookId: 'book-1',
        characterId: 'halloran',
        modelKey: 'coqui-xtts-v2',
      }),
    );

    const halloran = store.getState().cast.characters.find((c) => c.id === 'halloran');
    /* THE discriminator: pre-fix this mirrored the ROUTED engine on any 200,
       so coqui was written here — an assignment cast.json never carried. */
    expect(halloran?.overrideTtsVoices?.coqui).toBeUndefined();
    /* And the qwen slot IS written, proving the reconciliation ran rather
       than the whole mirror being skipped — the opposite failure a lazier
       fix could produce. */
    expect(halloran?.overrideTtsVoices?.qwen?.libraryUuid).toBe('lib-designed-noclip');
    // The partial result is surfaced, not swallowed.
    expect(screen.getByTestId('profile-drawer-my-voices-error')).toHaveTextContent(
      'can’t be used on Coqui XTTS v2',
    );
  });

  /* #1953 — the server assigns successfully (200) but flags a designed
     voice's baked language mismatch as a non-fatal `warning`. The drawer
     must surface it at the point of assignment, not swallow a 200 as
     silent success. */
  it('#1953 surfaces the server\'s language-mismatch warning after a successful assign', async () => {
    assignLibraryVoice.mockResolvedValue({
      updated: 1,
      written: ['qwen'],
      warning:
        '"Ada"\'s voice was designed in Russian but this book is English — the audio will be unintelligible. Re-design the voice in English to fix it.',
    });
    renderDrawer(
      { ...baseChar, ttsEngine: 'qwen' },
      { bookId: 'book-1', myVoices: myVoicesFixture },
    );

    fireEvent.click(screen.getByTestId('profile-drawer-my-voice-lib1'));

    expect(await screen.findByTestId('profile-drawer-my-voices-error')).toHaveTextContent(
      'designed in Russian but this book is English',
    );
  });

  /* GATE 1, owner-decided [DELTA-I5] — the explicit "Remove voice" control.
     Nothing else in the app can take a library voice back off a character:
     `PUT /api/voices/:id/override` refuses a clear when a cloned slot is
     present and preserves cloned provenance on a set. */
  it('[DELTA-I5] the Remove control is absent until a library voice is assigned', () => {
    renderDrawer(
      { ...baseChar, ttsEngine: 'coqui' },
      { bookId: 'book-1', myVoices: myVoicesFixture },
    );
    expect(screen.queryByTestId('profile-drawer-remove-my-voice')).toBeNull();
  });

  it('[DELTA-I5] Remove clears the routed engine’s library slot and leaves other library voices alone', async () => {
    unassignLibraryVoice.mockResolvedValue({ cleared: ['qwen', 'coqui'] });
    /* The character carries THIS library voice on coqui and a DIFFERENT one
       on qwen. A remove scoped only by engine (or one that trusted `cleared`
       blindly) would take the qwen voice out too — the "erased a marker for
       an unrelated voice" shape this wave keeps hitting. */
    const assignedChar: Character = {
      ...baseChar,
      ttsEngine: 'coqui',
      overrideTtsVoices: {
        coqui: { name: 'xtts-lib-clone-1', libraryUuid: 'lib-clone-1', provenance: 'cloned' },
        qwen: { name: 'qwen-lib-other', libraryUuid: 'lib-other', provenance: 'designed' },
      },
    };
    const { store } = renderDrawer(assignedChar, { bookId: 'book-1', myVoices: myVoicesFixture });
    store.dispatch(castActions.setCharacters([assignedChar]));

    fireEvent.click(screen.getByTestId('profile-drawer-remove-my-voice'));

    await waitFor(() =>
      expect(unassignLibraryVoice).toHaveBeenCalledWith('lib-clone-1', {
        bookId: 'book-1',
        characterId: 'halloran',
      }),
    );
    await waitFor(() => {
      const c = store.getState().cast.characters.find((x) => x.id === 'halloran');
      expect(c?.overrideTtsVoices?.coqui).toBeUndefined();
    });
    const halloran = store.getState().cast.characters.find((c) => c.id === 'halloran');
    expect(halloran?.overrideTtsVoices?.qwen).toEqual({
      name: 'qwen-lib-other',
      libraryUuid: 'lib-other',
      provenance: 'designed',
    });
  });

  it('[DELTA-I5] Remove still works for a library voice that is no longer in My voices', async () => {
    /* A revoked-or-deleted entry is exactly when a character is stuck: the
       assignment survives on cast.json with nothing in the library to match
       it. The control must render off the CHARACTER, not the library list. */
    unassignLibraryVoice.mockResolvedValue({ cleared: ['coqui'] });
    const orphanedChar: Character = {
      ...baseChar,
      ttsEngine: 'coqui',
      overrideTtsVoices: {
        coqui: { name: 'xtts-lib-gone', libraryUuid: 'lib-gone', provenance: 'cloned' },
      },
    };
    const { store } = renderDrawer(orphanedChar, { bookId: 'book-1', myVoices: [] });
    store.dispatch(castActions.setCharacters([orphanedChar]));

    fireEvent.click(screen.getByTestId('profile-drawer-remove-my-voice'));

    await waitFor(() =>
      expect(unassignLibraryVoice).toHaveBeenCalledWith('lib-gone', {
        bookId: 'book-1',
        characterId: 'halloran',
      }),
    );
    await waitFor(() => {
      const c = store.getState().cast.characters.find((x) => x.id === 'halloran');
      expect(c?.overrideTtsVoices?.coqui).toBeUndefined();
    });
  });

  it('[DELTA-I5] surfaces a failed Remove instead of clearing the slot anyway', async () => {
    unassignLibraryVoice.mockRejectedValueOnce(new Error('Voice library unassign failed (500).'));
    const assignedChar: Character = {
      ...baseChar,
      ttsEngine: 'coqui',
      overrideTtsVoices: {
        coqui: { name: 'xtts-lib-clone-1', libraryUuid: 'lib-clone-1', provenance: 'cloned' },
      },
    };
    const { store } = renderDrawer(assignedChar, { bookId: 'book-1', myVoices: myVoicesFixture });
    store.dispatch(castActions.setCharacters([assignedChar]));

    fireEvent.click(screen.getByTestId('profile-drawer-remove-my-voice'));

    expect(await screen.findByTestId('profile-drawer-my-voices-error')).toHaveTextContent(
      'Voice library unassign failed (500).',
    );
    const halloran = store.getState().cast.characters.find((c) => c.id === 'halloran');
    expect(halloran?.overrideTtsVoices?.coqui?.libraryUuid).toBe('lib-clone-1');
  });

  /* fs-38 Wave 3c, Task 29 [EX-15] — the mock layer now genuinely rejects an
     assign (revoked/not-ready/wrong-engine 409s — see api.ts's
     `_mockAssignGuardError`), so this is the first test able to observe
     what useMyVoice does on a REAL rejection rather than the old
     unconditional `{ updated: 1 }`. It surfaces the rejection instead of
     optimistically showing success: no cast-slice write, and the inline
     error renders. */
  it('does not write the override and surfaces the error when assignLibraryVoice rejects', async () => {
    assignLibraryVoice.mockRejectedValueOnce(
      new Error('Cloned voice is not ready to assign yet.'),
    );
    const { store } = renderDrawer(
      { ...baseChar, ttsEngine: 'qwen' },
      { bookId: 'book-1', myVoices: myVoicesFixture },
    );
    store.dispatch(castActions.setCharacters([{ ...baseChar, ttsEngine: 'qwen' }]));

    fireEvent.click(screen.getByTestId('profile-drawer-my-voice-lib1'));

    expect(
      await screen.findByTestId('profile-drawer-my-voices-error'),
    ).toHaveTextContent('Cloned voice is not ready to assign yet.');

    // No optimistic write — the character's override slot stays untouched.
    const halloran = store.getState().cast.characters.find((c) => c.id === 'halloran');
    expect(halloran?.overrideTtsVoices?.qwen).toBeUndefined();
  });

  it('does not show "Save to my voices" for a coqui-routed character, even with a stale designed-Qwen voiceId', () => {
    /* Companion regression for widening the "My voices" panel to coqui:
       "Save to my voices" promotes the character's currently-DESIGNED QWEN
       voice specifically (promoteCharacterVoice), never whatever's in the
       routed engine's slot. A character that was previously designed on
       Qwen and then switched to coqui must not resurrect that button. */
    renderDrawer(
      {
        ...baseChar,
        ttsEngine: 'coqui',
        overrideTtsVoices: { qwen: { name: 'qwen-halloran' } },
      },
      { bookId: 'book-1', myVoices: myVoicesFixture },
    );
    expect(screen.queryByTestId('profile-drawer-save-to-my-voices')).toBeNull();
  });
});

describe('ProfileDrawer reused Qwen voice (drawer/table parity)', () => {
  /* Regression: on a Qwen project a REUSED character carries its bespoke Qwen
     voice on the matched library `voice` (the reuse path leaves the
     character's own ttsEngine/override empty). The cast row resolved this
     correctly, but the drawer re-derived from the project engine + the
     character's empty override → "Qwen · No voice designed yet", a blocked
     Play button, and a misleading "Default (Kokoro)" engine label. The drawer
     must now mirror the row: surface the reused Qwen voice, enable the sample,
     and show the lifecycle pill + Reused badge together. */
  const reusedChar: Character = {
    id: 'narrator',
    name: 'Narrator',
    role: 'Third-person observer',
    color: 'narrator',
    lines: 5396,
    scenes: 30,
    voiceId: 'v_qwen_narr',
    voiceState: 'reused',
    matchedFrom: {
      bookTitle: 'The Tidewatcher’s Oath',
      bookId: 'b_prev',
      characterId: 'narrator_prev',
      confidence: 0.95,
    },
  };
  const reusedQwenVoice: Voice = {
    id: 'v_qwen_narr',
    character: 'Narrator',
    bookTitle: 'The Tidewatcher’s Oath',
    bookId: 'b_prev',
    attributes: ['descriptive'],
    gradient: ['#E5B69C', '#C77B5C'],
    usedIn: 2,
    source: 'library',
    generated: true,
    ttsVoice: { provider: 'qwen', name: 'qwen-narrator-abc', description: 'Designed voice' },
  };

  function renderReused() {
    const store = configureStore({
      reducer: {
      ui: uiSlice.reducer,
      voices: voicesSlice.reducer,
      cast: castSlice.reducer,
      castDesign: castDesignSlice.reducer,
    },
    });
    /* Put the project on Qwen — the scenario where effectiveEngine falls back
       to the project engine. */
    store.dispatch(uiSlice.actions.setTtsModelKey('qwen3-tts-0.6b'));
    return render(
      <Provider store={store}>
        <ProfileDrawer
          character={reusedChar}
          voice={reusedQwenVoice}
          bookId="book-1"
          onClose={() => {}}
          onSave={() => {}}
          onLock={() => {}}
        />
      </Provider>,
    );
  }

  it('surfaces the reused Qwen voice on the card instead of "No voice designed yet"', () => {
    renderReused();
    expect(screen.getByText('qwen-narrator-abc')).toBeTruthy();
    expect(screen.queryByText(/No voice designed yet/)).toBeNull();
    expect(screen.queryByText(/Design a Qwen voice below before sampling/)).toBeNull();
  });

  it('enables the Play sample button (the reused voice is synthesisable)', () => {
    renderReused();
    const playBtn = screen.getByRole('button', { name: /Play 12s sample/i }) as HTMLButtonElement;
    expect(playBtn.disabled).toBe(false);
  });

  it('shows the lifecycle pill and the Carried badge together', () => {
    renderReused();
    /* voice.generated === true ⇒ "Generated" lifecycle; matchedFrom ⇒ badge. */
    expect(screen.getByText('Generated')).toBeTruthy();
    expect(screen.getByTestId('reused-badge')).toBeTruthy();
  });

  it('labels the engine default option after the project engine, not a hardcoded Kokoro', () => {
    renderReused();
    expect(screen.getByRole('option', { name: 'Default (Qwen)' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'Default (Kokoro)' })).toBeNull();
  });

  it('hides the preset Model-voice picker (the character effectively synthesises via Qwen)', () => {
    /* The picker is gated on the EFFECTIVE engine, not the live engineChoice:
       a default-engine character on a Qwen project resolves to Qwen, so the
       preset (Coqui/Kokoro/Gemini) slots are inert and must not show. */
    renderReused();
    expect(screen.queryByText('Model voice')).toBeNull();
  });

  it('still shows the preset Model-voice picker for a default-engine character on a preset project', () => {
    /* Guards against over-hiding: a default character whose project engine is
       a preset (Kokoro) must keep the picker. */
    const store = configureStore({
      reducer: {
      ui: uiSlice.reducer,
      voices: voicesSlice.reducer,
      cast: castSlice.reducer,
      castDesign: castDesignSlice.reducer,
    },
    });
    store.dispatch(uiSlice.actions.setTtsModelKey('kokoro-v1'));
    render(
      <Provider store={store}>
        <ProfileDrawer
          character={{ ...reusedChar, voiceId: undefined, voiceState: 'generated' }}
          voice={undefined}
          bookId="book-1"
          onClose={() => {}}
          onSave={() => {}}
          onLock={() => {}}
        />
      </Provider>,
    );
    expect(screen.getByText('Model voice')).toBeTruthy();
  });
});

describe('ProfileDrawer cross-book duplicate chip (fe-8)', () => {
  it('renders the "Possible duplicate of …" chip and fires onReviewDuplicate on click', () => {
    const onReviewDuplicate = vi.fn();
    renderDrawer(
      { ...baseChar, name: 'Eliza Gray' },
      {
        duplicateOther: { name: 'Eliza', bookTitle: 'Book Two' },
        onReviewDuplicate,
      },
    );
    const chip = screen.getByRole('button', { name: /Possible duplicate of/i });
    expect(chip).toBeTruthy();
    expect(chip).toHaveTextContent('Eliza');
    expect(chip).toHaveTextContent('Book Two');
    fireEvent.click(chip);
    expect(onReviewDuplicate).toHaveBeenCalledTimes(1);
  });

  it('does NOT render the chip once the candidate is resolved (duplicateOther null on re-open)', () => {
    /* Resolving the duplicate (link / variant) suppresses the candidate, so
       layout passes duplicateOther=null on the next drawer open — the chip
       disappears. */
    const { rerender, store } = renderDrawer(
      { ...baseChar, name: 'Eliza Gray' },
      { duplicateOther: { name: 'Eliza', bookTitle: 'Book Two' }, onReviewDuplicate: () => {} },
    );
    expect(screen.getByRole('button', { name: /Possible duplicate of/i })).toBeTruthy();
    rerender(
      <Provider store={store}>
        <ProfileDrawer
          character={{ ...baseChar, name: 'Eliza Gray' }}
          voice={undefined}
          onClose={() => {}}
          onSave={() => {}}
          onLock={() => {}}
          duplicateOther={null}
          onReviewDuplicate={() => {}}
        />
      </Provider>,
    );
    expect(screen.queryByRole('button', { name: /Possible duplicate of/i })).toBeNull();
  });
});

describe('ProfileDrawer — fs-60 eligibility-based engine lock', () => {
  const ruBook: LibraryBook = {
    bookId: 'ru-book-1',
    title: 'Russian Test Book',
    author: 'Test Author',
    series: 'Standalones',
    seriesPosition: null,
    isStandalone: true,
    status: 'cast_pending',
    chapterCount: 1,
    completedChapters: 0,
    characterCount: 1,
    voiceCount: 0,
    lastWorkedOn: 'today',
    coverGradient: ['#000', '#fff'],
    tags: [],
    language: 'ru',
    eligibleTtsEngines: ['qwen', 'coqui'],
  };

  it('unlocks the engine picker to Qwen + Coqui for a Coqui-eligible non-English book (ru)', () => {
    renderDrawer(baseChar, { bookId: 'ru-book-1', libraryBook: ruBook });
    expect(screen.queryByTestId('qwen-locked-note')).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Qwen (bespoke)' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Coqui XTTS' })).toBeInTheDocument();
  });

  it('still hard-locks to Qwen when Qwen is the only eligible engine (zh, no Coqui installed)', () => {
    renderDrawer(baseChar, {
      bookId: 'zh-book-1',
      libraryBook: { ...ruBook, bookId: 'zh-book-1', language: 'zh', eligibleTtsEngines: ['qwen'] },
    });
    expect(screen.getByTestId('qwen-locked-note')).toBeInTheDocument();
  });

  /* #1534 — a character linked to a prior one (`cast-link-prior.ts`, which
     copies `ttsEngine` across with no language check) can carry an on-disk
     engine the current book's language no longer allows. Pre-fs-60 every
     non-English book hard-locked to Qwen so the seed was overwritten; now it
     isn't, so `engineChoice` seeds to an engine the picker has no option for.

     Asserting on `select.value` ALONE would not catch this: with no matching
     option React DOM's `updateOptions` selects the first option, so the DOM
     reads 'default' either way — in a real browser too, not just jsdom. The
     observable defect is the state/DOM desync behind it: the picker SHOWS
     "Default (…)" while Save writes the stale engine the user never chose.
     So each case asserts BOTH halves — the displayed value and what Save
     emits — since the invariant is that they agree. */
  const saveWithoutTouchingPicker = (character: Character, extra: Parameters<typeof renderDrawer>[1]) => {
    const onSave = vi.fn();
    renderDrawer(character, { ...extra, onSave });
    const shown = (screen.getByLabelText('Voice engine for this character') as HTMLSelectElement)
      .value;
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(onSave).toHaveBeenCalledTimes(1);
    return { saved: onSave.mock.calls[0][0] as Character, shown };
  };

  it('does not save a stale ineligible engine the picker never offered (kokoro on ru)', () => {
    const { saved, shown } = saveWithoutTouchingPicker(
      { ...baseChar, ttsEngine: 'kokoro' },
      { bookId: 'ru-book-1', libraryBook: ruBook },
    );
    expect(shown).toBe('default');
    expect(saved.ttsEngine).toBeNull();
  });

  /* The clamp is against the options the picker RENDERS (kokoro/qwen/coqui),
     not against raw `eligibleTtsEngines` — 'gemini' is language-eligible for
     a Russian book yet has no option row, so an eligibility-only clamp would
     leave the same desync in place. */
  it('does not save a stale engine that is language-eligible but has no picker option (gemini)', () => {
    const { saved, shown } = saveWithoutTouchingPicker(
      { ...baseChar, ttsEngine: 'gemini' },
      {
        bookId: 'ru-book-2',
        libraryBook: {
          ...ruBook,
          bookId: 'ru-book-2',
          eligibleTtsEngines: ['qwen', 'coqui', 'gemini'],
        },
      },
    );
    expect(shown).toBe('default');
    /* Normalising to null is deliberate: the drawer renders no control for
       gemini/piper, so it must not silently re-persist one either. */
    expect(saved.ttsEngine).toBeNull();
  });

  /* #1534 review — the seed clamp alone is not enough. `useState`'s initializer
     runs once at MOUNT, but `eligibleTtsEngines` arrives on a separate fetch
     from the cast: on the `?profile=<id>` deep-link cold boot the drawer can
     mount while `state.library.books` is still empty, where eligibility falls
     back to ALL_TTS_ENGINES and a stale 'kokoro' passes the clamp. When the
     library lands the Kokoro option row disappears and nothing re-derives the
     choice — reopening the exact desync this fixes. A reconcile effect closes
     the window. */
  it("re-clamps when the book's eligibility arrives AFTER the drawer mounts", () => {
    const onSave = vi.fn();
    /* No libraryBook → eligibility is the ALL_TTS_ENGINES default at mount. */
    const { store } = renderDrawer(
      { ...baseChar, ttsEngine: 'kokoro' },
      { bookId: 'ru-book-1', onSave },
    );
    act(() => {
      store.dispatch(librarySlice.actions.addBook(ruBook));
    });
    expect(screen.queryByRole('option', { name: 'Kokoro' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect((onSave.mock.calls[0][0] as Character).ttsEngine).toBeNull();
  });

  it('leaves a still-eligible choice alone when the library lands', () => {
    const onSave = vi.fn();
    const { store } = renderDrawer(
      { ...baseChar, ttsEngine: 'coqui' },
      { bookId: 'ru-book-1', onSave },
    );
    act(() => {
      store.dispatch(librarySlice.actions.addBook(ruBook));
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect((onSave.mock.calls[0][0] as Character).ttsEngine).toBe('coqui');
  });

  it('still seeds — and saves — an eligible per-character engine unchanged (coqui on ru)', () => {
    const { saved, shown } = saveWithoutTouchingPicker(
      { ...baseChar, ttsEngine: 'coqui' },
      { bookId: 'ru-book-1', libraryBook: ruBook },
    );
    expect(shown).toBe('coqui');
    expect(saved.ttsEngine).toBe('coqui');
  });
});

describe('ProfileDrawer roster entry point (bulk reassign)', () => {
  it('invokes onReassignLines with the character id when the action is clicked', () => {
    const onReassignLines = vi.fn();
    renderDrawer(baseChar, { onReassignLines });
    fireEvent.click(screen.getByRole('button', { name: /reassign lines/i }));
    expect(onReassignLines).toHaveBeenCalledWith(baseChar.id);
  });
});
