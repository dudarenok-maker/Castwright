/* Parse the bundled RELEASE_NOTES.md (served verbatim via GET /api/info as
   `releaseNotes`) into per-version sections. fe-37 made the notes a multi-version,
   newest-first brand-voice history; the #/release-notes view renders the whole
   history, while the What's-new banner renders only the latest section.

   Format (one section per release, newest first):

     # Castwright 1.7.0
     - **Headline.** Body sentence.
     - ...

     # Castwright 1.6.0
     - ... */

export interface ReleaseNote {
  /** The heading text, e.g. "Castwright 1.7.0" or "Castwright 1.5.0 — the first full Castwright". */
  heading: string;
  /** The semver pulled from the heading (e.g. "1.7.0"), or null if none. */
  version: string | null;
  /** Bullet lines, leading "- " stripped; **bold** markers preserved. */
  bullets: string[];
}

const VERSION_RE = /(\d+\.\d+\.\d+)/;

export function parseReleaseNotes(md: string): ReleaseNote[] {
  const notes: ReleaseNote[] = [];
  let current: ReleaseNote | null = null;
  for (const raw of (md ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    const heading = /^#{1,2}\s+(.*)$/.exec(line);
    if (heading) {
      const text = heading[1].trim();
      current = { heading: text, version: VERSION_RE.exec(text)?.[1] ?? null, bullets: [] };
      notes.push(current);
      continue;
    }
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet && current) current.bullets.push(bullet[1].trim());
  }
  return notes;
}

/** The newest section (first in the file), or null if the notes are empty. */
export function latestReleaseNote(md: string): ReleaseNote | null {
  return parseReleaseNotes(md)[0] ?? null;
}
