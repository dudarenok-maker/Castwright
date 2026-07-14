/* Curated, page-level links out to the published GitHub wiki (Help + Admin).
   Page-level only — no #anchor fragments (GitHub wiki slug generation is not
   README-markdown slugging and is fragile to replicate). The guard test asserts
   each referenced page file exists under docs/wiki/. */

/* NOTE: hardcodes the repo owner. If the repo transfers to an org, update this. */
export const WIKI_BASE = 'https://github.com/dudarenok-maker/Castwright/wiki';

export type WikiPage =
  | 'Getting-Started'
  | 'Account-and-Settings'
  | 'Troubleshooting'
  | 'Voice-Engines'
  | 'Analysis-and-the-Analyzer'
  | 'Multi-language-Support'
  | 'Generating-Audio'
  | 'Reviewing-Cast-and-Assigning-Voices'
  | 'Advanced-Settings'
  | 'Exporting'
  | 'Model-Manager'
  | 'Mobile-Tablet-and-Companion-App'
  | 'Admin';

export function wikiUrl(page: WikiPage): string {
  return `${WIKI_BASE}/${page}`;
}

/* Best-fit wiki page per Troubleshooting category. Page-level, so retuning is a
   one-line edit. Keyed by CategoryId (src/data/help-failures.ts) — typed as
   Record<string, WikiPage> here; a later task tightens it to
   `satisfies Record<CategoryId, WikiPage>` once CategoryId exists. */
export const CATEGORY_WIKI: Record<string, WikiPage> = {
  setup: 'Getting-Started',
  engines: 'Voice-Engines',
  analysis: 'Analysis-and-the-Analyzer',
  voices: 'Multi-language-Support',
  quality: 'Generating-Audio',
  cast: 'Reviewing-Cast-and-Assigning-Voices',
  performance: 'Advanced-Settings',
  files: 'Exporting',
  other: 'Troubleshooting',
};

export const ADMIN_WIKI = {
  modelManager: 'Model-Manager',
  advanced: 'Advanced-Settings',
  lanAccess: 'Mobile-Tablet-and-Companion-App',
  admin: 'Admin',
} satisfies Record<string, WikiPage>;

export const HELP_SECTION_WIKI = {
  gettingStarted: 'Getting-Started',
  keyboard: 'Account-and-Settings',
  troubleshooting: 'Troubleshooting',
} satisfies Record<string, WikiPage>;
