/* fe-29 — offline Help / troubleshooting view (#/help, reached from the
   top-bar "?" and Account; deep-linked per failure code via ?code=).

   Three sections: a six-step getting-started walkthrough, the live (rebindable)
   keyboard shortcuts, and a troubleshooting section that renders the full
   fs-19 failure taxonomy (src/data/help-failures.ts — bundled statically, so
   everything here works with the server down) plus hand-written common
   questions (src/data/help-topics.ts). Zero network calls by design.

   A `focusCode` on the stage (e.g. the "Help" link on a failed chapter row)
   scrolls to + highlights that taxonomy entry; unknown codes are ignored. */

import { useEffect, useRef } from 'react';
import { useAppSelector } from '../store';
import { SectionLabel, MixedHeading } from '../components/primitives';
import { stageToHash } from '../lib/router';
import { formatKeyLabel } from '../lib/keybindings';
import { HELP_FAILURE_ENTRIES } from '../data/help-failures';
import { HELP_TOPICS } from '../data/help-topics';

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
      'Castwright finds the chapters on its own; if a boundary lands wrong, you can nudge it on ' +
      'the next screen. For a first run with nothing at stake, open the bundled demo book — a ' +
      'short original story with its cast already designed.',
  },
  {
    title: 'Let it read',
    body:
      'The analyzer reads every chapter, finds the characters, and works out who speaks each ' +
      'line. It runs on your own machine (with a free cloud fallback) and takes a few minutes ' +
      'per book — feel free to wander off; it keeps going without you.',
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
        document.getElementById(id)?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
      }}
      className={`inline-flex items-center min-h-[44px] sm:min-h-0 text-sm font-medium text-ink/70 hover:text-magenta transition-colors ${className}`}
    >
      {label}
    </a>
  );
}

export function HelpView() {
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
  const focusedEntryExists = HELP_FAILURE_ENTRIES.some((e) => e.code === focusCode);
  useEffect(() => {
    /* Optional-chained: jsdom has no scrollIntoView. */
    if (focusedEntryExists) focusedRef.current?.scrollIntoView?.({ block: 'start' });
  }, [focusedEntryExists, focusCode]);

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
          >
            <div id="getting-started-heading">
              <MixedHeading regular="Getting" bold="started" level="h2" />
            </div>
            <p className="mt-3 text-ink/60 max-w-prose">
              From manuscript to a full-cast performance in six steps.
            </p>
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
            <dl className="mt-6 max-w-md divide-y divide-ink/10 rounded-xl border border-ink/10 bg-white">
              {shortcuts.map((s) => (
                <div
                  key={s.label}
                  className="flex items-center justify-between gap-4 px-4 py-3 min-h-[44px] sm:min-h-0"
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

            <h3 className="mt-8 text-lg font-semibold text-ink">Failures the app can name</h3>
            <div className="mt-4 space-y-3">
              {HELP_FAILURE_ENTRIES.map((e) => {
                const focused = e.code === focusCode;
                return (
                  <div
                    key={e.code}
                    id={e.code}
                    data-focused={focused ? 'true' : undefined}
                    ref={focused ? focusedRef : undefined}
                    className={`rounded-xl border p-4 sm:p-5 scroll-mt-24 ${
                      focused
                        ? 'border-magenta ring-2 ring-magenta/40 bg-magenta/5'
                        : 'border-ink/10 bg-white'
                    }`}
                  >
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
              })}
            </div>

            <h3 className="mt-10 text-lg font-semibold text-ink">Common questions</h3>
            <div className="mt-4 space-y-3">
              {HELP_TOPICS.map((t) => (
                <div
                  key={t.id}
                  id={t.id}
                  className="rounded-xl border border-ink/10 bg-white p-4 sm:p-5 scroll-mt-24"
                >
                  <h4 className="font-semibold text-ink">{t.title}</h4>
                  <p className="mt-2 text-sm text-ink/70">{t.body}</p>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
