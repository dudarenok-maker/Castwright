import { describe, it, expect } from 'vitest';
import {
  AnalysisAbortedError,
  AnalyzerHttpError,
  AnalyzerTruncatedError,
  AnalyzerUnreachableError,
  LocalUnreachableError,
} from './errors.js';
import * as ollama from './ollama.js';
import { classifyAnalysisFailure } from '../routes/failure-taxonomy.js';

describe('analyzer error taxonomy (#3084 wave 1)', () => {
  it('LocalUnreachableError is an AnalyzerUnreachableError that keeps its name, code, message and cause', () => {
    const cause = new Error('inner');
    const err = new LocalUnreachableError('Ollama at u is unreachable (ECONNREFUSED).', cause);
    expect(err).toBeInstanceOf(AnalyzerUnreachableError);
    expect(err.name).toBe('LocalUnreachableError');
    expect(err.code).toBe('LOCAL_UNREACHABLE');
    expect(err.transport).toBe('ollama');
    expect(err.cause).toBe(cause);
    expect(err.message).toBe('Ollama at u is unreachable (ECONNREFUSED).');
  });

  it('a bare AnalyzerUnreachableError carries its transport and the generic code', () => {
    const err = new AnalyzerUnreachableError('endpoint down', 'openai');
    expect(err.name).toBe('AnalyzerUnreachableError');
    expect(err.code).toBe('ANALYZER_UNREACHABLE');
    expect(err.transport).toBe('openai');
  });

  it('ollama.js re-exports the SAME class objects, so existing importers keep working', () => {
    expect(ollama.AnalysisAbortedError).toBe(AnalysisAbortedError);
    expect(ollama.LocalUnreachableError).toBe(LocalUnreachableError);
  });

  it('AnalysisAbortedError keeps its name and code', () => {
    const err = new AnalysisAbortedError('x');
    expect(err.name).toBe('AnalysisAbortedError');
    expect(err.code).toBe('ANALYSIS_ABORTED');
  });

  it('AnalyzerHttpError exposes httpStatus/bodyExcerpt/transport and has NO status property', () => {
    const err = new AnalyzerHttpError('ollama', 503, 'busy', 'Ollama http://h returned 503 Service Unavailable: busy');
    expect(err.name).toBe('AnalyzerHttpError');
    expect(err.transport).toBe('ollama');
    expect(err.httpStatus).toBe(503);
    expect(err.bodyExcerpt).toBe('busy');
    expect('status' in err).toBe(false);
  });

  it.each([400, 404, 500, 503])('AnalyzerHttpError %i classifies exactly like the plain Error it replaces', (status) => {
    const message = `Ollama http://localhost:11434 returned ${status} X: {"error":"boom"}`;
    const typed = classifyAnalysisFailure(
      new AnalyzerHttpError('ollama', status, '{"error":"boom"}', message),
      'Ollama (m)',
    );
    const plain = classifyAnalysisFailure(new Error(message), 'Ollama (m)');
    expect(typed).toEqual(plain);
  });

  it('AnalyzerTruncatedError accepts every TransportKind', () => {
    expect(new AnalyzerTruncatedError('openai', 'length', 10).message).toMatch(/^openai output truncated/);
  });
});
