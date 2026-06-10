/* /about — the brand page (reached from Admin, #/about).
   Rebuilt for fe-37: the only in-product explanation of the product. Seven
   blocks (brand guidelines §2/§3): identity · what it is · coming next (teaser,
   flagged) · engine credits · licence · what's new · alpha ask.
   All brand copy comes from src/lib/brand.ts so a tagline change is one diff. */

import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { SectionLabel, MixedHeading } from '../components/primitives';
import { CastwaveMark } from '../lib/icons';
import { buildInfo } from '../lib/build-info';
import { TAGLINE, MANIFESTO, TEASER, TEASER_FLAG, HARDWARE_LINE, DOMAIN } from '../lib/brand';
import { DevicePanel } from '../components/device-panel';

/* Engine credits — kin, not competition (guidelines §3): credit Kokoro, XTTS
   and Qwen visibly, by name, linked. */
const ENGINES: Array<{ name: string; href: string }> = [
  { name: 'Kokoro', href: 'https://huggingface.co/hexgrad/Kokoro-82M' },
  { name: 'Coqui XTTS', href: 'https://github.com/coqui-ai/TTS' },
  { name: 'Qwen3-TTS', href: 'https://github.com/QwenLM' },
];

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-magenta font-medium hover:underline"
    >
      {children}
    </a>
  );
}

export function AboutView() {
  return (
    <div className="max-w-[960px] mx-auto px-4 sm:px-6 py-10">
      <div className="mb-8">
        <SectionLabel>About</SectionLabel>
        <div className="mt-4">
          <MixedHeading regular="About" bold="Castwright" level="h1" />
        </div>
      </div>

      <div className="space-y-10">
        {/* 1 — Identity */}
        <section className="space-y-4">
          <CastwaveMark className="w-16 h-16 text-magenta" aria-hidden="true" />
          <p className="font-serif text-xl text-ink max-w-prose">{TAGLINE}</p>
          <p className="text-ink/60">{MANIFESTO}</p>
        </section>

        {/* 2 — What it is */}
        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink/50">
            What it is
          </h2>
          <p className="text-ink/70 max-w-prose">
            Castwright turns any book into a full-cast performance — every character its own
            voice, kept true from book one to the last. One narrator can&rsquo;t be everyone: the
            apprentice sounds thirteen; the swordsmith sounds seventy and a forge.
          </p>
          <p className="text-ink/70 max-w-prose">
            It renders at home, on a machine you may already own. {HARDWARE_LINE} Your book never
            leaves the house — no meter, no monthly fee, no server that can take your library away.
          </p>
        </section>

        {/* 3 — Coming next (teaser — MUST carry the in-development flag) */}
        <section className="space-y-3">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-ink/50">
              Coming next
            </h2>
            <span className="inline-flex items-center rounded-full bg-magenta/10 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-magenta">
              {TEASER_FLAG}
            </span>
          </div>
          <p className="font-serif text-lg text-ink max-w-prose">{TEASER}</p>
          <p className="text-ink/70 max-w-prose">
            Read a bedtime story in your own voice — or let your kid be the hero. Your voices, with
            your permission, stay on your machine.
          </p>
        </section>

        {/* 4 — Engine credits */}
        <section className="space-y-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink/50">Voices</h2>
          <p className="text-ink/70 max-w-prose">
            Voices by{' '}
            {ENGINES.map((e, i) => (
              <span key={e.name}>
                <ExternalLink href={e.href}>{e.name}</ExternalLink>
                {i < ENGINES.length - 2 ? ', ' : i === ENGINES.length - 2 ? ' and ' : '.'}
              </span>
            ))}{' '}
            Open source is kin, not competition.
          </p>
        </section>

        {/* 5 — Licence */}
        <section className="space-y-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink/50">Licence</h2>
          <p className="text-ink/70 max-w-prose">
            Source-available under the Functional Source License (
            <ExternalLink href="https://fsl.software/">FSL-1.1-Apache-2.0</ExternalLink>) — it
            becomes Apache-2.0 two years after each release. See the bundled LICENSE and NOTICE for
            the engines&rsquo; own terms.
          </p>
        </section>

        {/* 6 — What's new */}
        <section className="space-y-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink/50">
            What&rsquo;s new
          </h2>
          <p className="text-sm text-ink/60">
            Castwright v{buildInfo.version} ({buildInfo.sha}) ·{' '}
            <Link to="/release-notes" className="text-magenta font-medium hover:underline">
              What&rsquo;s new
            </Link>
          </p>
        </section>

        {/* 7 — Alpha ask */}
        <section className="space-y-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink/50">
            Help shape it
          </h2>
          <p className="text-ink/70 max-w-prose">
            Castwright is in alpha. We&rsquo;d love more testers — especially on Apple Silicon Macs
            and non-NVIDIA GPUs, where we have the fewest miles. Tell us how it runs on your machine
            at <ExternalLink href={`https://${DOMAIN}`}>{DOMAIN}</ExternalLink>.
          </p>
        </section>

        {/* 8 — side-14: device ground-truth panel */}
        <DevicePanel />
      </div>
    </div>
  );
}
