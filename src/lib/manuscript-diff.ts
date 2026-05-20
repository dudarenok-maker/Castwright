/* Sentence-level + char-level diff helpers for the manuscript re-upload
   diff modal (plan 74). Hand-rolled LCS — no npm dep — because the v1
   payload is small (typical manuscripts under 10k sentences) and a
   four-line dynamic-programming table is faster than dragging in a
   library + a tree-shake config tweak.

   Two public entry points:
     - splitIntoSentences(text): client-side sentence splitter used by the
       diff modal. NOT a substitute for the analyzer's authoritative
       splitter (which lives server-side); we only need an approximation
       sharp enough to surface changes the user can recognise. Anything
       sharper is a future Could.
     - diffManuscripts(oldText, newText) -> SentenceDiff[]: top-level diff.
     - charDiff(a, b) -> CharDiffSpan[]: per-replace inner highlight.

   Whitespace-only changes (extra blank lines between paragraphs, trailing
   spaces) round-trip as `equal` because the diff normalises before
   comparing — the user clicked "Replace manuscript" to see *meaningful*
   content changes, not whitespace noise. */

export type SentenceDiff =
  | { type: 'equal'; oldIdx: number; newIdx: number; oldText: string; newText: string }
  | { type: 'insert'; newIdx: number; newText: string }
  | { type: 'delete'; oldIdx: number; oldText: string }
  | {
      type: 'replace';
      oldIdx: number;
      newIdx: number;
      oldText: string;
      newText: string;
    };

export type CharDiffSpan = { type: 'equal' | 'add' | 'remove'; text: string };

/* Splits a manuscript into sentence-sized chunks. The server-side
   splitter is far smarter (handles markdown headings, dialogue, etc.)
   but for diff display we only need rough sentence boundaries. We
   keep blank lines as paragraph breaks (so insertions of full
   paragraphs surface as distinct entries) and split on terminal
   punctuation followed by whitespace.

   Empty pieces are dropped. Trailing whitespace on each piece is
   trimmed but the original punctuation is preserved (so "Hi.", "Hi!",
   and "Hi?" don't all collapse together). */
export function splitIntoSentences(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  /* Normalise CRLF / CR → LF and collapse trailing whitespace; we keep
     internal whitespace untouched so quoted passages with embedded
     newlines diff cleanly. */
  const normalised = text.replace(/\r\n?/g, '\n');
  /* Split per paragraph first (blank-line separated) so a fully-new
     paragraph stays adjacent in the output. */
  const paragraphs = normalised.split(/\n{2,}/);
  for (const para of paragraphs) {
    const trimmedPara = para.trim();
    if (!trimmedPara) continue;
    /* Within a paragraph, split on terminal punctuation followed by
       whitespace, optionally including the closing quote / paren.
       Lookbehind keeps the punctuation attached to the preceding
       sentence. */
    const parts = trimmedPara.split(/(?<=[.!?]["')\]]?)\s+(?=[A-Z"'([])/);
    for (const part of parts) {
      const t = part.trim();
      if (t) out.push(t);
    }
  }
  return out;
}

/* Comparison key: collapse internal whitespace so trailing spaces and
   double-spaces around punctuation don't surface as changes. The
   visible text retains the original whitespace; only the equality
   check is normalised. */
function normaliseForCompare(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/* Classic two-pointer LCS table over the sentences, then walk back to
   emit `equal / insert / delete / replace` entries. The replace fold
   collapses an adjacent (delete, insert) pair so the user sees one
   side-by-side row per logical edit rather than two stacked rows. */
function lcsTable(a: string[], b: string[]): number[][] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }
  return dp;
}

export function diffManuscripts(oldText: string, newText: string): SentenceDiff[] {
  const oldSents = splitIntoSentences(oldText);
  const newSents = splitIntoSentences(newText);
  return diffSentenceArrays(oldSents, newSents);
}

/* Diff two pre-split sentence arrays. Exported so the slice's
   `previewReuploadDiff` reducer can diff against the already-hydrated
   `s.sentences` (which the analyzer has authoritatively split) without
   round-tripping through our cheaper client splitter on the OLD side. */
export function diffSentenceArrays(oldSents: string[], newSents: string[]): SentenceDiff[] {
  const oldNorm = oldSents.map(normaliseForCompare);
  const newNorm = newSents.map(normaliseForCompare);
  const dp = lcsTable(oldNorm, newNorm);

  /* Backtrack to collect raw (equal / delete / insert) entries. */
  type Raw =
    | { type: 'equal'; oldIdx: number; newIdx: number }
    | { type: 'delete'; oldIdx: number }
    | { type: 'insert'; newIdx: number };
  const raw: Raw[] = [];
  let i = oldNorm.length;
  let j = newNorm.length;
  while (i > 0 && j > 0) {
    if (oldNorm[i - 1] === newNorm[j - 1]) {
      raw.push({ type: 'equal', oldIdx: i - 1, newIdx: j - 1 });
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      raw.push({ type: 'delete', oldIdx: i - 1 });
      i--;
    } else {
      raw.push({ type: 'insert', newIdx: j - 1 });
      j--;
    }
  }
  while (i > 0) {
    raw.push({ type: 'delete', oldIdx: i - 1 });
    i--;
  }
  while (j > 0) {
    raw.push({ type: 'insert', newIdx: j - 1 });
    j--;
  }
  raw.reverse();

  /* Fold runs of delete+insert into pairwise `replace` rows so the
     side-by-side renderer lines each edited sentence up on its own
     row. We pre-bucket the raw list into adjacent runs of the same
     type (mod equal): a stretch like [del, del, ins, ins, ins] folds
     into [replace, replace, insert] — each delete pairs with the
     same-position insert, with any trailing inserts surfacing as
     pure inserts (or trailing deletes as pure deletes when the new
     side runs out first). The LCS backtrack groups deletes together
     and inserts together so this bucketing is reliable. */
  const out: SentenceDiff[] = [];
  let k = 0;
  while (k < raw.length) {
    const cur = raw[k];
    if (cur.type === 'equal') {
      out.push({
        type: 'equal',
        oldIdx: cur.oldIdx,
        newIdx: cur.newIdx,
        oldText: oldSents[cur.oldIdx],
        newText: newSents[cur.newIdx],
      });
      k++;
      continue;
    }
    /* Gather the next run of non-equal entries — could be deletes,
       inserts, or a mix in either order. */
    const runStart = k;
    let runEnd = k;
    while (runEnd < raw.length && raw[runEnd].type !== 'equal') runEnd++;
    const deletes = raw
      .slice(runStart, runEnd)
      .filter((r): r is Extract<Raw, { type: 'delete' }> => r.type === 'delete');
    const inserts = raw
      .slice(runStart, runEnd)
      .filter((r): r is Extract<Raw, { type: 'insert' }> => r.type === 'insert');
    const pairCount = Math.min(deletes.length, inserts.length);
    for (let p = 0; p < pairCount; p++) {
      out.push({
        type: 'replace',
        oldIdx: deletes[p].oldIdx,
        newIdx: inserts[p].newIdx,
        oldText: oldSents[deletes[p].oldIdx],
        newText: newSents[inserts[p].newIdx],
      });
    }
    for (let p = pairCount; p < deletes.length; p++) {
      out.push({
        type: 'delete',
        oldIdx: deletes[p].oldIdx,
        oldText: oldSents[deletes[p].oldIdx],
      });
    }
    for (let p = pairCount; p < inserts.length; p++) {
      out.push({
        type: 'insert',
        newIdx: inserts[p].newIdx,
        newText: newSents[inserts[p].newIdx],
      });
    }
    k = runEnd;
  }
  return out;
}

/* Character-level inner diff for `replace` entries. Uses the same
   LCS approach as the sentence-level diff but operates on word
   tokens (with whitespace preserved) so the highlight tracks visible
   edits without staining every shared character. Returned spans
   concatenate verbatim to the input text on their respective side
   (equal + remove → oldText, equal + add → newText). */
export function charDiff(a: string, b: string): CharDiffSpan[] {
  if (a === b) return a ? [{ type: 'equal', text: a }] : [];
  /* Tokenise on word boundaries — keeps whitespace + punctuation as
     standalone tokens so we don't stain "tomorrow"/"today" as four
     character-level changes when it's one logical replacement. */
  const tokenise = (s: string): string[] => s.match(/\s+|[^\s]+/g) ?? [];
  const aTok = tokenise(a);
  const bTok = tokenise(b);
  const dp = lcsTable(aTok, bTok);

  type Raw =
    | { type: 'equal'; text: string }
    | { type: 'remove'; text: string }
    | { type: 'add'; text: string };
  const raw: Raw[] = [];
  let i = aTok.length;
  let j = bTok.length;
  while (i > 0 && j > 0) {
    if (aTok[i - 1] === bTok[j - 1]) {
      raw.push({ type: 'equal', text: aTok[i - 1] });
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      raw.push({ type: 'remove', text: aTok[i - 1] });
      i--;
    } else {
      raw.push({ type: 'add', text: bTok[j - 1] });
      j--;
    }
  }
  while (i > 0) {
    raw.push({ type: 'remove', text: aTok[i - 1] });
    i--;
  }
  while (j > 0) {
    raw.push({ type: 'add', text: bTok[j - 1] });
    j--;
  }
  raw.reverse();

  /* Merge consecutive same-type spans so the consumer renders one
     <span> per logical run rather than one per token. */
  const merged: CharDiffSpan[] = [];
  for (const r of raw) {
    const last = merged[merged.length - 1];
    if (last && last.type === r.type) {
      last.text += r.text;
    } else {
      merged.push({ ...r });
    }
  }
  return merged;
}

/* Summary counts for the modal header. Equal entries are dropped from
   the count — they're "unchanged" and the header would lie if it
   counted them. */
export interface DiffCounts {
  changed: number;
  added: number;
  removed: number;
}
export function summariseDiff(diff: SentenceDiff[]): DiffCounts {
  let changed = 0;
  let added = 0;
  let removed = 0;
  for (const d of diff) {
    if (d.type === 'replace') changed++;
    else if (d.type === 'insert') added++;
    else if (d.type === 'delete') removed++;
  }
  return { changed, added, removed };
}
