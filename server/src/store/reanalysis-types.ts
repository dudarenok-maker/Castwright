/* Shared types for the single re-analysis matcher (#4031, plan 291).
   Type-only and import-free by design: `cast-id-history.ts` must stay free to
   import these without a cycle, so nothing here may import from it. */

export type NotLinkedEntry = string | { bookId?: string; characterId: string };
export type SupersededKind = 'user' | 'heal' | 'analyzer';
export type HistoryStatus = 'ok' | 'absent' | 'degraded';
export interface FreshRow {
  id: string;
  name: string;
  aliases?: string[];
}
export type PriorRow = { id: string } & Record<string, unknown>;
/** A same-book "not the same person" record. `a` < `b`. */
export interface NotSamePersonRecord {
  a: string;
  b: string;
  at: string;
}
export interface MatchHistory {
  status: HistoryStatus;
  supersededBy: Readonly<Record<string, string>>;
  supersededByKind: Readonly<Record<string, SupersededKind>>;
  displaced: Readonly<Record<string, string>>;
  notSamePerson: ReadonlyArray<NotSamePersonRecord>;
}
export interface StoredSuggestion {
  sourceId: string;
  targetId: string;
  a: string;
  b: string;
  reason: string;
  origin: 'plan' | 'dedup';
  newRow?: string;
  candidate?: string;
}
export type JoinTier = 'id' | 'history' | 'name' | 'surname' | 'narrator' | 'open-question' | 'merge';
export type MatchDecision =
  | { kind: 'join'; rawId: string; priorId: string; tier: JoinTier }
  | {
      kind: 'new';
      rawId: string;
      id: string;
      minted: boolean;
      suggest: string[];
      inheritedDeclines: NotLinkedEntry[];
    };
export interface MatchPlan {
  version: 1;
  runToken: string;
  decisions: Record<string, MatchDecision>;
}
export interface MatchInput {
  fresh: ReadonlyArray<FreshRow>;
  prior: ReadonlyArray<PriorRow>;
  history: MatchHistory;
  openSuggestions: ReadonlyArray<StoredSuggestion>;
  reservedIds: ReadonlySet<string>;
  runToken: string;
  currentBookId?: string;
}
/** Rule-11 ledger. `fp` = fingerprint of the job's LAST write of the row; disk ≠ fp before a write → `added-once` (sticky). */
export type LedgerEntry = { state: 'run-owned'; fp: string } | { state: 'added-once' };
export type RunAddedLedger = Record<string, LedgerEntry>;
export type PlannedRowInfo =
  | { kind: 'join'; priorId: string }
  | {
      kind: 'new';
      minted: boolean;
      candidates: readonly string[];
      inheritedDeclines: readonly NotLinkedEntry[];
      declinedIds: readonly string[];
      matchedFrom?: unknown;
    };
export interface DedupConstraints {
  planned: ReadonlyMap<string, PlannedRowInfo>;
  currentBookId?: string;
}
