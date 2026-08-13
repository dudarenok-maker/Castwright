# Entity decode layer — implementation plan (#2310)

> **⚠️ CONTINGENT ON AN OWNER DECISION.** This plan implements **Option 1** of
> `docs/superpowers/specs/2026-08-13-entity-decode-layer-design.md` — widen the
> named-entity decode in `stripHtml`. Options 2 and 3 are refuted in the spec,
> but the choice is the owner's and it has **not been approved yet**. Do not
> start Task 1 until the owner has approved Option 1. If they pick another
> option, this plan is void, not adaptable.
>
> The decision also carries a **new production dependency** on `entities`
> (spec, "Why a library rather than a curated table") — approving the plan
> approves that dependency.

> **For agentic workers:** REQUIRED SUB-SKILL: use
> `superpowers:subagent-driven-development` to implement this plan task-by-task.

**Goal:** An `&ndash;`- or `&mdash;`-opened dialogue line in `es`, `fr` and `ru`
reaches the TTS engine with the **same normalised text** a literal `—`-opened
line produces — the leading marker becomes a pause, not spoken characters. And
the whole rest of the surviving-entity class (`&eacute;`, `&rsquo;`, `&laquo;`,
`&hellip;`, `&apos;` …) stops being read aloud with it.

**Architecture:** Replace the **three** hand-rolled copies of the five-entity
list (`stripHtml`, `extractFirstHeading`, `epub.ts`'s `decodeEntities`) with
**one shared helper** doing a complete HTML5 named-entity decode, scoped by regex
to *named* references only so the existing numeric-reference contract is
untouched. Nothing downstream changes: the dash pipeline is already correct for a
real dash character, proved by `&#8211;` producing correct audio today.

**Two facts that shape the tasks, both established late in the design pass —
read spec Finding 0 before Task 1:**

1. **TTS does not read the parsed body.** It reads the stage-2 model's returned
   `SentenceOutput.text` (`synthesise-chapter.ts:2514,2570` ←
   `analysis.ts:5077-5080`). So the body-line symptom is conditional on the model
   echoing the entity, which was **not** verified and is not assumed here.
2. **Chapter titles bypass the model entirely** (`generation.ts:1548` →
   `synthesise-chapter.ts:1562,2248`) and their text comes from
   `extractFirstHeading` — which has its **own** copy of the narrow entity list.
   **The title path is the unconditional instance of this bug**, and it is the
   acceptance evidence to lead with. Fixing `stripHtml` alone would leave it
   unfixed.

**Tech Stack:** TypeScript, Node, Vitest, `entities@^8.0.0`.

**Spec:** `docs/superpowers/specs/2026-08-13-entity-decode-layer-design.md` —
the design of record. **Read it before Task 1.** Finding 1 is why the fix is at
this layer; Finding 6 is the three edge cases a naive swap gets wrong.

## Global Constraints

- **`decodeHTMLStrict`, never `decodeHTML`.** `decodeHTML` implements HTML5's
  legacy semicolon-less rule and corrupts ordinary prose: `Fish &notice this` →
  `Fish ¬ice this`, `Copyright &copy 2026` → `Copyright © 2026`. Task 2 pins
  this with a test. Measured in spec Finding 6.
- **Scope the library call to NAMED references only** — via
  `/&[a-zA-Z][a-zA-Z0-9]*;/g`. Do **not** call `decodeHTMLStrict` on the whole
  string. `decodeHTMLStrict` maps out-of-range numeric references to U+FFFD,
  which **violates `decodeNumericEntities`'s documented contract**
  (`html-utils.ts:15-16`: "Invalid or out-of-range references are left untouched
  rather than dropped") and would send U+FFFD to the engine — it is not stripped
  by `stripUnsafeForTts`. Note the contract is narrower than its own wording:
  `&#0;` and `&#xD800;` **do** decode today (probed), so only `&#99999999;` /
  `&#x110000;` / malformed refs are actually left literal.
- **Leave `decodeNumericEntities` completely untouched**, and keep it running
  **after** the named pass. It stays the only owner of numeric references.
- **Fold U+00A0 to a plain space between the two passes**, not before. Today
  `&nbsp;` → `' '` (U+0020); `decodeHTMLStrict` yields U+00A0. Folding the
  *character* (not the spelling `&nbsp;`) also catches HTML5 aliases —
  `&NonBreakingSpace;` decodes to U+00A0 too. Placed **before**
  `decodeNumericEntities`, it leaves `&#160;` → U+00A0 exactly as today. **Do
  not** "simplify" by folding after the numeric pass — that silently changes
  `&#160;`.
- **The `&nbsp;` special-case line is redundant once the fold exists.** Remove
  it; do not keep both. (`&nbsp;` → U+00A0 → `' '`.)
- **All three copies of the entity list get the same fix, via one shared
  helper** — `stripHtml` (`html-utils.ts:52-56`), `extractFirstHeading`
  (`html-utils.ts:72-79`), and `epub.ts`'s `decodeEntities` (`:499-510`, which
  also decodes NCX chapter labels at `:430`). Three copies drifting apart is the
  documented failure mode here: `decodeEntities`' comment already claims to
  "match stripHtml" and does not. **Do not fix one and leave the others.**
- **Do NOT remove the dash shims** — `dialogueOpen` in
  `server/src/analyzer/dialogue-structure/lang/{es,fr,ru}.ts`, the `DASH`
  constant in `dialogue-structure/parser.ts:10` and `legibility.ts:3`, and
  `aligner.ts:92-94`'s 7-char entity atom (six files, one shim shape). They stop
  firing on freshly-parsed body text, but they normalise **LLM-returned** text,
  which can echo an entity whatever the parser did, and entity-laden sentence
  text persists in `manuscript-edits.json` and the analysis cache. Removing them
  would regress dialogue *attribution* — strictly worse than the
  mispronunciation being fixed.
  **Note: `state.json` carries no chapter body** (`workspace/scan.ts:63-100`) —
  an earlier draft justified the shims that way and was wrong. Do not restore
  that reasoning.
- **Every existing test must stay green unchanged.** Verified by probe: the two
  `epub.test.ts` double-unescape cases (`&amp;lt;` → `&lt;`, `&amp;amp;lt;` →
  `&amp;lt;`) and `html-utils.test.ts:53` all produce identical output under the
  new implementation. If one goes red, the implementation diverged from this
  plan — do not edit the test.
- **The vacuous-fixture trap.** `&nbsp;` is decoded by `stripHtml`, so it can
  never represent "an entity that survives" — that mistake shipped in #2289.
  After this change no *known* entity survives either. **The one fixture shape
  that still genuinely survives is an UNKNOWN named reference** (`&zzz;`,
  `&notanentity;`) — probed: `decodeHTMLStrict` leaves them literal. Use that,
  not `&hellip;` (which stops surviving) and never `&nbsp;`.
- **Do not assert the body-line symptom against a live model.** Per spec
  Finding 0, TTS reads model-returned text. Every test here fixes its input
  string explicitly; none round-trips an analyzer. A test that did would pass or
  fail by model version.
- **Worktree hazard:** this plan adds a dependency. `node_modules` is
  **junctioned** from the primary checkout — a plain `npm install` in the
  worktree **replaces the junction with a real directory** and changes teardown.
  See Task 1 for the required sequence.

---

### Task 1: Add the `entities` dependency

**Files:**
- Modify: `server/package.json`
- Modify: `package-lock.json` (generated)

- [ ] **Step 1: Add the dependency.**

Add to `server/package.json` `dependencies` (alphabetical, between `epub2` and
`express`):

```json
"entities": "^8.0.0",
```

- [ ] **Step 2: Install without destroying the junction.**

`entities@8.0.0` is already in the root lockfile as a **dev** transitive of
`parse5` ← `jsdom`; this promotes it to a **server production** dep. It has zero
dependencies and zero peer dependencies, so resolution is trivial.

Run the install **in the primary checkout** (`C:\Claude\Projects\Audiobook-Generator`),
not the worktree, then re-verify the worktree's junctions still point at real
directories per CLAUDE.md's worktree checklist (`(Get-Item $p -Force).Target` —
**not** `.LinkTarget`, which reads empty on Windows PowerShell 5.1).

- [ ] **Step 3: Verify it resolves from the server.**

```bash
cd server && node -e "import('entities').then(m => console.log(typeof m.decodeHTMLStrict))"
# expect: function
```

**Verify:** `npm run typecheck` passes.

---

### Task 2: Widen the named-entity decode in `stripHtml`

**Files:**
- Modify: `server/src/parsers/html-utils.ts`
- Modify: `server/src/parsers/html-utils.test.ts`

**Interfaces:** `stripHtml(html: string): string` — signature unchanged.

- [ ] **Step 1: Write the failing tests.**

Append to `server/src/parsers/html-utils.test.ts`:

```ts
describe('stripHtml — named character references (#2310)', () => {
  /* Why the complete HTML5 set and not a curated list: the curated list is
     what this repo already tried twice and was bitten by both times — the
     original five-entry set (XML-predefined + &nbsp;, copied wholesale in the
     first server commit), and es/fr `dialogueOpen` carrying &mdash; but not
     &ndash; (#2289). An enumeration of spellings loses a spelling per round. */
  it('#2310: decodes the dash entities that opened this bug', () => {
    expect(stripHtml('<p>&ndash; Un momento &mdash; dijo él.</p>')).toBe(
      '– Un momento — dijo él.',
    );
  });

  it('#2310: decodes accented letters — the case that corrupts whole words', () => {
    expect(stripHtml('<p>&eacute;t&eacute; &agrave; la fen&ecirc;tre</p>')).toBe(
      'été à la fenêtre',
    );
  });

  it('#2310: decodes typographic punctuation and guillemets', () => {
    expect(stripHtml('<p>&laquo;Привет&raquo;&hellip; &rsquo;tis</p>')).toBe(
      '«Привет»… ’tis',
    );
  });

  it('#2310: decodes &apos; — an XML-predefined entity the hand-rolled set dropped', () => {
    expect(stripHtml('<p>&apos;tis</p>')).toBe("'tis");
  });

  /* decodeHTMLStrict vs decodeHTML. decodeHTML implements HTML5's legacy
     semicolon-less rule and would render these `Fish ¬ice this` /
     `Copyright © 2026`. This test is the ONLY thing pinning that choice —
     swapping to decodeHTML turns it red. */
  it('#2310: a bare ampersand in prose is never decoded (decodeHTMLStrict, not decodeHTML)', () => {
    expect(stripHtml('<p>Fish &notice this</p>')).toBe('Fish &notice this');
    expect(stripHtml('<p>Copyright &copy 2026</p>')).toBe('Copyright &copy 2026');
    expect(stripHtml('<p>Smith & Sons, AT&T and R&D</p>')).toBe('Smith & Sons, AT&T and R&D');
  });

  it('#2310: an unknown entity is left literal', () => {
    expect(stripHtml('<p>&unknownentity; stays</p>')).toBe('&unknownentity; stays');
  });

  it('#2310: &amp;ndash; single-passes to &ndash;, never to a dash', () => {
    expect(stripHtml('<p>&amp;ndash;</p>')).toBe('&ndash;');
  });

  it('#2310: &nbsp; still yields U+0020, not U+00A0 — and so do its aliases', () => {
    expect(stripHtml('<p>A&nbsp;B</p>')).toBe('A B');
    expect(stripHtml('<p>A&nbsp;B</p>')).not.toContain('\u00a0');
    expect(stripHtml('<p>A&NonBreakingSpace;B</p>')).not.toContain('\u00a0');
  });

  /* The contract at html-utils.ts:15-16 — documented since the Coalfall fix
     but never pinned by a test until now. decodeHTMLStrict maps these to
     U+FFFD, which stripUnsafeForTts does NOT remove, so a whole-string
     decodeHTMLStrict call would send a replacement char to the TTS engine.

     ONLY these two, and this is measured, not assumed: `codePointOr` guards
     `!Number.isFinite`, `< 0` and `> 0x10ffff`, so `&#0;` and `&#xD800;` DO
     decode today (to NUL and a lone surrogate, both removed later by
     `stripUnsafeForTts`). Adding those two here ships a RED test — an earlier
     draft of this plan did exactly that, and probing is how it was caught. */
  it('#2310: out-of-range numeric references are still left literal', () => {
    for (const ref of ['&#99999999;', '&#x110000;']) {
      const out = stripHtml(`<p>A${ref}B</p>`);
      expect(out).toBe(`A${ref}B`);
      expect(out).not.toContain('\ufffd');
    }
  });

  /* Found by adversarial review: these decode BEFORE the `[ \t]+\n` and
     `\n{3,}` collapses at html-utils.ts:58-59, and the parsers emit one
     paragraph per line \u2014 so they can change chapter STRUCTURE, not just
     wording. Vanishingly rare in real ebook output; pinned anyway, because
     "rare" is not "handled". */
  it('#2310: &NewLine; / &Tab; decode without corrupting paragraph structure', () => {
    expect(stripHtml('<p>A&Tab;B</p>')).toBe('A\tB');
    expect(stripHtml('<p>One&NewLine;Two</p>').split('\n').filter(Boolean)).toEqual(['One', 'Two']);
  });
});
```

Run them — all fail except the last (which passes today and must keep passing:
it is a **characterisation** test guarding Task 2's regression risk, not a
red-then-green one). Note that distinction in the run log.

- [ ] **Step 2: Implement — as ONE exported helper, used by all three copies.**

In `server/src/parsers/html-utils.ts`, add the import and the shared helper.
**This is the deliverable, not an optional refactor**: three hand-rolled copies
of this list exist today and two have already drifted apart (`decodeEntities`
claims to "match stripHtml" and has no numeric support at all). Tasks 2, 2b and
7 all call this one function.

```ts
import { decodeHTMLStrict } from 'entities';

/* Decode the COMPLETE HTML5 named-entity set. #2310.

   The previous five (`&nbsp; &lt; &gt; &quot; &amp;`) were the XML predefined
   set plus `&nbsp;`, introduced whole in the first server commit (a922c075) as
   the standard "unescape XML" idiom — never a curated judgement about which
   entities are safe to decode in prose, and never widened on purpose.
   Everything it missed (`&ndash;` `&mdash;` `&eacute;` `&rsquo;` `&laquo;`
   `&hellip;` `&apos;` …) survived into body text AND chapter titles and was
   READ ALOUD VERBATIM by the TTS engine.

   Three deliberate constraints, all load-bearing — see
   docs/superpowers/specs/2026-08-13-entity-decode-layer-design.md:

   1. `decodeHTMLStrict`, not `decodeHTML`. The latter honours HTML5's legacy
      semicolon-less references and would turn `Fish &notice this` into
      `Fish ¬ice this` and `Copyright &copy 2026` into `Copyright © 2026`.
      Requiring the semicolon leaves `AT&T` / `Smith & Sons` alone.
   2. Scoped to NAMED references by regex. Called on a whole string,
      `decodeHTMLStrict` would also take the numeric ones — and it maps
      out-of-range references to U+FFFD, breaking `decodeNumericEntities`'s
      contract above (and U+FFFD is not stripped before synthesis). Numerics
      stay that function's job, and callers run it afterwards.
   3. U+00A0 folds to a plain space. `&nbsp;` yielded U+0020 before #2310 and
      must keep doing so; folding the CHARACTER rather than the spelling also
      covers aliases such as `&NonBreakingSpace;`. Callers must run this
      BEFORE `decodeNumericEntities` so `&#160;` still yields U+00A0 as it did.

   A leftmost `replace` does not rescan its own output, so `&amp;lt;` yields
   `&lt;` rather than double-unescaping to `<`. */
export function decodeNamedEntities(s: string): string {
  return s.replace(/&[a-zA-Z][a-zA-Z0-9]*;/g, (m) => decodeHTMLStrict(m)).replace(/ /g, ' ');
}
```

Then replace the five `.replace()` calls at `:52-56` and the return at `:57`:

```ts
  s = decodeNamedEntities(s);
  return decodeNumericEntities(s)
```

**Verify:** `cd server && npx vitest run src/parsers/html-utils.test.ts` — all
green, including the pre-existing 22 tests, **unedited**.

---

### Task 2b: The chapter-title path — `extractFirstHeading`

**The model-independent instance of this bug.** `extractFirstHeading`
(`html-utils.ts:72-79`) carries its **own** copy of the five-entity list, and its
output becomes the chapter title `synthesise-chapter.ts:2248` synthesises with
**no model in the path** (spec Finding 0). Fixing `stripHtml` alone leaves a
chapter titled `L&rsquo;&Eacute;t&eacute;` read aloud verbatim.

**Files:**
- Modify: `server/src/parsers/html-utils.ts:72-80`
- Modify: `server/src/parsers/html-utils.test.ts`

- [ ] **Step 1: Write the failing test.**

```ts
describe('extractFirstHeading — named entities (#2310)', () => {
  /* The chapter title is spoken as its own title beat and — unlike body text —
     never passes through the stage-2 model, so this path reproduces #2310
     unconditionally, whatever the model does with dashes. */
  it('#2310: decodes named entities in a heading', () => {
    expect(extractFirstHeading('<h1>L&rsquo;&Eacute;t&eacute; &mdash; Tome I</h1>')).toBe(
      'L’Été — Tome I',
    );
  });
  it('#2310: still leaves a bare ampersand alone', () => {
    expect(extractFirstHeading('<h1>Smith &amp; Sons, AT&T</h1>')).toBe('Smith & Sons, AT&T');
  });
});
```

- [ ] **Step 2: Implement.** Replace the five inline `.replace()` calls at
`:75-79` with the shared helper:

```ts
  const raw = decodeNumericEntities(decodeNamedEntities(m[1].replace(/<[^>]+>/g, ' ')))
    .replace(/\s+/g, ' ')
    .trim();
```

**Verify:** `cd server && npx vitest run src/parsers/html-utils.test.ts`

---

### Task 3: Pin the end-to-end text handed to the engine

This is the acceptance criterion the issue states, and the test that stops a
future change at a *different* layer from silently reopening the bug.

**Files:**
- Create: `server/src/tts/entity-dialogue-e2e.test.ts`

- [ ] **Step 1: Write the failing test.**

```ts
/* #2310 — the end-to-end guard. `stripHtml` decodes the entity (Task 2) and
   the dash pipeline (`dialogueOpen`, LEADING_DASH, softenDashes) then treats it
   exactly like a literal dash. This test spans BOTH layers on purpose: a future
   change to either one that reopens the bug turns it red, which a unit test at
   one layer alone would not catch.

   Asserted as EQUALITY AGAINST THE GLYPH FORM, never against a hardcoded
   string — the point is that the two forms agree, whatever `softenDashes`
   renders a leading dash as. A hardcoded expectation would drift. */
import { describe, expect, it } from 'vitest';
import { extractFirstHeading, stripHtml } from '../parsers/html-utils.js';
import { normaliseForTts } from './text-normalize.js';

describe('#2310 — an entity-opened dialogue line reaches the engine as the glyph does', () => {
  const cases = [
    { lang: 'es', entity: '&ndash; Un momento &mdash; dijo él.', glyph: '– Un momento — dijo él.' },
    { lang: 'es', entity: '&mdash; Un momento.', glyph: '— Un momento.' },
    { lang: 'fr', entity: '&ndash; Un instant &mdash; dit-il.', glyph: '– Un instant — dit-il.' },
    { lang: 'ru', entity: '&mdash; Кто там?', glyph: '— Кто там?' },
    { lang: 'ru', entity: '&ndash; Стой.', glyph: '– Стой.' },
  ];

  for (const { lang, entity, glyph } of cases) {
    it(`${lang}: ${entity.slice(0, 12)}… normalises identically to the glyph form`, () => {
      const fromEntity = normaliseForTts(stripHtml(`<p>${entity}</p>`), lang);
      const fromGlyph = normaliseForTts(stripHtml(`<p>${glyph}</p>`), lang);
      expect(fromEntity).toBe(fromGlyph);
      /* Non-vacuity: equality alone would hold if BOTH sides were broken (e.g.
         if stripHtml stopped decoding and softenDashes stopped firing). Pin
         that the marker actually became a pause and no entity text survives. */
      expect(fromEntity).not.toMatch(/&[a-zA-Z]+;/);
      expect(fromEntity.startsWith('... ')).toBe(true);
    });
  }

  it('the accented-letter case — the one that corrupts whole words, not just openers', () => {
    const out = normaliseForTts(stripHtml('<p>&ndash; C&rsquo;est l&rsquo;&eacute;t&eacute;.</p>'), 'fr');
    expect(out).not.toMatch(/&[a-zA-Z]+;/);
    expect(out).toContain('été');
  });

  /* Closes the vacuity hole review found: LEADING_DASH (/^\s*[–—]\s*/) collapses
     en AND em dash to the same '... ', so the equality assertions above pass
     even if the decode produced the WRONG dash. Assert on the pre-normalisation
     stripHtml output, where the two are still distinguishable. */
  it('the decoded dash is the RIGHT codepoint, not merely dash-like', () => {
    expect(stripHtml('<p>&ndash; x</p>')).toBe('– x'); // U+2013 en
    expect(stripHtml('<p>&mdash; x</p>')).toBe('— x'); // U+2014 em
  });

  /* The model-independent path (spec Finding 0). Chapter titles never reach
     stage-2, so this reproduces regardless of what the model does — it is the
     assertion to trust when the body-path symptom is model-conditional. */
  it('the chapter-title beat: an entity-laden heading is spoken clean', () => {
    const title = extractFirstHeading('<h1>L&rsquo;&Eacute;t&eacute; &mdash; Tome I</h1>')!;
    const spoken = normaliseForTts(title, 'fr');
    expect(spoken).not.toMatch(/&[a-zA-Z]+;/);
    expect(spoken).toContain('L’Été');
  });
});
```

**The non-vacuity assertions are not optional.** A bare
`expect(fromEntity).toBe(fromGlyph)` passes if both sides are equally broken —
which is exactly the state before Task 2 for a *pair* of entity inputs. The
`startsWith('... ')` and no-surviving-entity checks are what make it a real gate.

- [ ] **Step 2: Confirm red before Task 2, green after.**

Stash Task 2's change, run, confirm red **and read the failure** — it must fail
on the entity/glyph *inequality*, not on an import error or a thrown exception.
Restore, run, confirm green.

**Verify:** `cd server && npx vitest run src/tts/entity-dialogue-e2e.test.ts`

---

### Task 4: Attribution still works once the entity branch stops firing

**Files:**
- Modify: `server/src/analyzer/dialogue-structure/parser.test.ts`

- [ ] **Step 1: Add the test.**

Append to the `#2289` describe block:

```ts
  /* #2310 — once stripHtml decodes the entity, `dialogueOpen`'s entity branch
     stops firing on freshly-parsed text and the `[-–—]` character-class branch
     carries the load instead. Pin that the handover is real, so the shims can
     be retained as pure back-compat rather than silently doing the work. */
  it('#2310: the DECODED dash still opens dialogue in es and fr', () => {
    expect(parseChapterStructure(stripHtml('<p>&ndash; Un momento.</p>'), esIdx)[0].kind)
      .toBe('dialogue');
    expect(parseChapterStructure(stripHtml('<p>&mdash; Un instant.</p>'), frIdx)[0].kind)
      .toBe('dialogue');
  });
```

Add `import { stripHtml } from '../../parsers/html-utils.js';` to the file's
imports.

**Verify:** `cd server && npx vitest run src/analyzer/dialogue-structure/parser.test.ts`

---

### Task 5: Correct the comment this change makes false

**Files:**
- Modify: `server/src/analyzer/dialogue-structure/parser.test.ts` (`:709-713`)
- Modify: `server/src/analyzer/dialogue-structure/lang/{es,fr,ru}.ts`

Not optional tidying — a stale comment here **re-arms the exact trap** that
shipped in #2289 and had to be corrected once already.

- [ ] **Step 1: Swap the `&hellip;` negative control's fixture.**

Its current comment claims *"`&hellip;` survives stripHtml so this control is
realistic end-to-end"*. After Task 2 that is **false** — `&hellip;` decodes.

**Swap the fixture, don't just relabel the test.** `decodeHTMLStrict` leaves
**unknown** named references literal (probed: `&zzz;` → `&zzz;`), so an unknown
entity restores the end-to-end realism that `&hellip;` loses:

```ts
  it('#2289: negative control — an unrelated entity (&zzz;) does not open dialogue', () => {
    /* Guards against an over-broad fix such as /^\s*(?:&\w+;|[-–—])\s*/iu,
       which would match any entity.

       #2310 swapped this fixture from `&hellip;` to `&zzz;`. `&hellip;` used to
       survive `stripHtml`, which is what made this control realistic body text;
       since #2310 the full named set decodes, so it no longer would. An
       UNKNOWN reference is left literal by `decodeHTMLStrict`, so `&zzz;` keeps
       the control realistic end-to-end rather than demoting it to a unit-level
       mutation guard. (`&nbsp;` was never a candidate — it was decoded even
       before #2310, which is the vacuous-fixture bug #2289 shipped and had to
       correct.) */
    const paras = parseChapterStructure('&zzz; Un momento — dijo él.', esIdx);
    expect(paras[0].kind).toBe('narration');
  });
```

- [ ] **Step 2: Record why the `dialogueOpen` entity alternatives are retained.**

In each of `lang/es.ts`, `lang/fr.ts`, `lang/ru.ts`, replace the `#2289` comment
above `dialogueOpen` (`ru.ts` has none — add one):

```ts
  /* #2289 / #2310 — the entity alternatives are RETAINED, not redundant.
     Since #2310 `stripHtml` decodes the full named set, so freshly-parsed text
     reaches here with a real dash and the `[-–—]` branch does the work. But
     `state.json` bodies persisted BEFORE #2310 still carry the literal entity
     and are not always re-parsed, and dropping these alternatives would regress
     dialogue ATTRIBUTION for those books — strictly worse than the
     mispronunciation #2310 fixed. Removing them needs a persisted-body
     migration audit first. Same reasoning covers the `DASH` constants in
     dialogue-structure/{parser,legibility}.ts and aligner.ts's 7-char atom. */
```

**Verify:** `cd server && npx vitest run src/analyzer/` — green.

---

### Task 6: Strip U+00AD, newly reachable from EPUB

A chore **this change makes owed** (spec Finding 6c), not a pre-existing one.

**Files:**
- Modify: `server/src/tts/text-normalize.ts:76`
- Modify: `server/src/tts/text-normalize.test.ts`

`&shy;` now decodes to U+00AD SOFT HYPHEN. Measured: U+00AD matches **neither**
`ZERO_WIDTH_AND_BIDI` (U+200B–U+200F, U+202A–U+202E, U+2060, U+FEFF) **nor**
`CONTROL_CHARS` (U+0000–U+001F, U+007F–U+009F), and **is not matched by `\s`**,
so it survives `stripAudioTags`' whitespace collapse and reaches the engine.
(`&thinsp;` → U+2009 needs nothing — `\s` matches it and it collapses.)

Decoding is still a clear improvement over the status quo, where `&shy;` was
spoken as "ampersand s h y semicolon". This closes the remaining gap.

- [ ] **Step 1: Write the failing test.**

```ts
it('#2310: strips U+00AD soft hyphen (reachable from EPUB &shy; since #2310)', () => {
  expect(stripUnsafeForTts('soft\u00adhyphen')).toBe('softhyphen');
});
```

- [ ] **Step 2: Add `\u00AD` to `ZERO_WIDTH_AND_BIDI`.**

```ts
/* … existing codepoint list …
   - U+00AD SOFT HYPHEN — invisible in HTML, no audio mapping. Reachable from
     EPUB since #2310 taught stripHtml to decode `&shy;`; it matches neither
     CONTROL_CHARS nor `\s`, so nothing else would remove it. */
const ZERO_WIDTH_AND_BIDI = new RegExp(
  '[\\u00AD\\u200B-\\u200F\\u202A-\\u202E\\u2060\\uFEFF]',
  'g',
);
```

**Verify:** `cd server && npx vitest run src/tts/text-normalize.test.ts`

---

### Task 7: The third entity decoder — `epub.ts` metadata and NCX labels

Spec Finding 4. `epub.ts:499`'s `decodeEntities` claims **"matches stripHtml"**
and does not: it has no general numeric decoding, so `&#x27;` — the exact hex
apostrophe the Coalfall regression (`a4a9877b`) fixed in `stripHtml` — is still
literal here. It decodes OPF **book title, author and series** *and* — a detail
an earlier draft of this plan missed — the **NCX chapter labels at `:430`**,
which become chapter titles and are therefore on the spoken, model-independent
path alongside Task 2b. The comment is already false today.

**Files:**
- Modify: `server/src/parsers/epub.ts:499-510`
- Modify: `server/src/parsers/epub.test.ts`

- [ ] **Step 1: Write the failing tests.**

```ts
it('#2310: decodeEntities decodes the full named set (titles carry them too)', () => {
  expect(decodeEntities('L&rsquo;&Eacute;t&eacute; &mdash; Tome I')).toBe('L’Été — Tome I');
});
it('#2310: decodeEntities decodes hex numeric refs (the Coalfall gap, never fixed here)', () => {
  expect(decodeEntities('Oduvan&#x27;s Forge')).toBe("Oduvan's Forge");
});
it('#2310: decodeEntities leaves a bare ampersand alone', () => {
  expect(decodeEntities('Smith &amp; Sons, AT&T')).toBe('Smith & Sons, AT&T');
});
```
- [ ] **Step 2: Implement** with the **same shared helper** Task 2 created — do
not write a third copy of the decode:

```ts
/** Decode entities in OPF metadata (title / author / series) and NCX chapter
    labels. Shares `stripHtml`'s decode rules BY CONSTRUCTION, via
    `decodeNamedEntities` — the previous hand-rolled copy claimed to "match
    stripHtml" and had already drifted (no numeric support at all, so the hex
    apostrophe from the Coalfall regression stayed literal in titles long after
    `stripHtml` was fixed). Three copies of one list is what produced #2310;
    there is now one. */
export function decodeEntities(s: string): string {
  return decodeNumericEntities(decodeNamedEntities(s)).trim();
}
```

Import `decodeNamedEntities` and `decodeNumericEntities` from `./html-utils.js`.
**The two existing double-unescape tests must stay green unedited** — verified
by probe: `&amp;lt;` → `&lt;` and `&amp;amp;lt;` → `&amp;lt;` both hold.

**Verify:** `cd server && npx vitest run src/parsers/`

---

### Task 8: Regression plan, register, notes

- [ ] **Step 1: Release notes** — append to `docs/release-notes-next.md`
  (technical, PR-refed) and a brand-voice line to the in-progress section of
  `RELEASE_NOTES.md`. This is user-visible: dialogue in EPUBs that used named
  entities stops being read as gibberish.

- [ ] **Step 2: On-box acceptance.** The *text* change is fully proved by Tasks
  2–7 in CI. What is **not** provable there is that a real EPUB with named
  entities produces clean audio end-to-end. Add a row to
  `docs/testing/onbox-acceptance-register.md` and update **all three surfaces**
  per CLAUDE.md's before-shipping step 3, including
  `onbox-acceptance-register-live-view.html` published to the URL already
  recorded in the register header. Run
  `npm run check:onbox-register -- --against-published <saved copy>` immediately
  before publishing.

  **Lead with the chapter-title beat — it is the only criterion that cannot be
  masked by model behaviour** (spec Finding 0). Observe, on an EPUB whose
  headings carry named entities (`<h1>L&rsquo;&Eacute;t&eacute;</h1>`): the
  spoken title beat says "L'Été" and contains **no** "ampersand … semicolon".

  Then, secondarily: a Spanish or French EPUB using `&mdash;`/`&ndash;`/accented
  entities in body text renders dialogue openers as a **pause**, with no spoken
  "ampersand" and no corrupted accented words, and the manuscript view shows
  real glyphs rather than entity text. **Record whether the body-line symptom
  reproduced at all before the fix** — if stage-2 strips leading dashes on the
  current model it may not have, which is a finding about the chain, not a
  failure of the fix.

- [ ] **Step 3:** PR body carries `Closes #2310`, and declares the incidental
  fixes (Tasks 5, 6, 7) under "Also fixed, found in passing".

**Verify:** `npm run verify:fast:branch`

---

## Task ordering

Task 1 → 2 → **2b** → 3 gets the acceptance criteria green. **2b is not
optional and not a follow-up**: it is the model-independent half of the same
defect, and without it the fix is unverifiable on the one path that reproduces
unconditionally.

4 and 5 protect the attribution seam and the fixture/comment that would
otherwise mislead the next reader. 6 and 7 are incidental findings this work
made owed — fixed in the same round per CLAUDE.md, not filed. 8 is the shipping
bookkeeping.

Tasks 6 and 7 are independent of 3–5 and may be dispatched in parallel. Task 7
depends on Task 2's shared helper existing.
