import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/* Settings moved from Account → (section) to Admin → Model Manager → (section)
   on 2026-07-15 (fs-23 phase A7). This guard reads the section labels the UI
   actually exports (MODEL_SETTINGS_SECTIONS in model-settings-form.tsx), then
   scans the live tree for the word "Account" sitting NEAR one of the moved
   settings' names — in any spelling, with any or no arrow, across a line
   break — and fails on each hit.

   Proximity, not syntax: an earlier version enumerated container words
   ("Account tab", "Account settings") and so missed "Account page",
   "Account-tab", "**Account**" and a path wrapped across a newline. This one
   matches the word itself and lets a character window decide relatedness,
   with two STRUCTURAL carve-outs for text that legitimately pairs the two:
   a path that still lives in Account (Account → Application updates), and
   migration prose that names the old home ("used to live in Account → …").

   The scan covers the unreleased top of RELEASE_NOTES.md (above the heading
   of package.json's version) and skips the generated per-version wiki pages
   for released versions — released notes describe the UI of their day. */

const repoRoot = path.resolve(__dirname, '../../../');

/* Read the labels MODEL_SETTINGS_SECTIONS is composed of, from the source of
   the real export rather than from every `label:` in the file (which also
   picks up unrelated status chips). A typed import is not available here —
   server/tsconfig.json pins rootDir to server/src with no DOM lib and no JSX —
   and a runtime dynamic import would drag the React + Redux store graph into
   a node-env suite. So this resolves the export's composition structurally:
   the array body lists `label: GROUP_X.label` references, and each GROUP_X is
   a const with a literal `label:`. Every step throws rather than degrading to
   a shorter list, so a refactor of the form's shape fails this test loudly. */
export function readModelSettingsSectionLabels(): string[] {
  const formPath = path.join(repoRoot, 'src', 'components', 'model-settings-form.tsx');
  const src = fs.readFileSync(formPath, 'utf-8');
  const exportBody = src.match(/export const MODEL_SETTINGS_SECTIONS\b[^=]*=\s*\[([\s\S]*?)\n\];/);
  if (!exportBody) {
    throw new Error(`MODEL_SETTINGS_SECTIONS export not found in ${formPath}`);
  }
  const groupRefs = [...exportBody[1].matchAll(/\blabel:\s*(GROUP_[A-Z_]+)\.label/g)].map(
    (m) => m[1],
  );
  if (groupRefs.length === 0) {
    throw new Error('MODEL_SETTINGS_SECTIONS lists no `label: GROUP_*.label` entries');
  }
  return groupRefs.map((name) => {
    const decl = src.match(new RegExp(`\\bconst ${name}\\b[^=]*=\\s*\\{([\\s\\S]*?)\\n\\};`));
    const label = decl?.[1].match(/\blabel:\s*(['"])(.*?)\1/);
    if (!label) throw new Error(`${name} has no literal label: in ${formPath}`);
    return label[2];
  });
}

/* Field names and aliases that appear alongside the moved sections in docs
   and comments. Matched case-insensitively. */
const MOVED_SETTING_ALIASES = [
  'Analysis model',
  'Gemini API key',
  'Voice engine',
  'Voice model',
  'Voice engine URL',
  'Ollama URL',
  'Phase 0 model',
  'Phase 1 model',
  'Analyzer model',
  'Analyzer engine',
];

/* Characters either side of an "Account" occurrence within which a moved
   setting's name counts as related to it. Wide enough for "the Voice engine
   URL field in Account settings"; narrow enough that a 900-character release
   note mentioning both in different sentences does not pair them. */
const WINDOW = 80;

/* The word itself, plus the lowercase form when it is unambiguously the view
   ("account page"). Case-sensitive on the bare word so identifiers such as
   saveAccountSettings, s.account and account-slice never match. */
const ACCOUNT_RE = /\bAccount\b|\baccount[\s-](?:tab|page|view|screen|section|settings)\b/g;

/* Paths that still live in Account. Matched from the occurrence forward. */
const STILL_IN_ACCOUNT_RE = /^Account\s*(?:→|->)\s*Application updates/;

/* Migration prose naming the OLD home. Matched against the text immediately
   before the occurrence. */
const MIGRATION_PROSE_RE =
  /(?:used to (?:live|be|sit)(?: in| under)?|moved (?:out of|from|away from)|no longer (?:in|lives in|under)|out of|previously (?:in|under)|formerly(?: in)?|instead of|rather than|not)\s+(?:the\s+)?$/i;

/* Other senses of the word. */
const OTHER_SENSE_RE = /(?:Google|user|your|an?)\s+$/i;

export interface StaleRef {
  index: number;
  name: string;
}

/* Every "Account" occurrence in `text` that is within WINDOW characters of a
   moved setting's name and is not carved out. */
export function findStaleAccountRefs(text: string, names: string[]): StaleRef[] {
  const hits: StaleRef[] = [];
  const lowerNames = names.map((n) => n.toLowerCase());
  for (const m of text.matchAll(ACCOUNT_RE)) {
    const at = m.index;
    const before = text.slice(Math.max(0, at - 40), at);
    if (STILL_IN_ACCOUNT_RE.test(text.slice(at))) continue;
    if (MIGRATION_PROSE_RE.test(before)) continue;
    if (OTHER_SENSE_RE.test(before)) continue;
    const window = text
      .slice(Math.max(0, at - WINDOW), at + m[0].length + WINDOW)
      .toLowerCase()
      .replace(/\s+/g, ' ');
    const name = lowerNames.find((n) => window.includes(n));
    if (name !== undefined) hits.push({ index: at, name: names[lowerNames.indexOf(name)] });
  }
  return hits;
}

/* Scan a file's text on a sliding two-line window so a path wrapped across a
   line break is seen whole. Each occurrence is attributed to the line it
   starts on and reported once. */
export function findStaleAccountRefLines(
  content: string,
  names: string[],
): { line: number; name: string; text: string }[] {
  const lines = content.split('\n');
  const out: { line: number; name: string; text: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const pair = i + 1 < lines.length ? `${lines[i]}\n${lines[i + 1]}` : lines[i];
    for (const hit of findStaleAccountRefs(pair, names)) {
      if (hit.index >= lines[i].length) continue; // starts on the next line; reported there
      out.push({ line: i + 1, name: hit.name, text: lines[i].trim().substring(0, 100) });
    }
  }
  return out;
}

describe('Gemini API key path guard', () => {
  const sectionLabels = readModelSettingsSectionLabels();
  const allMovedNames = [...sectionLabels, ...MOVED_SETTING_ALIASES];

  it('reads the five moved section labels from the real MODEL_SETTINGS_SECTIONS export', () => {
    expect(sectionLabels).toEqual([
      'Defaults for new books',
      'Two-model analyzer split (advanced)',
      'Voice engine',
      'Server configuration',
      'Install / update analyzer (Ollama)',
    ]);
  });

  it('detects stale spellings and leaves correct text alone (predicate self-test)', () => {
    const stale = [
      'Set your Analysis model in the Account tab before uploading.',
      'Go to Account → Defaults for new books → Analysis model and save.',
      'Open Account -> Voice engine and enable dual-model mode.',
      "The Account view's Analysis model picker reads this list.",
      'Paste the key on the Account page under Server configuration.',
      'The Account-tab surface sets the default Analysis model.',
      'Pick your Voice model on the Account screen.',
      'The Voice engine URL lives in the Account section of Settings.',
      'Open **Account** then **Defaults for new books** and pick a model.',
      'The Voice engine URL field in Account settings is clearer about what happens.',
      'needs a `GEMINI_API_KEY` set from Account → Server\nConfiguration (or in `server/.env`)',
    ];
    for (const s of stale) {
      expect(findStaleAccountRefLines(s, allMovedNames), s).not.toHaveLength(0);
    }

    const fine = [
      'Sign in to your Castwright account, then open Admin → Model Manager → Gemini API key.',
      'These used to live in Account → Defaults for new books; they now live in Admin → Model Manager.',
      'Pages Voice → Defaults → Voice; saveAccountSettings overwrote the Defaults voice model.',
      'The settings moved out of the Account view into the Model Manager: the Voice engine section.',
      'or through Account → Application updates — will trigger a one-time reinstall of the voice engine.',
      'A Google account is required for the Gemini API key.',
      'the Voice engine URL and Ollama URL now live in the Model Manager, not the Account view',
    ];
    for (const s of fine) {
      expect(findStaleAccountRefLines(s, allMovedNames), s).toHaveLength(0);
    }
  });

  it('scans the live tree for stale Account paths to settings moved to Model Manager', () => {
    const currentVersion: string = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf-8'),
    ).version;
    const versionKey = (v: string) => v.split('.').map(Number);
    const isReleased = (v: string) => {
      const [a, b] = [versionKey(v), versionKey(currentVersion)];
      for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
      return true;
    };

    /* docs/features and docs/superpowers are design history, not live paths.
       Dotted entries (.git, .venv, .superpowers, …) are skipped by the walk. */
    const dirsToExclude = [
      'node_modules',
      'dist',
      'build',
      'coverage',
      'docs/features',
      'docs/superpowers',
    ];

    function shouldExcludeDir(dirPath: string): boolean {
      const rel = path.relative(repoRoot, dirPath).split(path.sep).join('/');
      return dirsToExclude.some((ex) => rel === ex || rel.endsWith(`/${ex}`));
    }

    const failing: { file: string; line: number; pattern: string; text: string }[] = [];

    function walkDir(dir: string) {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return; // unreadable dir
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          if (!shouldExcludeDir(fullPath)) walkDir(fullPath);
          continue;
        }
        if (!entry.isFile()) continue;
        if (!/\.(ts|tsx|md|mjs)$/.test(entry.name) && entry.name !== '.env.example') continue;
        if (fullPath === __filename) continue; // this guard names the stale forms on purpose

        /* Generated per-version wiki pages for RELEASED versions describe the
           UI of their day (scripts/generate-release-notes-wiki.mjs). A page for
           a not-yet-released version is still live text. */
        const releasePage = entry.name.match(/^Release-Notes-v(\d+\.\d+\.\d+)\.md$/);
        if (releasePage && isReleased(releasePage[1])) continue;

        let content: string;
        try {
          content = fs.readFileSync(fullPath, 'utf-8');
        } catch {
          continue; // unreadable file
        }

        /* Top-level RELEASE_NOTES.md: everything ABOVE the heading of the
           current released version is the in-progress section — live text
           that ships next cut. Everything from that heading down is history. */
        if (fullPath === path.join(repoRoot, 'RELEASE_NOTES.md')) {
          const cutoff = content.indexOf(`\n# Castwright ${currentVersion}\n`);
          const atTop = content.startsWith(`# Castwright ${currentVersion}\n`);
          if (cutoff === -1 && !atTop) {
            throw new Error(
              `RELEASE_NOTES.md has no "# Castwright ${currentVersion}" heading (package.json version)`,
            );
          }
          content = atTop ? '' : content.slice(0, cutoff + 1);
        }

        for (const hit of findStaleAccountRefLines(content, allMovedNames)) {
          failing.push({
            file: path.relative(repoRoot, fullPath).split(path.sep).join('/'),
            line: hit.line,
            pattern: `Account + "${hit.name}"`,
            text: hit.text,
          });
        }
      }
    }

    walkDir(repoRoot);

    /* Positive assertion: the corrected path is present in at least one live
       error message, so an over-eager rewrite cannot pass by removing both. */
    const correctPathIndicators = ['Admin → Model Manager', 'Admin -> Model Manager'];
    const liveSources = [
      path.join(__dirname, 'index.ts'),
      path.join(repoRoot, 'server', 'src', 'routes', 'failure-remediations.ts'),
    ];
    const foundCorrectPath = liveSources.some((p) => {
      const src = fs.readFileSync(p, 'utf-8');
      return correctPathIndicators.some((ind) => src.includes(ind));
    });
    if (!foundCorrectPath) {
      failing.push({
        file: 'server/src/analyzer/index.ts or server/src/routes/failure-remediations.ts',
        line: 0,
        pattern: 'Correct path verification',
        text: 'No occurrence of "Admin → Model Manager" in live error messages',
      });
    }

    const errorMsg =
      failing.length > 0
        ? `Found ${failing.length} stale/missing paths:\n${failing
            .map((f) => `  ${f.file}:${f.line} — ${f.pattern}\n    ${f.text}`)
            .join('\n')}`
        : '';
    expect(failing, errorMsg).toHaveLength(0);
  });
});
