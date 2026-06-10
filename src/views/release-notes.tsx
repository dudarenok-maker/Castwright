/* #/release-notes — the in-app, multi-version brand-voice release history
   (fe-37). Renders the bundled RELEASE_NOTES.md (served verbatim via
   GET /api/info → useAppInfo) as a newest-first history, so a tester jumping
   several versions sees everything in between. Reached from /about and from
   Account → Application updates. */

import { SectionLabel, MixedHeading } from '../components/primitives';
import { useAppInfo } from '../lib/use-app-info';
import { parseReleaseNotes } from '../lib/release-notes';
import { buildInfo } from '../lib/build-info';

/* A bullet may carry a leading **bold** lead-in (the headline). Render the
   bold runs without pulling in a markdown dependency — split on ** pairs, odd
   segments are bold. */
function Bullet({ text }: { text: string }) {
  const parts = text.split('**');
  return (
    <li className="text-ink/75 leading-relaxed">
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <strong key={i} className="text-ink font-semibold">
            {p}
          </strong>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </li>
  );
}

export function ReleaseNotesView() {
  const { info, error } = useAppInfo();
  const notes = parseReleaseNotes(info?.releaseNotes ?? '');
  const runningVersion = info?.appVersion ?? buildInfo.version;

  return (
    <div className="max-w-[760px] mx-auto px-4 sm:px-6 py-10">
      <div className="mb-8">
        <SectionLabel>What&rsquo;s new</SectionLabel>
        <div className="mt-4">
          <MixedHeading regular="Release" bold="notes" level="h1" />
        </div>
      </div>

      {error && info == null && (
        <p className="text-ink/60">Couldn&rsquo;t load the release notes right now.</p>
      )}
      {!error && info != null && notes.length === 0 && (
        <p className="text-ink/60">No release notes yet.</p>
      )}

      <div className="space-y-8">
        {notes.map((n) => {
          const isCurrent = n.version != null && n.version === runningVersion;
          return (
            <section
              key={n.heading}
              className="rounded-2xl border border-ink/10 bg-white p-6 shadow-card"
            >
              <div className="flex flex-wrap items-center gap-3">
                <h2 className="font-serif text-2xl font-bold text-ink">{n.heading}</h2>
                {isCurrent && (
                  <span className="inline-flex items-center rounded-full bg-magenta/10 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-magenta">
                    You&rsquo;re on this version
                  </span>
                )}
              </div>
              <ul className="mt-4 space-y-2 list-disc pl-5">
                {n.bullets.map((b, i) => (
                  <Bullet key={i} text={b} />
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}
