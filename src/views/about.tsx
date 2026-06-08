/* Wave 3 — /about brand page.
   Reached from the Admin view (#/about). Mirrors the Model Manager layout
   (same container / heading pattern). */

import { SectionLabel, MixedHeading } from '../components/primitives';
import { CastwaveMark } from '../lib/icons';
import { buildInfo } from '../lib/build-info';

export function AboutView() {
  return (
    <div className="max-w-[960px] mx-auto px-4 sm:px-6 py-10">
      <div className="mb-8">
        <SectionLabel>About</SectionLabel>
        <div className="mt-4">
          <MixedHeading regular="About" bold="Castwright" level="h1" />
        </div>
      </div>

      <div className="space-y-6">
        <CastwaveMark className="w-16 h-16 text-magenta" aria-hidden="true" />

        <p className="font-serif text-xl text-ink">
          Any book, performed by a full cast — effortlessly. Even in your own voice.
        </p>

        <p className="text-ink/60">Many voices, one machine.</p>

        <p className="text-ink/70 max-w-prose">
          Castwright turns a book into a full-cast performance — and keeps each voice true from book
          one to the last. Even in your own voice.
        </p>

        <a
          href="https://castwright.ai"
          target="_blank"
          rel="noreferrer"
          className="inline-block text-magenta font-medium hover:underline"
        >
          castwright.ai
        </a>

        <p className="text-xs text-ink/50">
          Castwright v{buildInfo.version} ({buildInfo.sha})
        </p>
      </div>
    </div>
  );
}
