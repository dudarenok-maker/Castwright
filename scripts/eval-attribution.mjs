#!/usr/bin/env node
/**
 * eval-attribution.mjs — Score a non-English analysis cast.json against a
 * known ground-truth cast to quantify attribution quality.
 *
 * Usage:
 *   node scripts/eval-attribution.mjs <path-to-cast.json> [<path-to-ground-truth.json>]
 *   node scripts/eval-attribution.mjs <path-to-cast.json> [--min-recall <0-1>]
 *
 * Exits 0 on PASS, 1 on FAIL (recall below threshold).
 * Pure I/O wrapper around the exported scoreAttribution() function.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_GROUND_TRUTH = resolve(__dirname, 'lib', 'coalfall-ground-truth.json');
const DEFAULT_MIN_RECALL = 0.85;

// ── Pure helpers ──────────────────────────────────────────────────────────────

/**
 * Extract a line count from a character entry.
 * Handles: lineCount (number), lines (number), lines (array).
 */
function extractLineCount(char) {
  if (typeof char.lineCount === 'number') return char.lineCount;
  if (typeof char.lines === 'number') return char.lines;
  if (Array.isArray(char.lines)) return char.lines.length;
  return 0;
}

/**
 * Normalise a name/alias for matching: lowercase, collapse whitespace.
 */
function norm(s) {
  return String(s).toLowerCase().trim().replace(/\s+/g, ' ');
}

/**
 * Build a lookup set of all normalised names+aliases for a ground-truth speaker.
 */
function gtNameSet(gtSpeaker) {
  const names = [gtSpeaker.name, ...(gtSpeaker.aliases ?? [])];
  return new Set(names.map(norm));
}

/**
 * Score an analysis cast.json against a ground-truth spec.
 *
 * @param {object} cast - Parsed cast.json object: { characters: [...] }
 * @param {object} groundTruth - Parsed ground-truth object (coalfall-ground-truth.json shape)
 * @param {object} [opts]
 * @param {number} [opts.minRecall=0.85] - Recall threshold for PASS/FAIL
 * @returns {object} result - Scoring result (see below)
 *
 * Returned shape:
 * {
 *   recall: number,          // 0-1
 *   recallFraction: string,  // "n/m"
 *   precision: number,       // 0-1 (1 = no spurious)
 *   precisionFraction: string,
 *   matched: [{ gtId, gtName, analysisName, lineCount, expectedLines, lineRange, lineShareOk }],
 *   missing: [{ gtId, gtName }],
 *   spurious: [string],       // analysis character names not in ground truth
 *   flags: {
 *     entitySplits: [{ gtId, parts: [string] }],
 *     missingExpected: [string],
 *     lineShareWarnings: [{ name, lineCount, expectedLines, lineRange }],
 *   },
 *   pass: boolean,
 *   minRecall: number,
 * }
 */
export function scoreAttribution(cast, groundTruth, opts = {}) {
  const minRecall = typeof opts.minRecall === 'number' ? opts.minRecall : DEFAULT_MIN_RECALL;
  const chars = cast.characters ?? [];
  const gtSpeakers = groundTruth.speakers ?? [];
  const allowedAnonymous = new Set(
    (groundTruth.allowedAnonymous ?? []).map(norm),
  );

  // ── Build a normalised index of the analysis cast ─────────────────────────
  // Each entry: { rawName, normName, lineCount, aliases: [] }
  const analysisEntries = chars.map((c) => ({
    rawName: c.name ?? c.id ?? '(unknown)',
    normName: norm(c.name ?? c.id ?? ''),
    lineCount: extractLineCount(c),
    aliases: (c.aliases ?? []).map(norm),
  }));

  // ── Match ground-truth speakers to analysis entries ───────────────────────
  const matched = [];
  const missing = [];
  const matchedAnalysisNorms = new Set();

  for (const gt of gtSpeakers) {
    const gtNames = gtNameSet(gt);
    // Try to find an analysis entry whose name or aliases overlap with the GT name set.
    const hit = analysisEntries.find((ae) => {
      if (gtNames.has(ae.normName)) return true;
      return ae.aliases.some((a) => gtNames.has(a));
    });

    if (hit) {
      matchedAnalysisNorms.add(hit.normName);
      const lineShareOk =
        hit.lineCount >= gt.lineRange[0] && hit.lineCount <= gt.lineRange[1];
      matched.push({
        gtId: gt.id,
        gtName: gt.name,
        analysisName: hit.rawName,
        lineCount: hit.lineCount,
        expectedLines: gt.expectedLines,
        lineRange: gt.lineRange,
        lineShareOk,
      });
    } else {
      missing.push({ gtId: gt.id, gtName: gt.name });
    }
  }

  // ── Spurious: analysis characters not in any GT entry and not allowed-anon ─
  const spurious = analysisEntries
    .filter((ae) => {
      if (matchedAnalysisNorms.has(ae.normName)) return false;
      if (allowedAnonymous.has(ae.normName)) return false;
      return true;
    })
    .map((ae) => ae.rawName);

  // ── Recall / Precision ────────────────────────────────────────────────────
  const recall = gtSpeakers.length > 0 ? matched.length / gtSpeakers.length : 1;
  const totalAnalysis = analysisEntries.filter(
    (ae) => !allowedAnonymous.has(ae.normName),
  ).length;
  const precision =
    totalAnalysis > 0
      ? (totalAnalysis - spurious.length) / totalAnalysis
      : 1;

  // ── Known-hazard flags ────────────────────────────────────────────────────

  // Entity-split detection: a GT speaker that has entitySplitAliases defined
  // is flagged if BOTH its canonical name AND at least one split-alias appear
  // as SEPARATE characters in the analysis.
  const entitySplits = [];
  for (const gt of gtSpeakers) {
    if (!gt.entitySplitAliases || gt.entitySplitAliases.length === 0) continue;
    const splitAliasNorms = new Set(gt.entitySplitAliases.map(norm));
    const canonNorm = norm(gt.name);
    const canonInAnalysis = analysisEntries.some((ae) => ae.normName === canonNorm);
    const aliasInAnalysis = analysisEntries.some((ae) => splitAliasNorms.has(ae.normName));
    if (canonInAnalysis && aliasInAnalysis) {
      const parts = analysisEntries
        .filter((ae) => ae.normName === canonNorm || splitAliasNorms.has(ae.normName))
        .map((ae) => ae.rawName);
      entitySplits.push({ gtId: gt.id, parts });
    }
  }

  // Missing expected: GT speakers that didn't match at all.
  const missingExpected = missing.map((m) => m.gtName);

  // Line-share warnings: matched speakers whose line count is outside [50%, 200%] of expected.
  const lineShareWarnings = matched.filter((m) => {
    if (m.expectedLines === 0) return false;
    const ratio = m.lineCount / m.expectedLines;
    return ratio < 0.5 || ratio > 2.0;
  }).map((m) => ({
    name: m.analysisName,
    lineCount: m.lineCount,
    expectedLines: m.expectedLines,
    lineRange: m.lineRange,
  }));

  return {
    recall,
    recallFraction: `${matched.length}/${gtSpeakers.length}`,
    precision,
    precisionFraction: `${totalAnalysis - spurious.length}/${totalAnalysis}`,
    matched,
    missing,
    spurious,
    flags: {
      entitySplits,
      missingExpected,
      lineShareWarnings,
    },
    pass: recall >= minRecall,
    minRecall,
  };
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function printReport(result, castPath) {
  const { recall, recallFraction, precision, precisionFraction, matched, missing, spurious, flags, pass, minRecall } = result;

  process.stdout.write(`\nAttribution Eval — ${castPath}\n`);
  process.stdout.write('═'.repeat(60) + '\n\n');

  // Matched speakers
  if (matched.length > 0) {
    process.stdout.write('Matched speakers:\n');
    for (const m of matched) {
      const shareLabel = m.lineShareOk ? 'OK' : `WARN (expected ~${m.expectedLines}, got ${m.lineCount})`;
      process.stdout.write(`  ✓ ${m.gtName} → "${m.analysisName}" (${m.lineCount} lines, ${shareLabel})\n`);
    }
    process.stdout.write('\n');
  }

  // Missing
  if (missing.length > 0) {
    process.stdout.write('Missing from analysis:\n');
    for (const m of missing) {
      process.stdout.write(`  ✗ ${m.gtName}\n`);
    }
    process.stdout.write('\n');
  }

  // Spurious
  if (spurious.length > 0) {
    process.stdout.write('Spurious (not in ground truth):\n');
    for (const s of spurious) {
      process.stdout.write(`  ! "${s}"\n`);
    }
    process.stdout.write('\n');
  }

  // Flags
  const hasFlags =
    flags.entitySplits.length > 0 ||
    flags.lineShareWarnings.length > 0;

  if (hasFlags) {
    process.stdout.write('Flags:\n');
    for (const es of flags.entitySplits) {
      process.stdout.write(`  [entity-split] "${es.gtId}": parts = ${es.parts.map((p) => `"${p}"`).join(' + ')}\n`);
    }
    for (const w of flags.lineShareWarnings) {
      process.stdout.write(
        `  [line-share] "${w.name}": ${w.lineCount} lines vs expected ~${w.expectedLines} (range ${w.lineRange[0]}–${w.lineRange[1]})\n`,
      );
    }
    process.stdout.write('\n');
  }

  // Summary line
  const flagSummary = [];
  if (flags.entitySplits.length > 0) flagSummary.push(`entity-split(${flags.entitySplits.length})`);
  if (flags.missingExpected.length > 0) flagSummary.push(`missing(${flags.missingExpected.length})`);
  if (flags.lineShareWarnings.length > 0) flagSummary.push(`line-share(${flags.lineShareWarnings.length})`);
  if (spurious.length > 0) flagSummary.push(`spurious(${spurious.length})`);

  const passLabel = pass ? 'PASS' : 'FAIL';
  process.stdout.write(
    `RECALL ${recallFraction} (${(recall * 100).toFixed(0)}%)  ` +
    `PRECISION ${precisionFraction} (${(precision * 100).toFixed(0)}%)  ` +
    `| flags: ${flagSummary.length > 0 ? flagSummary.join(', ') : 'none'}  ` +
    `→ ${passLabel} (threshold ${(minRecall * 100).toFixed(0)}%)\n`,
  );
}

function parseArgs(argv) {
  const positional = [];
  let minRecall = DEFAULT_MIN_RECALL;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--min-recall') {
      minRecall = parseFloat(argv[++i]);
      if (isNaN(minRecall) || minRecall < 0 || minRecall > 1) {
        process.stderr.write('--min-recall must be a number between 0 and 1\n');
        process.exit(1);
      }
    } else if (!a.startsWith('--')) {
      positional.push(a);
    }
  }
  return { positional, minRecall };
}

// Main guard — only execute when run directly.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const { positional, minRecall } = parseArgs(argv);

  if (positional.length === 0) {
    process.stderr.write('Usage: node scripts/eval-attribution.mjs <cast.json> [<ground-truth.json>] [--min-recall <0-1>]\n');
    process.exit(1);
  }

  const castPath = resolve(positional[0]);
  const gtPath = positional[1] ? resolve(positional[1]) : DEFAULT_GROUND_TRUTH;

  if (!existsSync(castPath)) {
    process.stderr.write(`cast.json not found: ${castPath}\n`);
    process.exit(1);
  }
  if (!existsSync(gtPath)) {
    process.stderr.write(`ground-truth not found: ${gtPath}\n`);
    process.exit(1);
  }

  let cast, groundTruth;
  try {
    cast = JSON.parse(readFileSync(castPath, 'utf8'));
  } catch (e) {
    process.stderr.write(`Failed to parse cast.json: ${e.message}\n`);
    process.exit(1);
  }
  try {
    groundTruth = JSON.parse(readFileSync(gtPath, 'utf8'));
  } catch (e) {
    process.stderr.write(`Failed to parse ground-truth: ${e.message}\n`);
    process.exit(1);
  }

  const result = scoreAttribution(cast, groundTruth, { minRecall });
  printReport(result, castPath);
  process.exit(result.pass ? 0 : 1);
}
