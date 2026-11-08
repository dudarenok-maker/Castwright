/* #4040 — dropStaleVariants / the rev stamps, on real sidecar json files. The
   route-level behaviour (GET, PUT, render, carryover, sweep) is pinned in
   routes/qwen-voice.linked-variant-reset.test.ts; this pins the helper's own
   edges: what an unreadable json decides, and the shape of what it returns. */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let workspaceRoot: string;
let mod: typeof import('./variant-base-rev.js');
const qwenDir = () => join(workspaceRoot, 'voices', 'qwen');
const json = (k: string) => join(qwenDir(), `${k}.json`);
const write = (k: string, v: unknown) => writeFileSync(json(k), typeof v === 'string' ? v : JSON.stringify(v));

const row = (variants: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}) => ({
  id: 'wren',
  voiceUuid: 'u1',
  overrideTtsVoices: { kokoro: { name: 'af_sky' }, qwen: { name: 'qwen-u1', ...(variants ? { variants } : {}) } },
  ...extra,
});
const variantsOf = (r: unknown) =>
  (r as { overrideTtsVoices: { qwen: { variants?: Record<string, unknown> } } }).overrideTtsVoices.qwen.variants;

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'castwright-variant-base-rev-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  mod = await import('./variant-base-rev.js');
});
beforeEach(() => {
  rmSync(qwenDir(), { recursive: true, force: true });
  mkdirSync(qwenDir(), { recursive: true });
});
afterAll(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

describe('#4040 — dropStaleVariants', () => {
  it('drops only the stale emotion, keeps the rest of the row, and returns an untouched row as the same object', async () => {
    write('qwen-u1', { rev: 'r2' });
    write('qwen-u1__angry', { baseRev: 'r1' });
    write('qwen-u1__sad', { baseRev: 'r2' });
    const stale = row({ angry: { name: 'qwen-u1__angry' }, sad: { name: 'qwen-u1__sad' } });
    const plain = row(undefined, { id: 'kit' });
    const [out, same] = await mod.dropStaleVariants([stale, plain]);
    expect(variantsOf(out)).toEqual({ sad: { name: 'qwen-u1__sad' } });
    expect((out as typeof stale).overrideTtsVoices.kokoro).toEqual({ name: 'af_sky' });
    expect(variantsOf(stale), 'the input row was mutated').toHaveProperty('angry');
    expect(same).toBe(plain);
  });

  it('an emptied map is removed, as the variant DELETE does', async () => {
    write('qwen-u1', { rev: 'r2' });
    const [out] = await mod.dropStaleVariants([row({ angry: { name: 'qwen-u1__angry' } })]);
    expect(variantsOf(out)).toBeUndefined();
    expect((out as { overrideTtsVoices: { qwen: { name: string } } }).overrideTtsVoices.qwen.name).toBe('qwen-u1');
  });

  it('an unreadable base json, or an unreadable variant json, keeps the variant', async () => {
    write('qwen-u1', '{"rev":');
    const r = row({ angry: { name: 'qwen-u1__angry' } });
    expect((await mod.dropStaleVariants([r]))[0]).toBe(r);
    write('qwen-u1', { rev: 'r2' });
    write('qwen-u1__angry', '{"baseRev":');
    expect((await mod.dropStaleVariants([r]))[0]).toBe(r);
  });

  it('a library-assigned slot derives its variants from qwen-<libraryUuid>, as the render does', async () => {
    write('qwen-lib1', { rev: 'r2' });
    write('qwen-u1', {});
    const r = {
      id: 'wren',
      voiceUuid: 'u1',
      overrideTtsVoices: { qwen: { name: 'qwen-lib1', libraryUuid: 'lib1', variants: { angry: { name: 'x' } } } },
    };
    expect(variantsOf((await mod.dropStaleVariants([r]))[0])).toBeUndefined();
  });
});

describe('#4040 — the rev stamps', () => {
  it('a redesign stamp keeps the json’s other fields and changes the rev every time', async () => {
    write('qwen-u1', { instruct: 'a bright voice' });
    await mod.stampBaseRedesign('qwen-u1');
    const first = JSON.parse(readFileSync(json('qwen-u1'), 'utf8'));
    expect(first.instruct).toBe('a bright voice');
    expect(first.rev).toEqual(expect.any(String));
    await mod.stampBaseRedesign('qwen-u1');
    expect(JSON.parse(readFileSync(json('qwen-u1'), 'utf8')).rev).not.toBe(first.rev);
    expect(await mod.readBaseRev('qwen-u1')).toBe(JSON.parse(readFileSync(json('qwen-u1'), 'utf8')).rev);
  });

  it('a variant stamp records the base rev, and an absent one removes a stale field', async () => {
    write('qwen-u1__angry', { instruct: 'furious', baseRev: 'old' });
    await mod.stampVariantBaseRev('qwen-u1__angry', 'r9');
    expect(JSON.parse(readFileSync(json('qwen-u1__angry'), 'utf8'))).toEqual({ instruct: 'furious', baseRev: 'r9' });
    await mod.stampVariantBaseRev('qwen-u1__angry', undefined);
    expect(JSON.parse(readFileSync(json('qwen-u1__angry'), 'utf8'))).toEqual({ instruct: 'furious' });
  });
});
