/* Single source of brand copy (fe-37 / plan 202).

   The brand strings used to be duplicated across views, modals, index.html and
   the PWA manifest — a tagline change meant a multi-file hunt, and the 2026-06-10
   v2 change missed three static sites entirely (index.html meta, manifest, the
   build stamp). React surfaces import from here; the static files (index.html,
   public/manifest.webmanifest) can't import a TS module, so they carry the same
   strings, pinned by the guard test in brand.test.ts.

   Brand decisions of record: brand/BRAND_CHANGELOG.md (2026-06-10, v2). */

/** Primary tagline — leads every surface. Fixed wording (changelog decision 1).
    The retired line ("…effortlessly. Even in your own voice.") must appear
    nowhere; "effortlessly" is a banned word (decision 3). */
export const TAGLINE =
  'Any book, performed by a full cast — kept true, kept yours, book after book.';

/** Short form for tight spaces (empty states, upload header). */
export const TAGLINE_SHORT = 'Any book, fully cast.';

/** The manifesto line. */
export const MANIFESTO = 'Many voices, one machine.';

/** Teaser line for the in-development voice-cloning feature (fs-38). Per the
    teaser rule (decision 2) it may render ONLY alongside its in-development flag
    until fs-38 ships, when it graduates to the unflagged launch line. */
export const TEASER = 'Even in your own voice.';
export const TEASER_FLAG = 'In development';

/** Product domain — lives in footers / URLs only, never inside a lockup
    (decision 7). */
export const DOMAIN = 'castwright.ai';

/** The footer/export attribution stamp prefix. */
export const MADE_WITH = 'Made with Castwright';

/** Hardware-honesty line (decision 9) — widened for Apple Silicon. */
export const HARDWARE_LINE =
  'A gaming PC or laptop with an 8 GB GPU — or any Apple Silicon Mac — is enough.';
