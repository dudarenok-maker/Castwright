// Pairs with docs/features/10-profile-drawer.md

import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { uiSlice } from '../store/ui-slice';
import { voicesSlice, voicesActions } from '../store/voices-slice';
import { ProfileDrawer, type PriorMergeCandidate } from './profile-drawer';
import { playSampleWithAutoLoad } from '../lib/play-sample-with-auto-load';
import type { BaseVoice, Character, Voice } from '../lib/types';

vi.mock('../lib/play-sample-with-auto-load', () => ({
  playSampleWithAutoLoad: vi.fn().mockResolvedValue({ analyzerEvicted: false }),
}));

vi.mock('../lib/use-sample-playback', () => ({
  useSamplePlayback: () => ({
    isPlaying: false,
    currentUrl: null,
    play:  vi.fn(),
    stop:  vi.fn(),
    pause: vi.fn(),
  }),
}));

const setVoiceOverride = vi.fn((_voiceId: string, _override: BaseVoice | null) => Promise.resolve());
vi.mock('../lib/api', () => ({
  api: {
    setVoiceOverride: (voiceId: string, override: BaseVoice | null) => setVoiceOverride(voiceId, override),
  },
}));

interface StoreSetup {
  baseVoices?: BaseVoice[];
  voices?: Voice[];
}

function makeStore({ baseVoices, voices }: StoreSetup = {}) {
  const store = configureStore({
    reducer: { ui: uiSlice.reducer, voices: voicesSlice.reducer },
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
    onLinkPrior?: (sourceId: string, targetBookId: string, targetCharacterId: string) => Promise<void>;
    voice?: Voice;
    baseVoices?: BaseVoice[];
    voices?: Voice[];
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
        />
      </Provider>,
    ),
  };
}

const evidenceLongFirst = [
  { quote: 'A long-form excerpt that the analyzer marks as the voice-cloning sample.', note: 'long' },
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
    const texts = Array.from(blockquotes).map(b => b.textContent);
    expect(texts).toEqual(evidenceLongFirst.map(e => e.quote));
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

describe('ProfileDrawer cast roster (merge + aliases)', () => {
  const sophie: Character = {
    id: 'sophie', name: 'Sophie', role: 'protagonist', color: 'eliza',
    lines: 5, scenes: 2,
  };
  const sophieFoster: Character = {
    id: 'sophie-foster', name: 'Sophie Foster', role: 'protagonist', color: 'eliza',
    lines: 12, scenes: 4,
  };
  const keefe: Character = {
    id: 'keefe', name: 'Keefe Sencen', role: 'sidekick', color: 'halloran',
    lines: 7, scenes: 3,
  };

  it('renders aliases as chips when the character already has merge history', () => {
    renderDrawer({ ...sophieFoster, aliases: ['Sophie', 'Foster'] });
    /* "Also known as" header is shown plus a pill per alias. */
    expect(screen.getByText(/Also known as/i)).toBeTruthy();
    expect(screen.getByText('Sophie')).toBeTruthy();
    expect(screen.getByText('Foster')).toBeTruthy();
  });

  it('hides the merge button when no candidates or onMerge handler are provided', () => {
    renderDrawer(sophie);
    /* No expandable picker, no merge button. */
    expect(screen.queryByRole('button', { name: /Merge .* into another character/i })).toBeNull();
  });

  it('opens the picker, calls onMerge with (source, target), and surfaces errors', async () => {
    const onMerge = vi.fn().mockResolvedValueOnce(undefined);
    renderDrawer(sophie, { mergeCandidates: [sophieFoster, keefe], onMerge });

    /* Toggle the picker. */
    fireEvent.click(screen.getByRole('button', { name: /Merge Sophie into another character/i }));

    /* Pick the target and submit. */
    const select = screen.getByRole('combobox', { name: /Merge target/i }) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'sophie-foster' } });
    /* Confirmation sentence appears once a target is picked. */
    expect(screen.getByText(/folded into/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /^Merge$/i }));
    /* Microtask flush so the async onMerge call resolves. */
    await Promise.resolve();
    expect(onMerge).toHaveBeenCalledWith('sophie', 'sophie-foster');
  });

  it('surfaces an error message when onMerge rejects', async () => {
    const onMerge = vi.fn().mockRejectedValueOnce(new Error('Server said no.'));
    renderDrawer(sophie, { mergeCandidates: [sophieFoster], onMerge });
    fireEvent.click(screen.getByRole('button', { name: /Merge Sophie into another character/i }));
    fireEvent.change(screen.getByRole('combobox', { name: /Merge target/i }), { target: { value: 'sophie-foster' } });
    fireEvent.click(screen.getByRole('button', { name: /^Merge$/i }));
    /* Let the rejected promise settle before assertions. */
    await Promise.resolve();
    await Promise.resolve();
    expect(await screen.findByText(/Server said no\./)).toBeTruthy();
  });
});

describe('ProfileDrawer manual continuity link (prior-series optgroup)', () => {
  const dexter: Character = {
    id: 'dexter-alvin-diznee', name: 'Dexter Alvin Diznee', role: 'character', color: 'eliza',
    lines: 271, scenes: 9,
  };
  const inBookSibling: Character = {
    id: 'sophie-foster', name: 'Sophie Foster', role: 'protagonist', color: 'eliza',
    lines: 12, scenes: 4,
  };
  const priorDex: PriorMergeCandidate = {
    id: 'dex', name: 'Dex', bookId: 'kotlc_1', bookTitle: 'Keeper of the Lost Cities',
  };
  const priorKeefe: PriorMergeCandidate = {
    id: 'keefe', name: 'Keefe', bookId: 'kotlc_1', bookTitle: 'Keeper of the Lost Cities',
  };

  it('renders the merge button when only prior candidates are available (no in-book siblings)', () => {
    /* The user might be on a tiny scene with just one new character —
       no in-book candidates, but prior series characters exist. The
       manual-link affordance must still surface. */
    renderDrawer(dexter, { mergeCandidatesPrior: [priorDex], onLinkPrior: vi.fn() });
    expect(screen.getByRole('button', { name: /Merge Dexter into another character/i })).toBeTruthy();
  });

  it('renders both groups as labeled optgroups when both sets are non-empty', () => {
    renderDrawer(dexter, {
      mergeCandidates: [inBookSibling],
      mergeCandidatesPrior: [priorDex],
      onMerge: vi.fn(),
      onLinkPrior: vi.fn(),
    });
    fireEvent.click(screen.getByRole('button', { name: /Merge Dexter into another character/i }));
    const select = screen.getByRole('combobox', { name: /Merge target/i });
    /* Both optgroup labels present. */
    const groups = within(select).getAllByRole('group');
    const labels = groups.map(g => (g as HTMLOptGroupElement).label);
    expect(labels).toContain('From this book');
    expect(labels).toContain('From prior books in this series');
    /* Both options reachable. */
    expect(within(select).getByRole('option', { name: 'Sophie Foster' })).toBeTruthy();
    expect(within(select).getByRole('option', { name: /Dex.*Keeper of the Lost Cities/i })).toBeTruthy();
  });

  it('routes a prior-option pick to onLinkPrior with (sourceId, targetBookId, targetCharacterId) and a "Link" button label', async () => {
    const onLinkPrior = vi.fn().mockResolvedValueOnce(undefined);
    renderDrawer(dexter, {
      mergeCandidates: [inBookSibling],
      mergeCandidatesPrior: [priorDex, priorKeefe],
      onMerge: vi.fn(),
      onLinkPrior,
    });
    fireEvent.click(screen.getByRole('button', { name: /Merge Dexter into another character/i }));
    const select = screen.getByRole('combobox', { name: /Merge target/i }) as HTMLSelectElement;
    /* Pick the second prior — discriminator value is 'prior:1' (index 1). */
    fireEvent.change(select, { target: { value: 'prior:1' } });
    /* Confirmation copy shifts to the link wording when a prior is picked. */
    expect(screen.getByText(/linked as the same person as/i)).toBeTruthy();
    /* Button label flips from "Merge" to "Link" when a prior is selected. */
    fireEvent.click(screen.getByRole('button', { name: /^Link$/i }));
    await Promise.resolve();
    expect(onLinkPrior).toHaveBeenCalledWith('dexter-alvin-diznee', 'kotlc_1', 'keefe');
  });

  it('still routes an in-book pick to onMerge when both groups are present', async () => {
    const onMerge = vi.fn().mockResolvedValueOnce(undefined);
    const onLinkPrior = vi.fn();
    renderDrawer(dexter, {
      mergeCandidates: [inBookSibling],
      mergeCandidatesPrior: [priorDex],
      onMerge,
      onLinkPrior,
    });
    fireEvent.click(screen.getByRole('button', { name: /Merge Dexter into another character/i }));
    fireEvent.change(screen.getByRole('combobox', { name: /Merge target/i }), { target: { value: 'sophie-foster' } });
    fireEvent.click(screen.getByRole('button', { name: /^Merge$/i }));
    await Promise.resolve();
    expect(onMerge).toHaveBeenCalledWith('dexter-alvin-diznee', 'sophie-foster');
    expect(onLinkPrior).not.toHaveBeenCalled();
  });

  it('hides the merge button entirely when both groups are empty', () => {
    renderDrawer(dexter, {
      mergeCandidates: [],
      mergeCandidatesPrior: [],
      onMerge: vi.fn(),
      onLinkPrior: vi.fn(),
    });
    expect(screen.queryByRole('button', { name: /Merge .* into another character/i })).toBeNull();
  });

  it('surfaces an error when onLinkPrior rejects', async () => {
    const onLinkPrior = vi.fn().mockRejectedValueOnce(new Error('Cross-series link refused.'));
    renderDrawer(dexter, {
      mergeCandidatesPrior: [priorDex],
      onLinkPrior,
    });
    fireEvent.click(screen.getByRole('button', { name: /Merge Dexter into another character/i }));
    fireEvent.change(screen.getByRole('combobox', { name: /Merge target/i }), { target: { value: 'prior:0' } });
    fireEvent.click(screen.getByRole('button', { name: /^Link$/i }));
    await Promise.resolve();
    await Promise.resolve();
    await waitFor(() => {
      expect(screen.getByText(/Cross-series link refused\./)).toBeTruthy();
    });
  });
});

describe('ProfileDrawer Play sample (auto-load path)', () => {
  const fitz: Character = {
    id: 'fitz', name: 'Fitz', role: 'Telepath', color: 'halloran',
    lines: 426, scenes: 12,
    evidence: [{ quote: 'Fitz provides the necessary pressure and support.', note: 'long' }],
  };

  it('routes Play through the auto-load helper, not raw api.getVoiceSample', async () => {
    vi.mocked(playSampleWithAutoLoad).mockClear();
    vi.mocked(playSampleWithAutoLoad).mockResolvedValueOnce({ analyzerEvicted: false });
    render(
      <Provider store={makeStore()}>
        <ProfileDrawer character={fitz} voice={undefined} onClose={() => {}} onSave={() => {}} onLock={() => {}}/>
      </Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Play 12s sample/i }));
    await waitFor(() => expect(playSampleWithAutoLoad).toHaveBeenCalledTimes(1));
    /* The voiceId for an unmatched character is namespaced char-<id> so
       cached sample files for the library voice can't collide with the
       in-progress character voice. */
    expect(vi.mocked(playSampleWithAutoLoad).mock.calls[0][0].args.voiceId).toBe('char-fitz');
  });

  it('surfaces the inline eviction banner when the helper reports the analyzer was unloaded', async () => {
    vi.mocked(playSampleWithAutoLoad).mockClear();
    vi.mocked(playSampleWithAutoLoad).mockImplementationOnce(async ({ onStatus }) => {
      /* Drive the same status sequence prepareSidecar would emit on a
         cold-start path: evict → load-tts → synth. */
      onStatus?.('evicting',    { analyzerEvicted: false });
      onStatus?.('loading-tts', { analyzerEvicted: true });
      onStatus?.('synthesizing',{ analyzerEvicted: true });
      return { analyzerEvicted: true };
    });
    render(
      <Provider store={makeStore()}>
        <ProfileDrawer character={fitz} voice={undefined} onClose={() => {}} onSave={() => {}} onLock={() => {}}/>
      </Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Play 12s sample/i }));
    expect(await screen.findByText(/Analyzer unloaded to free VRAM for TTS\./)).toBeTruthy();
  });

  it('renders the helper error in the drawer when prep or synth fails', async () => {
    vi.mocked(playSampleWithAutoLoad).mockClear();
    vi.mocked(playSampleWithAutoLoad).mockRejectedValueOnce(new Error('TTS sidecar process is not running. Launch the app via start-app.ps1.'));
    render(
      <Provider store={makeStore()}>
        <ProfileDrawer character={fitz} voice={undefined} onClose={() => {}} onSave={() => {}} onLock={() => {}}/>
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
        <ProfileDrawer character={fitz} voice={undefined} onClose={() => {}} onSave={() => {}} onLock={() => {}}/>
      </Provider>,
    );
    /* The unmatched character has no library Voice, so the swatch falls
       back to its default voice-named accessible label. We match by
       prefix because the label suffix depends on whether a voice is
       present. */
    fireEvent.click(screen.getByRole('button', { name: /^Play sample for/i }));
    await waitFor(() => expect(playSampleWithAutoLoad).toHaveBeenCalledTimes(1));
    expect(vi.mocked(playSampleWithAutoLoad).mock.calls[0][0].args.voiceId).toBe('char-fitz');
  });
});

describe('ProfileDrawer downgrade to background bucket', () => {
  /* Rescuer-shaped fixture mirroring the screenshot the user filed: a
     descriptor-named speaker the auto-fold missed (≥3 lines) that the user
     wants to manually downgrade. */
  const rescuer: Character = {
    id: 'rescuer', name: 'Rescuer', role: 'background', color: 'halloran',
    lines: 26, scenes: 2,
  };
  const unknownMale: Character = {
    id: 'unknown-male', name: 'Unknown male', role: 'background', color: 'narrator',
    lines: 129, scenes: 6,
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
    expect(screen.queryByRole('button', { name: /Merge Rescuer into another character/i })).toBeNull();
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
  const fitz: Character = {
    id: 'fitz', name: 'Fitz', role: 'protagonist', color: 'eliza',
    lines: 50, scenes: 5, gender: 'male', ageRange: 'teen',
  };

  const fitzVoice: Voice = {
    id: 'v_fitz', character: 'Fitz', bookTitle: 'Book One', bookId: 'b1',
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

  it('renders engine tabs (one per available engine) and shows the Coqui catalog by default', async () => {
    renderDrawer(fitz, { voice: fitzVoice, voices: [fitzVoice], baseVoices: baseCatalog });
    const picker = await screen.findByRole('combobox', { name: /Model voice override/i });
    /* Auto option labelled with the resolved voice so the user can
       compare what they'd be moving away from. */
    expect(picker).toHaveValue('auto');
    expect(within(picker).getByRole('option', { name: /Auto — currently Coqui · Aaron Dreschner/i })).toBeTruthy();
    /* Coqui tab is active by default (matches the project's engine);
       Gemini tab is also present. The tabs swap which engine's voices
       the select shows; the single combobox is enough to pin behaviour. */
    expect(screen.getByRole('tab', { name: /Coqui/i })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Gemini/i })).toBeTruthy();
  });

  it('persists an override via api.setVoiceOverride when the user picks a base voice', async () => {
    setVoiceOverride.mockClear();
    renderDrawer(fitz, { voice: fitzVoice, voices: [fitzVoice], baseVoices: baseCatalog });
    const picker = await screen.findByRole('combobox', { name: /Model voice override/i });
    fireEvent.change(picker, { target: { value: 'coqui|Asya Anara' } });
    await waitFor(() => {
      expect(setVoiceOverride).toHaveBeenCalledWith('v_fitz', { engine: 'coqui', name: 'Asya Anara' });
    });
  });

  it('clears the override when the user picks "Auto"', async () => {
    setVoiceOverride.mockClear();
    const overridden: Voice = { ...fitzVoice, overrideTtsVoices: { coqui: { name: 'Asya Anara' } } };
    renderDrawer(fitz, { voice: overridden, voices: [overridden], baseVoices: baseCatalog });
    const picker = await screen.findByRole('combobox', { name: /Model voice override/i });
    expect(picker).toHaveValue('coqui|Asya Anara');
    fireEvent.change(picker, { target: { value: 'auto' } });
    await waitFor(() => {
      expect(setVoiceOverride).toHaveBeenCalledWith('v_fitz', null);
    });
  });

  it('shows a filled-slot indicator on the engine tab when that engine has an override', async () => {
    /* The "dot" badge on a tab tells the user at a glance which engines
       have a manual assignment without having to click each tab. */
    const overridden: Voice = {
      ...fitzVoice,
      overrideTtsVoices: { gemini: { name: 'Charon' } },
    };
    renderDrawer(fitz, { voice: overridden, voices: [overridden], baseVoices: baseCatalog });
    const geminiTab = await screen.findByRole('tab', { name: /Gemini/i });
    /* Filled-slot dot is added inside the tab button when that engine
       has a non-empty slot. */
    expect(geminiTab.querySelector('.bg-magenta')).toBeTruthy();
  });

  it('switching tabs swaps which engine\'s catalog the select shows', async () => {
    renderDrawer(fitz, { voice: fitzVoice, voices: [fitzVoice], baseVoices: baseCatalog });
    /* Default tab (Coqui) — only Coqui voices listed (besides Auto). */
    const coquiPicker = await screen.findByRole('combobox', { name: /Model voice override.*coqui/i });
    expect(within(coquiPicker).queryByRole('option', { name: 'Charon' })).toBeNull();
    expect(within(coquiPicker).getByRole('option', { name: 'Asya Anara' })).toBeTruthy();
    /* Switch to Gemini tab — picker now lists Gemini's catalog. */
    fireEvent.click(screen.getByRole('tab', { name: /Gemini/i }));
    const geminiPicker = await screen.findByRole('combobox', { name: /Model voice override.*gemini/i });
    expect(within(geminiPicker).getByRole('option', { name: 'Charon' })).toBeTruthy();
    expect(within(geminiPicker).queryByRole('option', { name: 'Asya Anara' })).toBeNull();
  });
});
