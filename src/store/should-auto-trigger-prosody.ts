import type { RootState } from './index';
import { selectAnalysisBusyForBook } from './analysis-substage-selectors';

/** Pure in-memory gate for the fs-65 auto-trigger: don't fire while any
    analysis sub-stage is already running for this book (manual button or a
    cross-tab broadcast). The disk `prosodyAnnotated` watermark remains the
    separate "already done" gate, checked async in the effect. */
export function shouldAutoTriggerProsody(state: RootState, bookId: string): boolean {
  return !selectAnalysisBusyForBook(state, bookId);
}
