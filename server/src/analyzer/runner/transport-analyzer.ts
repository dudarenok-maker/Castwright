/* Implements the Analyzer interface once, over a StageRunner (#3084). The
   stage table is identical for every engine. */
import { stage2HandoffKey } from '../../handoff/protocol.js';
import {
  stage1Schema,
  stage1ChapterSchema,
  stage2ChapterSchema,
  emotionAnnotationSchema,
  scriptReviewSchema,
  stage3ChapterSchema,
  stage1GrammarSchema,
  stage1ChapterGrammarSchema,
  escalationSchema,
  nonStoryClassificationSchema,
  type Stage1Output,
  type Stage1ChapterOutput,
  type Stage2ChapterOutput,
  type EmotionAnnotationOutput,
  type ScriptReviewOutput,
  type Stage3ChapterOutput,
  type EscalationOutput,
  type NonStoryClassificationOutput,
} from '../../handoff/schemas.js';
import type { Analyzer, StageCall } from '../types.js';
import type { StageRunner } from './stage-runner.js';

export class TransportAnalyzer implements Analyzer {
  constructor(readonly runner: StageRunner) {}

  async runStage1(manuscriptId: string, promptMd: string, call: StageCall): Promise<Stage1Output> {
    return this.runner.runStage(
      { manuscriptId, key: '1', skillName: 'whole_book_stage1', promptMd, grammarSchema: stage1GrammarSchema, validationSchema: stage1Schema },
      call,
    );
  }

  async runStage1Chapter(manuscriptId: string, chapterId: number, promptMd: string, call: StageCall): Promise<Stage1ChapterOutput> {
    return this.runner.runStage(
      {
        manuscriptId,
        key: `1-ch${chapterId}` as const,
        skillName: 'per_chapter_stage1',
        promptMd,
        grammarSchema: stage1ChapterGrammarSchema,
        validationSchema: stage1ChapterSchema,
      },
      call,
    );
  }

  async runStage2Chapter(manuscriptId: string, chapterId: number, promptMd: string, call: StageCall): Promise<Stage2ChapterOutput> {
    return this.runner.runStage(
      {
        manuscriptId,
        key: stage2HandoffKey(chapterId, call.stage2CallSeq),
        skillName: 'per_chapter_stage2',
        promptMd,
        grammarSchema: stage2ChapterSchema,
        validationSchema: stage2ChapterSchema,
      },
      call,
    );
  }

  async runEmotionChapter(manuscriptId: string, chapterId: number, promptMd: string, call: StageCall): Promise<EmotionAnnotationOutput> {
    return this.runner.runStage(
      {
        manuscriptId,
        key: `emotion-ch${chapterId}` as const,
        skillName: 'emotion_annotation',
        promptMd,
        grammarSchema: emotionAnnotationSchema,
        validationSchema: emotionAnnotationSchema,
      },
      call,
    );
  }

  async runNonStoryClassification(
    manuscriptId: string,
    chapterId: number,
    promptMd: string,
    call: StageCall,
  ): Promise<NonStoryClassificationOutput> {
    return this.runner.runStage(
      {
        manuscriptId,
        key: `nonstory-ch${chapterId}` as const,
        skillName: 'non_story_classification',
        promptMd,
        grammarSchema: nonStoryClassificationSchema,
        validationSchema: nonStoryClassificationSchema,
      },
      call,
    );
  }

  async runScriptReviewChapter(manuscriptId: string, chapterId: number, promptMd: string, call: StageCall): Promise<ScriptReviewOutput> {
    return this.runner.runStage(
      {
        manuscriptId,
        key: `review-ch${chapterId}` as const,
        skillName: 'script_review',
        promptMd,
        grammarSchema: scriptReviewSchema,
        validationSchema: scriptReviewSchema,
      },
      call,
    );
  }

  async runStage3Chapter(manuscriptId: string, chapterId: number, promptMd: string, call: StageCall): Promise<Stage3ChapterOutput> {
    return this.runner.runStage(
      {
        manuscriptId,
        key: `instruct-ch${chapterId}` as const,
        skillName: 'instruct_annotation',
        promptMd,
        grammarSchema: stage3ChapterSchema,
        validationSchema: stage3ChapterSchema,
      },
      call,
    );
  }

  async runAttributionEscalation(
    manuscriptId: string,
    chapterId: number,
    windowIndex: number,
    prompt: string,
    call: StageCall,
  ): Promise<EscalationOutput | null> {
    return this.runner.runSingleAttempt(
      {
        manuscriptId,
        key: `escalation-ch${chapterId}-w${windowIndex}` as const,
        promptMd: prompt,
        grammarSchema: escalationSchema,
        validationSchema: escalationSchema,
      },
      call,
    );
  }
}
