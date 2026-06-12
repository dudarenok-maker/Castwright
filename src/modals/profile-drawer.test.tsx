// Pairs with docs/features/archive/10-profile-drawer.md

import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { uiSlice } from '../store/ui-slice';
import { voicesSlice, voicesActions } from '../store/voices-slice';
import { castSlice, castActions } from '../store/cast-slice';
import { castDesignSlice, castDesignActions } from '../store/cast-design-slice';
import { ProfileDrawer, type PriorMergeCandidate } from './profile-drawer';
import {
  playSampleWithAutoLoad,
  playBaseVoiceSampleWithAutoLoad,
} from '../lib/play-sample-with-auto-load';
import type { BaseVoice, Character, Voice } from '../lib/types';

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
const promoteQwenVoice = vi.fn((_bookId: string, _characterId: string, args?: unknown) =>
  Promise.resolve({
    voiceId: String((args as { previewVoiceId?: string })?.previewVoiceId ?? 'qwen-halloran').replace(
      /-preview$/,
      '',
    ),
    url: '/audio/voices/char-halloran-qwen3-tts-0.6b-mock.mp3',
  }),
);
const discardQwenPreview = vi.fn((_bookId: string, _characterId: string, _args?: unknown) =>
  Promise.resolve(),
);
vi.mock('../lib/api', () => ({
  api: {
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
}

function makeStore({ baseVoices, voices }: StoreSetup = {}) {
  const store = configureStore({
    reducer: {
      ui: uiSlice.reducer,
      voices: voicesSlice.reducer,
      cast: castSlice.reducer,
      castDesign: castDesignSlice.reducer,
    },
  });
  if (baseVoices) store.dispatch(voicesActions.hydrateBaseVoices(baseVoices));
  if (voices) store.dispatch(voicesActions.hydrate({ voices }));
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
    onUnlinkAlias?: (sourceCharacterId: string, aliasName: string) => Promise<void>;
    onAddAlias?: (characterId: string, aliasName: string) => Promise<void>;
    onRename?: (characterId: string, name: string) => void;
    voice?: Voice;
    baseVoices?: BaseVoice[];
    voices?: Voice[];
    duplicateOther?: { name: string; bookTitle: string } | null;
    onReviewDuplicate?: () => void;
    renderedFallbackEngine?: string | null;
  } = {},
) {
  const store = makeStore({ baseVoices: extra.baseVoices, voices: extra.voices });
  return {
    store,
    ...render(
      <Provider store={store}>
        <ProfileDrawer
          character={character}
          voice={extra.voice}
          onClose={() => {}}
          onSave={() => {}}
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
      id: 'Marlow',
      name: 'Marlow Halden',
      voiceId: 'Marlow',
      ttsEngine: 'qwen',
      voiceStyle: 'a charming, smooth-talking teenage boy',
      overrideTtsVoices: {
        qwen: { name: 'qwen-Marlow', variants: { whisper: { name: 'qwen-Marlow__whisper' } } },
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
      name: 'qwen-Marlow',
      variants: { whisper: { name: 'qwen-Marlow__whisper' } },
    });
  });
});

describe('ProfileDrawer cast roster (merge + aliases)', () => {
  const Wren: Character = {
    id: 'Wren',
    name: 'Wren',
    role: 'protagonist',
    color: 'eliza',
    lines: 5,
    scenes: 2,
  };
  const WrenFoster: Character = {
    id: 'Wren-foster',
    name: 'Wren Sparrow',
    role: 'protagonist',
    color: 'eliza',
    lines: 12,
    scenes: 4,
  };
  const Marlow: Character = {
    id: 'Marlow',
    name: 'Marlow Halden',
    role: 'sidekick',
    color: 'halloran',
    lines: 7,
    scenes: 3,
  };

  it('renders aliases as chips when the character already has merge history', () => {
    renderDrawer({ ...WrenFoster, aliases: ['Wren', 'Foster'] });
    /* "Also known as" header is shown plus a pill per alias. */
    expect(screen.getByText(/Also known as/i)).toBeTruthy();
    expect(screen.getByText('Wren')).toBeTruthy();
    expect(screen.getByText('Foster')).toBeTruthy();
  });

  it('hides the merge button when no candidates or onMerge handler are provided', () => {
    renderDrawer(Wren);
    /* No expandable picker, no merge button. */
    expect(screen.queryByRole('button', { name: /Merge .* into another character/i })).toBeNull();
  });

  it('opens the picker, calls onMerge with (source, target), and surfaces errors', async () => {
    const onMerge = vi.fn().mockResolvedValueOnce(undefined);
    renderDrawer(Wren, { mergeCandidates: [WrenFoster, Marlow], onMerge });

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
    expect(onMerge).toHaveBeenCalledWith('Wren', 'Wren-foster');
  });

  it('surfaces an error message when onMerge rejects', async () => {
    const onMerge = vi.fn().mockRejectedValueOnce(new Error('Server said no.'));
    renderDrawer(Wren, { mergeCandidates: [WrenFoster], onMerge });
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
    renderDrawer(Wren, { mergeCandidates: [WrenFoster, Marlow], onMerge });
    fireEvent.click(screen.getByRole('button', { name: /Merge Wren into another character/i }));
    fireEvent.click(screen.getByRole('button', { name: /Merge target/i }));
    const searchInput = screen.getByPlaceholderText('Search character…');
    fireEvent.change(searchInput, { target: { value: 'foster' } });
    /* Scope to the picker dialog — the drawer also renders native
       <select>s (gender, age) whose <option>s share the option role. */
    const dialog = screen.getByRole('dialog');
    const options = within(dialog).getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent(/Wren Sparrow/i);
    fireEvent.click(options[0]);
    fireEvent.click(screen.getByRole('button', { name: /^Merge$/i }));
    await Promise.resolve();
    expect(onMerge).toHaveBeenCalledWith('Wren', 'Wren-foster');
  });
});

describe('ProfileDrawer manual continuity link (prior-series optgroup)', () => {
  const Hartwell: Character = {
    id: 'Hartwell-alvin-Vale',
    name: 'Hartwell Brennan Vale',
    role: 'character',
    color: 'eliza',
    lines: 271,
    scenes: 9,
  };
  const inBookSibling: Character = {
    id: 'Wren-foster',
    name: 'Wren Sparrow',
    role: 'protagonist',
    color: 'eliza',
    lines: 12,
    scenes: 4,
  };
  const priorDex: PriorMergeCandidate = {
    id: 'Hart',
    name: 'Hart',
    bookId: 'the Hollow Tide_1',
    bookTitle: 'The Hollow Tide',
  };
  const priorMarlow: PriorMergeCandidate = {
    id: 'Marlow',
    name: 'Marlow',
    bookId: 'the Hollow Tide_1',
    bookTitle: 'The Hollow Tide',
  };

  it('renders the merge button when only prior candidates are available (no in-book siblings)', () => {
    /* The user might be on a tiny scene with just one new character —
       no in-book candidates, but prior series characters exist. The
       manual-link affordance must still surface. */
    renderDrawer(Hartwell, { mergeCandidatesPrior: [priorDex], onLinkPrior: vi.fn() });
    expect(
      screen.getByRole('button', { name: /Merge Hartwell into another character/i }),
    ).toBeTruthy();
  });

  it('renders both groups under the prior-books separator when both sets are non-empty', () => {
    renderDrawer(Hartwell, {
      mergeCandidates: [inBookSibling],
      mergeCandidatesPrior: [priorDex],
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
    renderDrawer(Hartwell, {
      mergeCandidates: [inBookSibling],
      mergeCandidatesPrior: [priorDex, priorMarlow],
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
    expect(onLinkPrior).toHaveBeenCalledWith('Hartwell-alvin-Vale', 'the Hollow Tide_1', 'Marlow');
  });

  it('still routes an in-book pick to onMerge when both groups are present', async () => {
    const onMerge = vi.fn().mockResolvedValueOnce(undefined);
    const onLinkPrior = vi.fn();
    renderDrawer(Hartwell, {
      mergeCandidates: [inBookSibling],
      mergeCandidatesPrior: [priorDex],
      onMerge,
      onLinkPrior,
    });
    fireEvent.click(screen.getByRole('button', { name: /Merge Hartwell into another character/i }));
    fireEvent.click(screen.getByRole('button', { name: /Merge target/i }));
    fireEvent.click(screen.getByRole('option', { name: /Wren Sparrow/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Merge$/i }));
    await Promise.resolve();
    expect(onMerge).toHaveBeenCalledWith('Hartwell-alvin-Vale', 'Wren-foster');
    expect(onLinkPrior).not.toHaveBeenCalled();
  });

  it('hides the merge button entirely when both groups are empty', () => {
    renderDrawer(Hartwell, {
      mergeCandidates: [],
      mergeCandidatesPrior: [],
      onMerge: vi.fn(),
      onLinkPrior: vi.fn(),
    });
    expect(screen.queryByRole('button', { name: /Merge .* into another character/i })).toBeNull();
  });

  it('surfaces an error when onLinkPrior rejects', async () => {
    const onLinkPrior = vi.fn().mockRejectedValueOnce(new Error('Cross-series link refused.'));
    renderDrawer(Hartwell, {
      mergeCandidatesPrior: [priorDex],
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
  const Brann: Character = {
    id: 'Brann',
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
          character={Brann}
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
    expect(vi.mocked(playSampleWithAutoLoad).mock.calls[0][0].args.voiceId).toBe('char-Brann');
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
          character={Brann}
          voice={undefined}
          onClose={() => {}}
          onSave={() => {}}
          onLock={() => {}}
        />
      </Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Play 12s sample/i }));
    expect(await screen.findByText(/Analyzer unloaded to free VRAM for TTS\./)).toBeTruthy();
  });

  it('renders the helper error in the drawer when prep or synth fails', async () => {
    vi.mocked(playSampleWithAutoLoad).mockClear();
    vi.mocked(playSampleWithAutoLoad).mockRejectedValueOnce(
      new Error('TTS sidecar process is not running. Launch the app via start-app.ps1.'),
    );
    render(
      <Provider store={makeStore()}>
        <ProfileDrawer
          character={Brann}
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
          character={Brann}
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
    expect(vi.mocked(playSampleWithAutoLoad).mock.calls[0][0].args.voiceId).toBe('char-Brann');
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
  const Brann: Character = {
    id: 'Brann',
    name: 'Brann',
    role: 'protagonist',
    color: 'eliza',
    lines: 50,
    scenes: 5,
    gender: 'male',
    ageRange: 'teen',
  };

  const BrannVoice: Voice = {
    id: 'v_Brann',
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
    renderDrawer(Brann, { voice: BrannVoice, voices: [BrannVoice], baseVoices: baseCatalog });
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
    renderDrawer(Brann, { voice: BrannVoice, voices: [BrannVoice], baseVoices: baseCatalog });
    const trigger = await screen.findByRole('button', { name: /Model voice override/i });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('option', { name: /Asya Anara/ }));
    await waitFor(() => {
      expect(setVoiceOverride).toHaveBeenCalledWith('v_Brann', {
        engine: 'coqui',
        name: 'Asya Anara',
      });
    });
  });

  it('clears the override when the user picks "Auto"', async () => {
    setVoiceOverride.mockClear();
    const overridden: Voice = {
      ...BrannVoice,
      overrideTtsVoices: { coqui: { name: 'Asya Anara' } },
    };
    renderDrawer(Brann, { voice: overridden, voices: [overridden], baseVoices: baseCatalog });
    const trigger = await screen.findByRole('button', { name: /Model voice override/i });
    expect(trigger).toHaveTextContent(/Asya Anara/);
    fireEvent.click(trigger);
    /* Auto row is always first in the popover; clicking it clears the
       override (passes null to setVoiceOverride). */
    fireEvent.click(screen.getByRole('option', { name: /Auto — currently Coqui/i }));
    await waitFor(() => {
      expect(setVoiceOverride).toHaveBeenCalledWith('v_Brann', null);
    });
  });

  it('shows a filled-slot indicator on the engine tab when that engine has an override', async () => {
    /* The "dot" badge on a tab tells the user at a glance which engines
       have a manual assignment without having to click each tab. */
    const overridden: Voice = {
      ...BrannVoice,
      overrideTtsVoices: { gemini: { name: 'Charon' } },
    };
    renderDrawer(Brann, { voice: overridden, voices: [overridden], baseVoices: baseCatalog });
    const geminiTab = await screen.findByRole('tab', { name: /Gemini/i });
    /* Filled-slot dot is added inside the tab button when that engine
       has a non-empty slot. */
    expect(geminiTab.querySelector('.bg-magenta')).toBeTruthy();
  });

  it("switching tabs swaps which engine's catalog the picker shows", async () => {
    renderDrawer(Brann, { voice: BrannVoice, voices: [BrannVoice], baseVoices: baseCatalog });
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
  const Brann: Character = {
    id: 'Brann',
    name: 'Brann',
    role: 'protagonist',
    color: 'eliza',
    lines: 50,
    scenes: 5,
    gender: 'male',
    ageRange: 'teen',
  };
  const BrannVoice: Voice = {
    id: 'v_Brann',
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
    renderDrawer(Brann, { voice: BrannVoice, voices: [BrannVoice], baseVoices: baseCatalog });
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
    renderDrawer(Brann, { voice: BrannVoice, voices: [BrannVoice], baseVoices: baseCatalog });
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
    renderDrawer(Brann, { voice: BrannVoice, voices: [BrannVoice], baseVoices: baseCatalog });
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
    renderDrawer(Brann, { voice: BrannVoice, voices: [BrannVoice], baseVoices: baseCatalog });
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
    renderDrawer(Brann, { voice: BrannVoice, voices: [BrannVoice], baseVoices: baseCatalog });
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

  it('clicking the X dispatches onUnlinkAlias with the chip name', async () => {
    const onUnlinkAlias = vi.fn().mockResolvedValue(undefined);
    renderDrawer(charWithAliases, { onUnlinkAlias });
    fireEvent.click(screen.getByRole('button', { name: 'Unlink Garrow' }));
    await waitFor(() => {
      expect(onUnlinkAlias).toHaveBeenCalledWith('halloran', 'Garrow');
    });
  });

  it('disables every X button while an unlink is in flight (no double-fire)', async () => {
    let resolveIt!: () => void;
    const onUnlinkAlias = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolveIt = r;
        }),
    );
    renderDrawer(charWithAliases, { onUnlinkAlias });
    fireEvent.click(screen.getByRole('button', { name: 'Unlink Garrow' }));
    /* While the promise is pending, every chip's X is disabled. */
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Unlink Sior' })).toHaveProperty('disabled', true);
    });
    resolveIt();
    /* Re-enabled after settle so the user can chain unlinks. */
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Unlink Sior' })).toHaveProperty('disabled', false);
    });
  });

  it('surfaces a server error inline without closing the chip row', async () => {
    const onUnlinkAlias = vi.fn().mockRejectedValue(new Error('Backend exploded'));
    renderDrawer(charWithAliases, { onUnlinkAlias });
    fireEvent.click(screen.getByRole('button', { name: 'Unlink Garrow' }));
    await screen.findByText(/Backend exploded/);
    /* Chips still rendered (chip removal is the layout's job via the
       store dispatch; on error nothing changed). */
    expect(screen.getByRole('button', { name: 'Unlink Garrow' })).toBeTruthy();
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
    expect(screen.getByText(/designing the voice/i)).toBeInTheDocument();
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
      bookTitle: 'The Tidewatcher's Oath',
      bookId: 'b_prev',
      characterId: 'narrator_prev',
      confidence: 0.95,
    },
  };
  const reusedQwenVoice: Voice = {
    id: 'v_qwen_narr',
    character: 'Narrator',
    bookTitle: 'The Tidewatcher's Oath',
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

  it('shows the lifecycle pill and the Reused badge together', () => {
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
