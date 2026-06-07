#!/usr/bin/env node
/*
 * diff-analysis-ab.mjs — A/B diff for the analyzer prompt clean
 * ============================================================================
 *
 * READ-ONLY. Compares two snapshot directories of analyzer output (a BASELINE
 * captured on `main` with the old cowork-framed prompts, and a CANDIDATE
 * captured on the branch with the cleaned prompts) and reports whether the
 * prompt reword is behaviourally inert. It NEVER writes files and NEVER runs
 * the analyzer / a model — it only diffs already-captured JSON.
 *
 * It powers the Verification §6 noise-floor A/B in the
 * "retire the manual analyzer path" change (plan: retire-manual-analyzer).
 *
 * Each snapshot dir is expected to hold the per-chapter analyzer artifacts and
 * the book cast for one analysis run, e.g.:
 *     {mns}-stage1-ch1.json   (Phase 0a per-chapter cast detection)
 *     {mns}-stage2-ch1.json   (Phase 1 per-chapter sentence attribution)
 *     cast.json               (the book's .audiobook/cast.json)
 *
 * The captured snapshots contain VERBATIM quote evidence from a copyrighted
 * book — keep them OUTSIDE the repo (e.g. %TEMP%\manual-ab\...) and never
 * commit them. This script takes the two dirs via args/env so the location is
 * free.
 *
 * Usage (schema validation needs the server TS schemas, so run via tsx):
 *     npx tsx scripts/diff-analysis-ab.mjs <baselineDir> <candidateDir>
 *     BASELINE_DIR=... CANDIDATE_DIR=... npx tsx scripts/diff-analysis-ab.mjs
 *
 * Flags:
 *     --json     emit the machine-readable report object instead of the
 *                human-readable summary
 *     --no-schema  skip the Zod schema-validity check (lets the pure diff run
 *                under plain `node` without tsx; the §6 hard gate needs it ON)
 *
 * Acceptance (read off the printed summary, per Verification §6d):
 *   - JSON valid on both sides — HARD gate.
 *   - Deterministic engine (Ollama temp 0 + seed): roster identical and
 *     per-sentence speaker agreement >= 99%.
 *   - Stochastic engine (Gemini): candidate-vs-baseline divergence <= the
 *     baseline-vs-baseline2 noise floor, with no systematic regression (no
 *     roster shrink, nothing newly collapsed to narrator, no wholesale emotion
 *     loss). Run the script twice (baseline-vs-baseline2, then
 *     candidate-vs-baseline) to read the noise floor.
 * ============================================================================
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';

/* ── Pure helpers (exported for the colocated unit test; no I/O, no TS imports
   so the test can import them under plain `node --test`) ──────────────────── */

/** Normalise an emotion value — absent / null renders the same as 'neutral'. */
export function normEmotion(emotion) {
  return emotion == null || emotion === '' ? 'neutral' : emotion;
}

/** Stable string key for an array-ish field so order-insensitive arrays still
    compare equal (aliases, fromBookTitles). Non-arrays stringify as-is. */
function fieldKey(value) {
  if (Array.isArray(value)) return JSON.stringify([...value].map(String).sort());
  if (value == null) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Pull the comparable cross-book identity fields off a character, defensively
    (cast.json carries more than the stage-1 character shape). */
function identityFields(c) {
  return {
    name: c.name ?? '',
    aliases: c.aliases ?? [],
    voiceId: c.voiceId ?? c.overrideTtsVoice ?? c.overrideTtsVoices ?? null,
    fromBook: c.fromBookTitles ?? c.matchedFrom?.bookTitle ?? null,
  };
}

/**
 * Diff two character rosters keyed by `id`.
 * @returns {{ added: string[], removed: string[], renamed: Array<{id,from,to}>,
 *   fieldDeltas: Array<{id, field, from, to}>, baseCount: number, candCount: number }}
 */
export function diffRosters(baseChars, candChars) {
  const base = new Map((baseChars ?? []).map((c) => [c.id, c]));
  const cand = new Map((candChars ?? []).map((c) => [c.id, c]));

  const added = [...cand.keys()].filter((id) => !base.has(id)).sort();
  const removed = [...base.keys()].filter((id) => !cand.has(id)).sort();
  const renamed = [];
  const fieldDeltas = [];

  for (const id of [...base.keys()].filter((id) => cand.has(id)).sort()) {
    const a = identityFields(base.get(id));
    const b = identityFields(cand.get(id));
    if (a.name !== b.name) renamed.push({ id, from: a.name, to: b.name });
    for (const field of ['aliases', 'voiceId', 'fromBook']) {
      if (fieldKey(a[field]) !== fieldKey(b[field])) {
        fieldDeltas.push({ id, field, from: a[field], to: b[field] });
      }
    }
  }

  return {
    added,
    removed,
    renamed,
    fieldDeltas,
    baseCount: base.size,
    candCount: cand.size,
  };
}

/** Total evidence-quote count across a roster (for the dropped-quote delta). */
export function quoteCount(chars) {
  return (chars ?? []).reduce((n, c) => n + (Array.isArray(c.evidence) ? c.evidence.length : 0), 0);
}

/**
 * Per-chapter, position-aligned agreement on a sentence field. Sentences are
 * grouped by `chapterId`, ordered by `id`, then compared ordinally up to the
 * shorter side (sentence SPLITTING can differ between runs, so we align by
 * index within a chapter rather than by sentence id).
 * @param {(s)=>any} pick — selects the field to compare (characterId / emotion)
 * @returns {{ total: number, agreed: number, rate: number,
 *   perChapter: Record<number, {total,agreed,rate}> }}
 */
export function fieldAgreement(baseSentences, candSentences, pick) {
  const byChapter = (sents) => {
    const m = new Map();
    for (const s of sents ?? []) {
      if (!m.has(s.chapterId)) m.set(s.chapterId, []);
      m.get(s.chapterId).push(s);
    }
    for (const arr of m.values()) arr.sort((x, y) => x.id - y.id);
    return m;
  };
  const baseM = byChapter(baseSentences);
  const candM = byChapter(candSentences);

  let total = 0;
  let agreed = 0;
  const perChapter = {};
  const chapters = new Set([...baseM.keys(), ...candM.keys()]);
  for (const ch of [...chapters].sort((a, b) => a - b)) {
    const a = baseM.get(ch) ?? [];
    const b = candM.get(ch) ?? [];
    const n = Math.min(a.length, b.length);
    let cAgreed = 0;
    for (let i = 0; i < n; i++) if (pick(a[i]) === pick(b[i])) cAgreed++;
    perChapter[ch] = { total: n, agreed: cAgreed, rate: n === 0 ? 1 : cAgreed / n };
    total += n;
    agreed += cAgreed;
  }
  return { total, agreed, rate: total === 0 ? 1 : agreed / total, perChapter };
}

export function speakerAgreement(baseSentences, candSentences) {
  return fieldAgreement(baseSentences, candSentences, (s) => s.characterId);
}

export function emotionAgreement(baseSentences, candSentences) {
  return fieldAgreement(baseSentences, candSentences, (s) => normEmotion(s.emotion));
}

/** Count how many sentences moved TO `narrator` from a non-narrator speaker
    (systematic-regression signal: prompt edit collapsing speech to narration). */
export function newlyNarrator(baseSentences, candSentences) {
  const { perChapter: _p } = speakerAgreement(baseSentences, candSentences);
  void _p;
  // Re-align the same way, count base!=narrator -> cand==narrator.
  const byChapter = (sents) => {
    const m = new Map();
    for (const s of sents ?? []) {
      if (!m.has(s.chapterId)) m.set(s.chapterId, []);
      m.get(s.chapterId).push(s);
    }
    for (const arr of m.values()) arr.sort((x, y) => x.id - y.id);
    return m;
  };
  const baseM = byChapter(baseSentences);
  const candM = byChapter(candSentences);
  let count = 0;
  for (const ch of baseM.keys()) {
    const a = baseM.get(ch) ?? [];
    const b = candM.get(ch) ?? [];
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      if (a[i].characterId !== 'narrator' && b[i].characterId === 'narrator') count++;
    }
  }
  return count;
}

/* ── Snapshot loading + classification (CLI side) ─────────────────────────── */

/** Classify a snapshot filename to the schema name + role it should validate
    against. Returns null for files we don't recognise (ignored). */
export function classifySnapshotFile(filename) {
  const f = basename(filename).toLowerCase();
  if (f === 'cast.json') return { role: 'cast', schema: 'cast' };
  if (/stage1.*-ch\d+\.json$/.test(f)) return { role: 'stage1', schema: 'stage1ChapterSchema' };
  if (/stage1.*\.json$/.test(f)) return { role: 'stage1', schema: 'stage1Schema' };
  if (/stage2.*-ch\d+\.json$/.test(f)) return { role: 'stage2', schema: 'stage2ChapterSchema' };
  if (/stage2.*\.json$/.test(f)) return { role: 'stage2', schema: 'stage2Schema' };
  return null;
}

function loadSnapshotDir(dir) {
  const entries = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.json'));
  const files = [];
  const chars = []; // unioned roster (cast.json wins; else stage1 chapters)
  let castSeen = false;
  const sentences = [];
  for (const name of entries.sort()) {
    const cls = classifySnapshotFile(name);
    if (!cls) continue;
    const full = join(dir, name);
    if (!statSync(full).isFile()) continue;
    let json;
    try {
      json = JSON.parse(readFileSync(full, 'utf8'));
    } catch (err) {
      files.push({ name, cls, parseError: String(err?.message ?? err) });
      continue;
    }
    files.push({ name, cls, json });
    if (cls.role === 'cast') {
      castSeen = true;
      const list = Array.isArray(json) ? json : (json.characters ?? []);
      chars.length = 0;
      chars.push(...list);
    } else if (cls.role === 'stage1' && !castSeen) {
      for (const c of json.characters ?? []) {
        if (!chars.some((x) => x.id === c.id)) chars.push(c);
      }
    } else if (cls.role === 'stage2') {
      sentences.push(...(json.sentences ?? []));
    }
  }
  return { dir, files, chars, sentences };
}

/** Validate every snapshot file against its Zod schema. Dynamic-imports the
    server schemas (TS — needs tsx). Returns { ok, results[] }. */
async function validateSchemas(snapshot) {
  const schemas = await import('../server/src/handoff/schemas.js').catch(() =>
    import('../server/src/handoff/schemas.ts'),
  );
  const castArray = schemas.characterSchema.array();
  const pick = (name) => (name === 'cast' ? castArray : schemas[name]);
  const results = [];
  let ok = true;
  for (const file of snapshot.files) {
    if (file.parseError) {
      ok = false;
      results.push({ name: file.name, valid: false, error: `JSON parse: ${file.parseError}` });
      continue;
    }
    const schema = pick(file.cls.schema);
    const target =
      file.cls.role === 'cast' && !Array.isArray(file.json)
        ? (file.json.characters ?? [])
        : file.json;
    const r = schema.safeParse(target);
    if (!r.success) ok = false;
    results.push({
      name: file.name,
      valid: r.success,
      error: r.success ? null : r.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    });
  }
  return { ok, results };
}

function pct(rate) {
  return `${(rate * 100).toFixed(2)}%`;
}

async function main(argv) {
  const args = argv.filter((a) => !a.startsWith('--'));
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const baselineDir = args[0] ?? process.env.BASELINE_DIR;
  const candidateDir = args[1] ?? process.env.CANDIDATE_DIR;

  if (!baselineDir || !candidateDir) {
    process.stderr.write(
      'usage: npx tsx scripts/diff-analysis-ab.mjs <baselineDir> <candidateDir>\n' +
        '   or: BASELINE_DIR=... CANDIDATE_DIR=... npx tsx scripts/diff-analysis-ab.mjs\n',
    );
    process.exit(2);
  }

  const base = loadSnapshotDir(baselineDir);
  const cand = loadSnapshotDir(candidateDir);

  const roster = diffRosters(base.chars, cand.chars);
  const speaker = speakerAgreement(base.sentences, cand.sentences);
  const emotion = emotionAgreement(base.sentences, cand.sentences);
  const collapsedToNarrator = newlyNarrator(base.sentences, cand.sentences);
  const droppedQuotes = quoteCount(base.chars) - quoteCount(cand.chars);

  let schema = { ok: null, results: [], skipped: true };
  if (!flags.has('--no-schema')) {
    try {
      const b = await validateSchemas(base);
      const c = await validateSchemas(cand);
      schema = { ok: b.ok && c.ok, baseline: b.results, candidate: c.results, skipped: false };
    } catch (err) {
      schema = {
        ok: null,
        skipped: true,
        error: `schema validation unavailable (run via tsx): ${String(err?.message ?? err)}`,
      };
    }
  }

  const report = {
    baselineDir,
    candidateDir,
    roster,
    speakerAgreement: { rate: speaker.rate, total: speaker.total, perChapter: speaker.perChapter },
    emotionAgreement: { rate: emotion.rate, total: emotion.total },
    collapsedToNarrator,
    droppedQuotes,
    counts: {
      baseChars: base.chars.length,
      candChars: cand.chars.length,
      baseSentences: base.sentences.length,
      candSentences: cand.sentences.length,
    },
    schema,
  };

  if (flags.has('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  const L = [];
  L.push('Analyzer A/B diff (read-only — no analyzer run, no files written)');
  L.push(`  baseline : ${baselineDir}`);
  L.push(`  candidate: ${candidateDir}`);
  L.push('');
  L.push('Roster:');
  L.push(`  characters: ${roster.baseCount} -> ${roster.candCount}`);
  L.push(`  added   : ${roster.added.length ? roster.added.join(', ') : '(none)'}`);
  L.push(`  removed : ${roster.removed.length ? roster.removed.join(', ') : '(none)'}`);
  L.push(`  renamed : ${roster.renamed.length ? roster.renamed.map((r) => `${r.id} "${r.from}"->"${r.to}"`).join(', ') : '(none)'}`);
  L.push(`  field deltas (alias/voiceId/fromBook): ${roster.fieldDeltas.length}`);
  for (const d of roster.fieldDeltas) L.push(`      ${d.id}.${d.field}: ${fieldKey(d.from)} -> ${fieldKey(d.to)}`);
  L.push('');
  L.push('Attribution:');
  L.push(`  per-sentence speaker agreement: ${pct(speaker.rate)} (${speaker.agreed ?? Math.round(speaker.rate * speaker.total)}/${speaker.total} aligned)`);
  L.push(`  per-sentence emotion agreement: ${pct(emotion.rate)} (${emotion.total} aligned)`);
  L.push(`  sentences collapsed to narrator (base!=narrator -> cand==narrator): ${collapsedToNarrator}`);
  L.push(`  dropped evidence quotes (base - cand): ${droppedQuotes}`);
  L.push(`  sentences: ${report.counts.baseSentences} -> ${report.counts.candSentences}`);
  const perCh = Object.entries(speaker.perChapter);
  if (perCh.length) {
    L.push('  per-chapter speaker agreement:');
    for (const [ch, v] of perCh) L.push(`      ch${ch}: ${pct(v.rate)} (${v.agreed}/${v.total})`);
  }
  L.push('');
  L.push('Schema validity:');
  if (schema.skipped) {
    L.push(`  SKIPPED — ${schema.error ?? '--no-schema'}`);
  } else {
    L.push(`  HARD GATE: ${schema.ok ? 'PASS (all snapshot files valid on both sides)' : 'FAIL'}`);
    for (const side of ['baseline', 'candidate']) {
      for (const r of schema[side] ?? []) {
        if (!r.valid) L.push(`      ${side}/${r.name}: ${r.error}`);
      }
    }
  }
  L.push('');
  L.push('Interpretation: deterministic engine wants roster identical + speaker agreement >= 99%.');
  L.push('Stochastic engine: compare this divergence against a baseline-vs-baseline2 run (the noise');
  L.push('floor) and confirm no systematic regression (roster shrink / narrator collapse / emotion loss).');
  process.stdout.write(`${L.join('\n')}\n`);
}

/* Only run the CLI when invoked directly — importing the pure helpers (the
   colocated unit test) must not trigger argument parsing or the TS import. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`diff-analysis-ab: ${String(err?.stack ?? err)}\n`);
    process.exit(1);
  });
}
