/* fe-29 — offline Help / troubleshooting view (#/help, reached from the
   top-bar "?" and Account; deep-linked per failure code via ?code=).

   Three sections: a six-step getting-started walkthrough, the live (rebindable)
   keyboard shortcuts, and a troubleshooting section that renders the full
   fs-19 failure taxonomy (src/data/help-failures.ts — bundled statically, so
   everything here works with the server down) plus hand-written common
   questions (src/data/help-topics.ts). Zero network calls by design.

   A `focusCode` on the stage (e.g. the "Help" link on a failed chapter row)
   scrolls to + highlights that taxonomy entry; unknown codes are ignored. */

import { useEffect, useRef, useState } from 'react';
import { useAppSelector, useAppDispatch } from '../store';
import { SectionLabel, MixedHeading } from '../components/primitives';
import { stageToHash } from '../lib/router';
import { formatKeyLabel } from '../lib/keybindings';
import { HELP_FAILURE_ENTRIES } from '../data/help-failures';
import type { CategoryId } from '../data/help-failures';
import { HELP_TOPICS } from '../data/help-topics';
import { HELP_CATEGORIES } from '../data/help-categories';
import { startLinearTour } from '../store/tour-slice';
import { IconChevR, IconChevD, IconSearch } from '../lib/icons';
import { WikiLink } from '../components/wiki-link';
import { HELP_SECTION_WIKI, CATEGORY_WIKI } from '../lib/wiki-links';

/* Jump-nav targets. Plain in-page `href="#id"` anchors would fight the hash
   router (the fragment IS the route), so the links scroll programmatically. */
const SECTIONS = [
  { id: 'getting-started', label: 'Getting started' },
  { id: 'keyboard-shortcuts', label: 'Keyboard shortcuts' },
  { id: 'troubleshooting', label: 'Troubleshooting' },
] as const;

/* The six-step walkthrough — upload → analysis → confirm → design →
   generate → listen, in the house voice. */
const GETTING_STARTED: Array<{ title: string; body: string }> = [
  {
    title: 'Add a book',
    body:
      'Click "New book" in the library and drop in a manuscript — plain text, EPUB or PDF. ' +
      'Castwright finds the chapters on its own; if a boundary lands wrong, untick front matter ' +
      'on the next screen, and merge or split chapters later from the book\'s Chapters view. ' +
      'For a first run with nothing at stake, open the bundled demo book — a ' +
      'short original story with its cast already designed.',
  },
  {
    title: 'Let it read',
    body:
      'The analyzer reads every chapter, finds the characters, and works out who speaks each ' +
      'line. It runs on your own machine (with a free cloud fallback) and takes a few minutes — ' +
      'sometimes longer for a big book on a local model — feel free to wander off; it keeps going without you.',
  },
  {
    title: 'Meet the cast',
    body:
      'Before anything renders, you meet the cast Castwright found. Merge any duplicates, and ' +
      'link characters you already know from earlier books in the series — a linked character ' +
      'keeps the voice they had in book one.',
  },
  {
    title: 'Give everyone a voice',
    body:
      'Every character gets their own voice: pick one from the catalogue, or describe the voice ' +
      'you hear in your head and let Castwright design it. "Design full cast" does the whole ' +
      'roster in one pass.',
  },
  {
    title: 'Generate',
    body:
      'Generate renders every chapter with your cast — every line in the right voice. A chapter ' +
      'that fails tells you why and offers a retry; the failure names under Troubleshooting ' +
      'below explain what each reason means.',
  },
  {
    title: 'Listen & take it anywhere',
    body:
      'Play chapters right here, or export the finished audiobook from the Listen view and drop ' +
      'it into any player you already use. Nothing locks you in.',
  },
];

type HelpItem =
  | { kind: 'failure'; id: string; title: string; category: CategoryId; search: string; entry: (typeof HELP_FAILURE_ENTRIES)[number] }
  | { kind: 'topic'; id: string; title: string; category: CategoryId; search: string; topic: (typeof HELP_TOPICS)[number] };

const HELP_ITEMS: HelpItem[] = [
  ...HELP_FAILURE_ENTRIES.map((entry) => ({
    kind: 'failure' as const,
    id: entry.code,
    title: entry.title,
    category: entry.category,
    search: `${entry.title} ${entry.userMessage} ${entry.remediation} ${entry.helpDetail ?? ''}`.toLowerCase(),
    entry,
  })),
  ...HELP_TOPICS.map((topic) => ({
    kind: 'topic' as const,
    id: topic.id,
    title: topic.title,
    category: topic.category,
    search: `${topic.title} ${topic.body}`.toLowerCase(),
    topic,
  })),
];

function itemsFor(category: CategoryId): HelpItem[] {
  return HELP_ITEMS.filter((i) => i.category === category);
}

function HelpItemCard({
  item,
  focusCode,
  focusedRef,
}: {
  item: HelpItem;
  focusCode?: string;
  focusedRef: React.RefObject<HTMLDivElement | null>;
}) {
  const focused = item.id === focusCode;
  const cardCls = `rounded-xl border p-4 sm:p-5 scroll-mt-24 ${
    focused ? 'border-magenta ring-2 ring-magenta/40 bg-magenta/5' : 'border-ink/10 bg-white'
  }`;
  if (item.kind === 'failure') {
    const e = item.entry;
    return (
      <div id={e.code} data-focused={focused ? 'true' : undefined} ref={focused ? focusedRef : undefined} className={cardCls}>
        <h4 className="font-semibold text-ink">{e.title}</h4>
        <p className="mt-2 text-sm text-ink/70">
          <span className="font-semibold text-ink/80">What you saw: </span>
          {e.userMessage}
        </p>
        <p className="mt-1.5 text-sm text-ink/70">
          <span className="font-semibold text-ink/80">What to do: </span>
          {e.remediation}
        </p>
        {e.helpDetail && <p className="mt-1.5 text-sm text-ink/50">{e.helpDetail}</p>}
      </div>
    );
  }
  const t = item.topic;
  return (
    <div id={t.id} data-focused={focused ? 'true' : undefined} ref={focused ? focusedRef : undefined} className={cardCls}>
      <h4 className="font-semibold text-ink">{t.title}</h4>
      <p className="mt-2 text-sm text-ink/70">{t.body}</p>
    </div>
  );
}

const H2_CLASSES = 'text-2xl md:text-3xl font-medium leading-[1.1] tracking-tight text-ink';

function JumpLink({
  id,
  label,
  className = '',
}: {
  id: string;
  label: string;
  className?: string;
}) {
  return (
    <a
      href={stageToHash({ kind: 'help' })}
      onClick={(e) => {
        e.preventDefault();
        const el = document.getElementById(id);
        const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        el?.scrollIntoView?.({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
        el?.focus?.({ preventScroll: true });
      }}
      className={`inline-flex items-center min-h-[44px] fine-pointer:min-h-0 text-sm font-medium text-ink/70 hover:text-magenta transition-colors ${className}`}
    >
      {label}
    </a>
  );
}

export function HelpView() {
  const dispatch = useAppDispatch();
  const stage = useAppSelector((s) => s.ui.stage);
  const focusCode = stage.kind === 'help' ? stage.focusCode : undefined;
  /* Rebindable shortcuts — read defensively (mirrors mini-player.tsx) so a
     minimal test store that omits the settings slice still renders. */
  const playPauseKey = useAppSelector((s) => s.settings?.keybindings?.['play-pause'] ?? 'Space');
  const skipBackKey = useAppSelector((s) => s.settings?.keybindings?.['skip-back'] ?? 'J');
  const skipForwardKey = useAppSelector((s) => s.settings?.keybindings?.['skip-forward'] ?? 'L');
  const shortcuts = [
    { label: 'Play / pause', key: playPauseKey },
    { label: 'Skip back', key: skipBackKey },
    { label: 'Skip forward', key: skipForwardKey },
  ];

  const focusedRef = useRef<HTMLDivElement | null>(null);
  const scrolledForRef = useRef<string | undefined>(undefined);
  const focusedEntryExists = HELP_FAILURE_ENTRIES.some((e) => e.code === focusCode);

  const focusedCategory = HELP_FAILURE_ENTRIES.find((e) => e.code === focusCode)?.category;
  const [expanded, setExpanded] = useState<Set<CategoryId>>(() => {
    const s = new Set<CategoryId>(['setup']);
    if (focusedCategory) s.add(focusedCategory);
    return s;
  });
  const toggle = (id: CategoryId) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  /* focusCode can hydrate AFTER mount (HelpRoute populates it via a useEffect
     that fires post-first-render) — the useState initializer above only runs
     once, so a late-arriving focusedCategory needs to fold into `expanded`
     here or its group never opens. */
  useEffect(() => {
    if (focusedCategory) {
      setExpanded((prev) => (prev.has(focusedCategory) ? prev : new Set(prev).add(focusedCategory)));
    }
  }, [focusedCategory]);

  useEffect(() => {
    /* Optional-chained: jsdom has no scrollIntoView. `expanded` is a dep so
       this re-runs once the focused card actually mounts (its group may have
       just expanded above, on the same tick focusCode hydrated) — but the
       scrolledForRef guard limits the actual scroll to once per focusCode,
       so expanding/collapsing OTHER groups later doesn't yank the viewport
       back to the focused card. */
    if (!focusedEntryExists) return;
    if (scrolledForRef.current === focusCode) return;
    if (focusedRef.current) {
      focusedRef.current.scrollIntoView?.({ block: 'start' });
      scrolledForRef.current = focusCode;
    }
  }, [focusedEntryExists, focusCode, expanded]);

  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const matches = (item: HelpItem) => q === '' || item.search.includes(q);
  const totalMatches = q === '' ? HELP_ITEMS.length : HELP_ITEMS.filter(matches).length;

  return (
    <div className="max-w-[960px] mx-auto px-4 sm:px-6 py-10">
      <div className="mb-8">
        <SectionLabel>Help</SectionLabel>
        <div className="mt-4">
          <MixedHeading regular="Help &" bold="answers" level="h1" />
        </div>
        <p className="mt-4 text-ink/60 max-w-prose">
          Everything on this page works offline — how a book becomes a performance, the keys that
          drive playback, and what to do on the rare night something goes wrong.
        </p>
      </div>

      {/* Inline jump-nav (phone / tablet) */}
      <nav aria-label="Help sections" className="lg:hidden mb-8 flex flex-wrap gap-x-6 gap-y-1">
        {SECTIONS.map((s) => (
          <JumpLink key={s.id} id={s.id} label={s.label} />
        ))}
      </nav>

      <div className="lg:grid lg:grid-cols-[200px_minmax(0,1fr)] lg:gap-12 lg:items-start">
        {/* Sticky jump-nav (desktop) */}
        <nav aria-label="Help sections" className="hidden lg:block sticky top-24">
          <ul className="space-y-1">
            {SECTIONS.map((s) => (
              <li key={s.id}>
                <JumpLink id={s.id} label={s.label} />
              </li>
            ))}
          </ul>
        </nav>

        <div className="space-y-14">
          {/* ── 1 · Getting started ─────────────────────────────────── */}
          <section
            id="getting-started"
            aria-labelledby="getting-started-heading"
            className="scroll-mt-24"
            tabIndex={-1}
          >
            <div id="getting-started-heading">
              <MixedHeading regular="Getting" bold="started" level="h2" />
            </div>
            <p className="mt-3 text-ink/60 max-w-prose">
              From manuscript to a full-cast performance in six steps.
            </p>
            <WikiLink page={HELP_SECTION_WIKI.gettingStarted} className="mt-4" />
            <button
              type="button"
              onClick={() => dispatch(startLinearTour())}
              className="mt-4 inline-flex items-center gap-2 rounded-lg bg-ink text-canvas px-4 py-2 text-sm font-semibold min-h-[44px] fine-pointer:min-h-0"
            >
              Take the tour
            </button>
            <ol className="mt-6 space-y-6">
              {GETTING_STARTED.map((step, i) => (
                <li key={step.title} className="flex gap-4">
                  <span
                    aria-hidden="true"
                    className="shrink-0 w-8 h-8 grid place-items-center rounded-full bg-peach/20 text-magenta font-serif font-semibold"
                  >
                    {i + 1}
                  </span>
                  <div>
                    <h3 className="font-semibold text-ink">{step.title}</h3>
                    <p className="mt-1 text-sm text-ink/70 max-w-prose">{step.body}</p>
                  </div>
                </li>
              ))}
            </ol>
          </section>

          {/* ── 2 · Keyboard shortcuts ──────────────────────────────── */}
          <section
            id="keyboard-shortcuts"
            aria-labelledby="keyboard-shortcuts-heading"
            className="scroll-mt-24"
            tabIndex={-1}
          >
            <div id="keyboard-shortcuts-heading">
              <MixedHeading regular="Keyboard" bold="shortcuts" level="h2" />
            </div>
            <p className="mt-3 text-ink/60 max-w-prose">
              Playback answers to the keyboard from anywhere in the app. These are yours to rebind —
              change them in{' '}
              <a
                href={stageToHash({ kind: 'account' })}
                className="text-magenta font-medium hover:underline"
              >
                Account
              </a>
              .
            </p>
            <WikiLink page={HELP_SECTION_WIKI.keyboard} className="mt-4" />
            <dl className="mt-6 max-w-md divide-y divide-ink/10 rounded-xl border border-ink/10 bg-white">
              {shortcuts.map((s) => (
                <div
                  key={s.label}
                  className="flex items-center justify-between gap-4 px-4 py-3 min-h-[44px] fine-pointer:min-h-0"
                >
                  <dt className="text-sm text-ink/80">{s.label}</dt>
                  <dd>
                    <kbd className="inline-flex items-center justify-center min-w-[2.25rem] px-2 py-1 rounded-md border border-ink/15 border-b-2 bg-canvas text-xs font-semibold text-ink">
                      {formatKeyLabel(s.key)}
                    </kbd>
                  </dd>
                </div>
              ))}
            </dl>
          </section>

          {/* ── 3 · Troubleshooting ─────────────────────────────────── */}
          <section
            id="troubleshooting"
            aria-labelledby="troubleshooting-heading"
            className="scroll-mt-24"
            tabIndex={-1}
          >
            {/* "Troubleshooting" is one word, so the brand bold-span sits
                inside it — MixedHeading would insert a space. */}
            <h2 id="troubleshooting-heading" className={H2_CLASSES}>
              Trouble<span className="font-bold">shooting</span>
            </h2>
            <p className="mt-3 text-ink/60 max-w-prose">
              When a render goes wrong, Castwright names the failure instead of shrugging. Every
              failure it can name is listed here — what you saw, and what to do about it.
            </p>
            <WikiLink page={HELP_SECTION_WIKI.troubleshooting} className="mt-4" />

            <div className="mt-6 relative max-w-md">
              <IconSearch className="w-4 h-4 text-ink/40 absolute left-3 top-1/2 -translate-y-1/2" aria-hidden="true" />
              <input
                type="search"
                aria-label="Search troubleshooting"
                placeholder="Search troubleshooting…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="w-full min-h-[44px] fine-pointer:min-h-0 rounded-xl border border-ink/15 bg-white pl-9 pr-3 py-2 text-sm text-ink placeholder:text-ink/40"
              />
              {q !== '' && (
                <span className="mt-2 block text-xs text-ink/50">{totalMatches} of {HELP_ITEMS.length}</span>
              )}
            </div>

            <div className="mt-6 space-y-3">
              {HELP_CATEGORIES.map((cat) => {
                const all = itemsFor(cat.id);
                const items = q === '' ? all : all.filter(matches);
                if (q !== '' && items.length === 0) return null; // hide non-matching groups while searching
                const open = q !== '' ? true : expanded.has(cat.id);
                const count = q === '' ? all.length : items.length;
                return (
                  <div key={cat.id} className="rounded-xl border border-ink/10 bg-white">
                    <button
                      type="button"
                      aria-expanded={open}
                      aria-controls={open ? `cat-panel-${cat.id}` : undefined}
                      onClick={() => toggle(cat.id)}
                      disabled={q !== ''}
                      className="w-full flex items-center justify-between gap-3 px-4 sm:px-5 py-3 min-h-[44px] fine-pointer:min-h-0 text-left disabled:cursor-default"
                    >
                      <span className="font-semibold text-ink">
                        {cat.label} <span className="font-normal text-ink/40">({count})</span>
                      </span>
                      {open ? (
                        <IconChevD className="w-4 h-4 text-ink/50 shrink-0" aria-hidden="true" />
                      ) : (
                        <IconChevR className="w-4 h-4 text-ink/50 shrink-0" aria-hidden="true" />
                      )}
                    </button>
                    {open && (
                      <div
                        id={`cat-panel-${cat.id}`}
                        className="px-4 sm:px-5 pb-4 space-y-3 border-t border-ink/5 pt-3"
                      >
                        {items.map((item) => (
                          <HelpItemCard key={item.id} item={item} focusCode={focusCode} focusedRef={focusedRef} />
                        ))}
                        <div className="pt-1">
                          <WikiLink page={CATEGORY_WIKI[cat.id]} label="More on this in the wiki" className="text-xs" />
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
