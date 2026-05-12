/* Manual file-drop analyzer. Literal pass-through to the existing
   writeInbox + awaitOutbox flow so the human-in-the-loop fix-then-redrop
   path keeps working unchanged. */

import { writeInbox, awaitOutbox } from '../handoff/protocol.js';
import { stage1Schema, stage2Schema, type Stage1Output, type Stage2Output } from '../handoff/schemas.js';
import type { Analyzer, StageCall } from './index.js';

export class ManualAnalyzer implements Analyzer {
  async runStage1(manuscriptId: string, promptMd: string, call: StageCall): Promise<Stage1Output> {
    await writeInbox(manuscriptId, 1, promptMd);
    return awaitOutbox<Stage1Output>(manuscriptId, 1, stage1Schema, { onWaiting: call.onWaiting });
  }

  async runStage2(manuscriptId: string, promptMd: string, call: StageCall): Promise<Stage2Output> {
    await writeInbox(manuscriptId, 2, promptMd);
    return awaitOutbox<Stage2Output>(manuscriptId, 2, stage2Schema, { onWaiting: call.onWaiting });
  }
}
