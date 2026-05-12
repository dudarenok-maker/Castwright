/* Manual file-drop analyzer. Stage 2 is split per chapter so the user can
   work through long books incrementally — each chapter gets its own
   inbox/outbox file pair (mns_xyz-stage2-ch{n}.md|json). */

import { writeInbox, awaitOutbox } from '../handoff/protocol.js';
import {
  stage1Schema,
  stage2ChapterSchema,
  type Stage1Output,
  type Stage2ChapterOutput,
} from '../handoff/schemas.js';
import type { Analyzer, StageCall } from './index.js';

export class ManualAnalyzer implements Analyzer {
  async runStage1(manuscriptId: string, promptMd: string, call: StageCall): Promise<Stage1Output> {
    await writeInbox(manuscriptId, '1', promptMd);
    return awaitOutbox<Stage1Output>(manuscriptId, '1', stage1Schema, { onWaiting: call.onWaiting });
  }

  async runStage2Chapter(
    manuscriptId: string,
    chapterId: number,
    promptMd: string,
    call: StageCall,
  ): Promise<Stage2ChapterOutput> {
    const key = `2-ch${chapterId}` as const;
    await writeInbox(manuscriptId, key, promptMd);
    return awaitOutbox<Stage2ChapterOutput>(manuscriptId, key, stage2ChapterSchema, { onWaiting: call.onWaiting });
  }
}
