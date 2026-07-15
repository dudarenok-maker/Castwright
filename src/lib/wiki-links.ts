/* Curated, page-level links out to the published GitHub wiki (Help + Admin).
   Page-level only — no #anchor fragments (GitHub wiki slug generation is not
   README-markdown slugging and is fragile to replicate). The guard test asserts
   each referenced page file exists under docs/wiki/. */

import type { CategoryId } from '../data/help-failures';
import type { StepId } from '../components/setup/steps';

/* NOTE: hardcodes the repo owner. If the repo transfers to an org, update this. */
export const WIKI_BASE = 'https://github.com/dudarenok-maker/Castwright/wiki';

export type WikiPage =
  | 'Getting-Started'
  | 'Installing-Castwright'
  | 'Account-and-Settings'
  | 'Troubleshooting'
  | 'Voice-Engines'
  | 'Analysis-and-the-Analyzer'
  | 'Getting-a-Gemini-API-Key'
  | 'Multi-language-Support'
  | 'Generating-Audio'
  | 'Reviewing-Cast-and-Assigning-Voices'
  | 'Advanced-Settings'
  | 'Exporting'
  | 'Model-Manager'
  | 'Mobile-Tablet-and-Companion-App'
  | 'LAN-HTTPS-Troubleshooting'
  | 'Admin';

export function wikiUrl(page: WikiPage): string {
  return `${WIKI_BASE}/${page}`;
}

/* Analyzer setup "Get a Gemini API key" link (fe-50). The app links to this
   wiki page — NOT straight to Google — so the fragile aistudio.google.com URL
   lives ONLY in the wiki markdown. When Google reshuffles it (they do), it's a
   one-line wiki edit, not an app release. */
export const GEMINI_KEY_WIKI: WikiPage = 'Getting-a-Gemini-API-Key';

/* Best-fit wiki page per Troubleshooting category. Page-level, so retuning is a
   one-line edit. Keyed by CategoryId (src/data/help-failures.ts). */
export const CATEGORY_WIKI = {
  setup: 'Getting-Started',
  engines: 'Voice-Engines',
  analysis: 'Analysis-and-the-Analyzer',
  voices: 'Multi-language-Support',
  quality: 'Generating-Audio',
  cast: 'Reviewing-Cast-and-Assigning-Voices',
  performance: 'Advanced-Settings',
  files: 'Exporting',
  other: 'Troubleshooting',
} satisfies Record<CategoryId, WikiPage>;

export const ADMIN_WIKI = {
  modelManager: 'Model-Manager',
  advanced: 'Advanced-Settings',
  lanAccess: 'Mobile-Tablet-and-Companion-App',
  lanTroubleshooting: 'LAN-HTTPS-Troubleshooting',
  admin: 'Admin',
} satisfies Record<string, WikiPage>;

export const HELP_SECTION_WIKI = {
  gettingStarted: 'Getting-Started',
  keyboard: 'Account-and-Settings',
  troubleshooting: 'Troubleshooting',
} satisfies Record<string, WikiPage>;

/* GitHub support surfaces (fe-52). Repo owner hardcoded like WIKI_BASE — update
   on transfer. Issues + Discussions are both enabled on the repo. */
export const REPO_BASE = 'https://github.com/dudarenok-maker/Castwright';
export const SUPPORT_LINKS = {
  issues: `${REPO_BASE}/issues`, // "Report a problem"
  discussions: `${REPO_BASE}/discussions`, // "Ask a question"
} as const;

/* Per-step contextual "Learn more" deep-link for the first-run setup wizard
   (fe-53). Keyed by StepId so it stays exhaustive at compile time. Page-level;
   two install-flavoured steps share Installing-Castwright by design (its
   Prerequisites section leads with OS/GPU/accelerator + ffmpeg). */
export const WIZARD_STEP_WIKI = {
  environment: 'Installing-Castwright',
  ffmpeg: 'Installing-Castwright',
  analysis: 'Analysis-and-the-Analyzer',
  voice: 'Voice-Engines',
  defaults: 'Account-and-Settings',
  lanCert: 'Mobile-Tablet-and-Companion-App',
  finish: 'Generating-Audio',
} satisfies Record<StepId, WikiPage>;

/* Wiki pages shown in the fe-52 footer — single source of truth for the footer's
   wiki links AND the per-step suppression rule below. */
export const HELP_FOOTER_WIKI: readonly WikiPage[] = [
  'Getting-Started',
  'Installing-Castwright',
  'Troubleshooting',
];

/* A step's contextual "Learn more" page, or null when that page is already a
   footer link (the wizard then hides the duplicate contextual link for that
   step). Derived from HELP_FOOTER_WIKI, so it stays correct if links change. */
export function stepLearnMorePage(step: StepId): WikiPage | null {
  const page = WIZARD_STEP_WIKI[step];
  return HELP_FOOTER_WIKI.includes(page) ? null : page;
}
