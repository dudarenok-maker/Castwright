import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/* Settings moved from Account → (section) to Admin → Model Manager → (section)
   on 2026-07-15 (fs-23 phase A7). This guard reads what the UI actually
   renders today — the section AND field labels of the Model Manager form, and
   the sections that still live in the Account view — then scans the live tree
   for text that still sends a reader to Account for a moved setting, and fails
   on each hit.

   Two predicates, both derived, neither a hand-kept name list:

   1. PATH — `Account <sep> X` (any arrow: →, ->, –, —, », >; wrapped across a
      line break or not). X is stale unless it names a section that still lives
      in Account (read from account.tsx and the cards it mounts). This is what
      catches "Account → Models" and "Account → analyzer settings" — names of
      sections that no longer exist anywhere, so no list of CURRENT names could
      hold them.

   2. PROXIMITY — the word "Account" (or an "account tab/page/…" container
      phrase, any case) within WINDOW characters of a moved setting's name, in
      any spelling, with any or no arrow, across any number of line breaks.
      Moved names are the labels model-settings-form.tsx renders.

   Two STRUCTURAL carve-outs for text that legitimately pairs the two: a path
   that still lives in Account (derived, above), and migration prose that names
   the old home ("used to live in Account → …").

   The scan covers the unreleased top of RELEASE_NOTES.md (above the heading
   of package.json's version) and skips the generated per-version wiki pages
   for released versions — released notes describe the UI of their day. */

const repoRoot = path.resolve(__dirname, '../../../');
const formPath = path.join(repoRoot, 'src', 'components', 'model-settings-form.tsx');

const decodeEntities = (s: string) => s.replace(/&amp;/g, '&');

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

/* Read every field label the Model Manager form renders: the `label="…"` JSX
   attribute on each FieldRow/Checkbox, the form's own <h3> headings, and —
   for field components it composes from a sibling file and renders as JSX
   (<GeminiKeyField …>) — the `aria-label` of the input that component owns.
   Trailing parentheticals are dropped ("Phase 0 model (cast detection)" →
   "Phase 0 model"): a doc names the field, not its bracketed gloss. The pin
   test below asserts the exact resolved list, so a label that moves, renames
   or stops resolving fails loudly instead of silently narrowing the scan. */
export function readModelSettingsFieldLabels(): string[] {
  const src = fs.readFileSync(formPath, 'utf-8');
  const strip = (s: string) => decodeEntities(s).replace(/\s*\([^)]*\)\s*$/, '').trim();
  const labels: string[] = [];
  for (const m of src.matchAll(/(?<![\w-])label="([^"]+)"/g)) labels.push(strip(m[1]));
  for (const m of src.matchAll(/<h3\b[^>]*>([^<]+)<\/h3>/g)) labels.push(strip(m[1]));

  const siblingImports = [...src.matchAll(/import\s*\{([^}]+)\}\s*from\s*'\.\/([\w-]+)'/g)];
  for (const [, names, file] of siblingImports) {
    const siblingPath = path.join(path.dirname(formPath), `${file}.tsx`);
    if (!fs.existsSync(siblingPath)) continue;
    const siblingSrc = fs.readFileSync(siblingPath, 'utf-8');
    for (const raw of names.split(',')) {
      const name = raw.trim().replace(/^type\s+/, '');
      if (!name || !new RegExp(`<${name}\\b`).test(src)) continue; // imported but not rendered
      const body = siblingSrc.match(new RegExp(`export function ${name}\\b([\\s\\S]*?)(?=\\nexport |$)`));
      if (!body) continue;
      for (const m of body[1].matchAll(/aria-label="([^"]+)"/g)) labels.push(strip(m[1]));
    }
  }
  if (labels.length === 0) throw new Error(`no field labels resolved from ${formPath}`);
  return [...new Set(labels)];
}

/* Read the sections a view renders: the side-nav entries it declares
   ({ id: '…', label: '…' }) plus every <h2>/<h3> heading in the view and in
   each card it mounts from src/components (the Application updates card
   lives in upgrade-card.tsx, the LAN access card in lan-access-card.tsx —
   neither heading is in its host view's own source). Used twice: for what
   STILL lives in Account, and for what lives under Admin instead. */
export function readViewSectionLabels(viewFile: string): string[] {
  const viewPath = path.join(repoRoot, 'src', 'views', viewFile);
  const src = fs.readFileSync(viewPath, 'utf-8');
  const nav = [...src.matchAll(/\{\s*id:\s*'[\w-]+',\s*label:\s*'([^']+)'/g)].map((m) => m[1]);
  const headings = (text: string) =>
    [...text.matchAll(/<h[23]\b[^>]*>([^<{]+)<\/h[23]>/g)].map((m) => decodeEntities(m[1]).trim());
  const labels = [...nav, ...headings(src)];
  for (const m of src.matchAll(/from\s*'\.\.\/components\/([\w/-]+)'/g)) {
    const p = path.join(repoRoot, 'src', 'components', `${m[1]}.tsx`);
    if (fs.existsSync(p)) labels.push(...headings(fs.readFileSync(p, 'utf-8')));
  }
  if (labels.length === 0) throw new Error(`no section labels resolved from ${viewPath}`);
  return [...new Set(labels)];
}

/* Content words of a label list, for the path predicate's "does X name
   something that lives elsewhere now" test. */
const STOP_WORDS = new Set(['the', 'and', 'for', 'new', 'with', 'from', 'this', 'your', 'settings']);
export function vocabulary(labels: string[]): Set<string> {
  const words = new Set<string>();
  for (const l of labels) {
    for (const w of norm(l).split(/[^a-z0-9-]+/)) {
      if (w.length >= 3 && /^[a-z]/.test(w) && !STOP_WORDS.has(w)) words.add(w);
    }
  }
  return words;
}

/* Characters either side of an "Account" occurrence within which a moved
   setting's name counts as related to it. Wide enough for "the Voice engine
   URL field in Account settings"; narrow enough that a 900-character release
   note mentioning both in different sentences does not pair them. */
const WINDOW = 80;

/* The word in any case, optionally with the container word that follows it
   ("Account tab", "ACCOUNT TAB", "account page"). The bare LOWERCASE word is
   then dropped so identifiers such as s.account, account-slice and
   saveAccountSettings never match; capitalised or shouted, it is the view. */
const ACCOUNT_RE = /\baccount\b(?:[\s-](?:tab|page|view|screen|section|settings)\b)?/gi;
const isBareLowercase = (word: string) => word === 'account';

/* Arrow separators a path may use. A plain hyphen is deliberately absent
   ("Account-tab" is a container phrase, not a path) and so is the em-dash,
   which prose uses as a dash ("Account — dual-model TTS flag"). The segment
   after the arrow runs to the next arrow, punctuation or blank line — a
   single line break inside it is a wrapped path, still one segment. */
const SEP = '(?:→|->|–|»|>)';
const WRAP = '\\n[ \\t]*(?:\\*(?!/)|//|#)?[ \\t]*';
const ACCOUNT_PATH_RE = new RegExp(
  `^Account\\s*${SEP}(?:${WRAP}|[ \\t])*((?:(?!->|→|–|—|»|>|\\n[ \\t]*\\n)(?:${WRAP}|[^.,;:()\\[\\]"'\`*\\n])){1,60})`,
  'i',
);

/* Migration prose naming the OLD home. Matched against the text immediately
   before the occurrence. */
const MIGRATION_PROSE_RE =
  /(?:used to (?:live|be|sit)(?: in| under)?|moved (?:out of|from|away from)|no longer (?:in|lives in|under)|out of|previously (?:in|under)|formerly(?: in)?|instead of|rather than|not)\s+(?:the\s+)?$/i;

/* Other senses of the word: an account WITH a provider. "your Account" and
   "an Account" are NOT here — "your Account settings" is the view. */
const OTHER_SENSE_RE = /(?:Google|GitHub|Castwright|service|provider)\s+$/i;

export interface StaleRef {
  index: number;
  name: string;
}

/* A line break plus the comment prefix of the continuation line (` * `, `//`,
   `#`) reads as one space, so a path or name wrapped inside a block comment
   is seen whole. */
const unwrap = (s: string) => s.replace(/\n[ \t]*(?:\*(?!\/)|\/\/|#)?[ \t]*/g, ' ');
const norm = (s: string) => unwrap(s).toLowerCase().replace(/\s+/g, ' ').trim();
/* Plural-tolerant: "analyzer models" and "analyzer model" both contain the
   trailing-s-stripped form. */
const stem = (s: string) => norm(s).replace(/s$/, '');

export interface GuardNames {
  /* Labels of the settings that moved to the Model Manager. */
  moved: string[];
  /* Sections that still live in Account — `Account → <one of these>` is correct. */
  liveInAccount: string[];
  /* Words naming what lives under Admin (Model Manager, Advanced, LAN access…)
     — `Account → X` is stale when X uses one and X is not an Account section. */
  elsewhere: Set<string>;
}

const PARAGRAPH_BREAK = /\n[ \t]*\n/g;

/* The text within WINDOW characters either side of the occurrence, cut at the
   nearest paragraph break on each side: a bullet or blockquote that ends just
   above an "Account" paragraph is not talking about it. */
function proximityWindow(text: string, at: number, len: number): string {
  let left = text.slice(Math.max(0, at - WINDOW), at);
  let right = text.slice(at, at + len + WINDOW);
  const breaksLeft = [...left.matchAll(PARAGRAPH_BREAK)];
  if (breaksLeft.length > 0) {
    const last = breaksLeft[breaksLeft.length - 1];
    left = left.slice(last.index + last[0].length);
  }
  const breakRight = right.search(PARAGRAPH_BREAK);
  if (breakRight !== -1) right = right.slice(0, breakRight);
  return norm(left + right);
}

/* Every "Account" occurrence in `text` that either heads a path to a section
   that lives elsewhere now, or sits near a moved setting's name, and is not
   carved out. */
export function findStaleAccountRefs(text: string, names: GuardNames): StaleRef[] {
  const hits: StaleRef[] = [];
  const movedStems = names.moved.map(stem);
  const liveNorm = names.liveInAccount.map(norm);
  for (const m of text.matchAll(ACCOUNT_RE)) {
    const at = m.index;
    const word = m[0];
    if (isBareLowercase(word)) continue; // identifier territory
    const before = text.slice(Math.max(0, at - 40), at);
    if (MIGRATION_PROSE_RE.test(before)) continue;
    if (OTHER_SENSE_RE.test(before)) continue;

    const pathM = text.slice(at).match(ACCOUNT_PATH_RE);
    if (pathM) {
      const segment = norm(pathM[1]);
      if (liveNorm.some((l) => segment.startsWith(l))) continue; // still lives in Account
      const named = [...vocabulary([segment])].some((w) => names.elsewhere.has(w));
      if (named) {
        hits.push({ index: at, name: `→ ${segment}` });
        continue;
      }
      // A path to something neither here nor there is not this guard's call.
    }

    const window = proximityWindow(text, at, word.length);
    const i = movedStems.findIndex((n) => window.includes(n));
    if (i !== -1) hits.push({ index: at, name: names.moved[i] });
  }
  return hits;
}

/* Scan a whole file so a name before, after, or several lines away from the
   word is seen in one window; attribute each hit to the line it starts on. */
export function findStaleAccountRefLines(
  content: string,
  names: GuardNames,
): { line: number; name: string; text: string }[] {
  const lines = content.split('\n');
  const starts: number[] = [0];
  for (const l of lines) starts.push(starts[starts.length - 1] + l.length + 1);
  return findStaleAccountRefs(content, names).map((hit) => {
    let line = 0;
    while (line + 1 < lines.length && starts[line + 1] <= hit.index) line++;
    return { line: line + 1, name: hit.name, text: lines[line].trim().substring(0, 100) };
  });
}

describe('Gemini API key path guard', () => {
  const sectionLabels = readModelSettingsSectionLabels();
  const fieldLabels = readModelSettingsFieldLabels();
  const liveInAccount = readViewSectionLabels('account.tsx');
  const underAdmin = [
    ...readViewSectionLabels('admin.tsx'),
    ...readViewSectionLabels('model-manager.tsx'),
  ];
  const moved = [...sectionLabels, ...fieldLabels];
  const names: GuardNames = {
    moved,
    liveInAccount,
    elsewhere: vocabulary([...underAdmin, ...moved]),
  };

  it('reads the five moved section labels from the real MODEL_SETTINGS_SECTIONS export', () => {
    expect(sectionLabels).toEqual([
      'Defaults for new books',
      'Two-model analyzer split (advanced)',
      'Voice engine',
      'Server configuration',
      'Install / update analyzer (Ollama)',
    ]);
  });

  it('reads the moved field labels from what the form renders (pinned so drift is loud)', () => {
    expect(fieldLabels).toEqual([
      'Analysis model',
      'Voice engine',
      'Voice model',
      'Phase 0 model',
      'Phase 1 model',
      'Phase 1 minimum chapter lag',
      'Auto-start with server',
      'Keep both voice engines loaded',
      'Generation workers',
      'Voice engine URL',
      'Analyzer engine',
      'Cloud fallback',
      'Ollama URL',
      'Local analyzer',
      'Analyzer models',
      'Gemini API key',
    ]);
  });

  it('reads what still lives in Account, and what lives under Admin, from the views and their cards', () => {
    expect(liveInAccount).toContain('Application updates');
    expect(liveInAccount).toContain('Models & engines');
    expect(liveInAccount).toContain('Device-local');
    expect(liveInAccount).toContain('Profile');
    expect(liveInAccount).not.toContain('Voice engine');
    expect(underAdmin).toContain('Model Manager');
    expect(underAdmin).toContain('LAN access');
    expect(underAdmin).toContain('Installed models');
    for (const w of ['models', 'analyzer', 'lan', 'advanced', 'voice', 'gemini']) {
      expect(names.elsewhere, w).toContain(w);
    }
  });

  it('detects stale spellings and leaves correct text alone (predicate self-test)', () => {
    const stale = [
      /* rounds 5–7 */
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
      /* pass 6: regressions of shapes the e3aee68b predicate caught */
      'Set the Analysis model in your Account settings.',
      'Open your Account → Voice engine to change the engine.',
      'SET THE ANALYSIS MODEL IN THE ACCOUNT TAB.',
      /* pass 6: paths to sections that no longer exist anywhere */
      'Account → Models → Install Qwen3-TTS runs an installer that has to replace a file.',
      'install Qwen3-TTS in Account → Models.',
      'Account → analyzer settings lets you switch off the structure pass.',
      'is chosen in the UI (Account → analyzer settings) / `user-settings.json`, not',
      'is chosen in the UI (Account -> analyzer settings) / user-settings.json and',
      'so Account → Models can install the Kokoro ONNX weights without a terminal',
      'the in-app installer (Account -> Models) spawns THIS',
      /* pass 6: the server twin of queue-modal's dual-model warning */
      'turning on "Keep both voice engines loaded" in Account settings avoids engine-swap latency.',
      /* pass 6: name before the word, across one and two line breaks */
      'The Analysis model now\nlives in the Account view.',
      'the Voice engine URL field in\nAccount settings is clearer.',
      'Open Account\nthen pick\nAnalysis model',
      /* other arrows, and a path wrapped across a line break */
      'Reinstall from Account – Voice engine.',
      'Account » Server configuration holds the key.',
      'adds an "Install Ollama" affordance to the Account →\n * Models pane so a deployer can',
      /* paths to sections that moved somewhere other than the Model Manager */
      'use “Authorize this browser” under Account → LAN access.',
      'rebindable in Account → Advanced; the shortcut lives in Device-local now',
      'Do not open Account → Advanced Settings before the render.',
    ];
    for (const s of stale) {
      expect(findStaleAccountRefLines(s, names), s).not.toHaveLength(0);
    }

    const fine = [
      'Sign in to your Castwright account, then open Admin → Model Manager → Gemini API key.',
      'These used to live in Account → Defaults for new books; they now live in Admin → Model Manager.',
      'Pages Voice → Defaults → Voice; saveAccountSettings overwrote the Defaults voice model.',
      'The settings moved out of the Account view into the Model Manager: the Voice engine section.',
      'or through Account → Application updates — will trigger a one-time reinstall of the voice engine.',
      'A Google account is required for the Gemini API key.',
      'the Voice engine URL and Ollama URL now live in the Model Manager, not the Account view',
      /* pass 6: en-dash on a path that is still correct */
      'Reinstall the voice engine from Account – Application updates.',
      'Account → Models & engines is a pointer card that opens the Model Manager.',
      'Use your Google Account to create a Gemini API key.',
      'the Account view; account.analysisEngine is read by advanced.tsx',
      'Account → Profile → Display name is unchanged.',
      'Account → Device-local holds the play/pause shortcut.',
      'Account → Advanced configuration is a pointer card into Advanced Settings.',
      'This route adds a *check* so the Account → Application\n   updates card can say whether a newer release exists.',
      "aria-label={`Account — ${userDisplayName || 'unnamed user'}`}",
      "test.describe('Account — Open Model Manager button in dark mode', () => {",
      /* a paragraph that ends just above an Account paragraph is not about it */
      '> pre-pick — voice engine, models, and theme.\n\n**Account** (`#/account`) is reached from the avatar.',
      'Trigger the in-app upgrade (Account → Check for updates → Install, or the CLI).',
    ];
    for (const s of fine) {
      expect(findStaleAccountRefLines(s, names), s).toHaveLength(0);
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

        for (const hit of findStaleAccountRefLines(content, names)) {
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
