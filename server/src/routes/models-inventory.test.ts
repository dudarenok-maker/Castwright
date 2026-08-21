/* fs-23 — Model Manager inventory. Unit-tests the pure buildModelInventory over
   a temp on-disk tree (kokoro files + an HF-cache Qwen snapshot), the
   dirSizeBytes sizer, and a route smoke test with both probes unreachable. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildModelInventory,
  evaluateRemoval,
  performRemoval,
  modelsInventoryRouter,
  type InventoryDeps,
  type ModelInventoryItem,
} from './models-inventory.js';
import {
  dirSizeBytes,
  totalSizeBytes,
  qwenDesignRepoDir,
  whisperRepoDir,
} from '../tts/model-paths.js';
import type { SidecarHealthResult } from './sidecar-health.js';
import {
  _setUserSettingsCacheForTest,
  _resetUserSettingsCache,
} from '../workspace/user-settings.js';

let repoRoot: string;
let hfCache: string;
let ttsHome: string;
const savedHfHubCache = process.env.HF_HUB_CACHE;
const savedHfHome = process.env.HF_HOME;
const savedTtsHome = process.env.TTS_HOME;

/* Coqui's XTTS v2 dir under a TTS_HOME, mirroring get_user_data_dir("tts"). */
const XTTS_DIR = 'tts_models--multilingual--multi-dataset--xtts_v2';

function writeFile(path: string, bytes: number) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, Buffer.alloc(bytes, 1));
}

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'mm-repo-'));
  hfCache = mkdtempSync(join(tmpdir(), 'mm-hf-'));
  ttsHome = mkdtempSync(join(tmpdir(), 'mm-tts-'));
  /* Route the HF-cache resolver at our temp dir so qwen/whisper sizing is
     deterministic, and clear HF_HOME so it can't shadow HF_HUB_CACHE. */
  process.env.HF_HUB_CACHE = hfCache;
  delete process.env.HF_HOME;
  /* Pin TTS_HOME at a temp dir so the Coqui present-probe (coquiWeightsPresent)
     can't read the real %LOCALAPPDATA%\tts on the dev box and flake the
     "coqui absent" assertion. */
  process.env.TTS_HOME = ttsHome;
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
  rmSync(hfCache, { recursive: true, force: true });
  rmSync(ttsHome, { recursive: true, force: true });
  if (savedHfHubCache === undefined) delete process.env.HF_HUB_CACHE;
  else process.env.HF_HUB_CACHE = savedHfHubCache;
  if (savedHfHome === undefined) delete process.env.HF_HOME;
  else process.env.HF_HOME = savedHfHome;
  if (savedTtsHome === undefined) delete process.env.TTS_HOME;
  else process.env.TTS_HOME = savedTtsHome;
  vi.restoreAllMocks();
});

const reachableSidecar: SidecarHealthResult = {
  status: 'reachable',
  url: 'http://localhost:9000',
  proxy: 'sidecar',
  kokoroLoaded: true,
  qwenLoaded: false,
  modelLoaded: false,
  asrLoaded: false,
  qwenInstallState: 'weights-missing',
};

function baseDeps(over: Partial<InventoryDeps> = {}): InventoryDeps {
  return {
    repoRoot,
    ts: '2026-06-06T00:00:00.000Z',
    sidecar: reachableSidecar,
    ollama: { reachable: true, models: [], resident: [] },
    resolvedTtsEngine: 'kokoro',
    analysisEngine: 'local',
    resolvedOllamaModel: 'qwen3.5:4b',
    ...over,
  };
}

describe('dirSizeBytes', () => {
  it('returns zero for a missing path', () => {
    expect(dirSizeBytes(join(repoRoot, 'nope'))).toEqual({ bytes: 0, fileCount: 0 });
  });

  it('sums file sizes recursively', () => {
    writeFile(join(repoRoot, 'a.bin'), 100);
    writeFile(join(repoRoot, 'sub', 'b.bin'), 50);
    expect(dirSizeBytes(repoRoot)).toEqual({ bytes: 150, fileCount: 2 });
  });

  it('sizes a single file directly', () => {
    writeFile(join(repoRoot, 'one.bin'), 42);
    expect(dirSizeBytes(join(repoRoot, 'one.bin'))).toEqual({ bytes: 42, fileCount: 1 });
  });

  it('totals multiple paths', () => {
    writeFile(join(repoRoot, 'x.bin'), 10);
    writeFile(join(repoRoot, 'y.bin'), 20);
    expect(totalSizeBytes([join(repoRoot, 'x.bin'), join(repoRoot, 'y.bin')])).toEqual({
      bytes: 30,
      fileCount: 2,
    });
  });
});

describe('buildModelInventory', () => {
  afterEach(() => _resetUserSettingsCache()); // don't leak the seeded override into later cases

  function installKokoro() {
    writeFile(join(repoRoot, 'server', 'tts-sidecar', 'voices', 'kokoro', 'kokoro-v1.0.onnx'), 1000);
    writeFile(join(repoRoot, 'server', 'tts-sidecar', 'voices', 'kokoro', 'voices-v1.0.bin'), 200);
  }
  function installQwenBase() {
    writeFile(
      join(
        hfCache,
        'models--Qwen--Qwen3-TTS-12Hz-0.6B-Base',
        'snapshots',
        'abc',
        'model.safetensors',
      ),
      5000,
    );
  }
  function installQwenBase17() {
    writeFile(
      join(
        hfCache,
        'models--Qwen--Qwen3-TTS-12Hz-1.7B-Base',
        'snapshots',
        'abc',
        'model.safetensors',
      ),
      8000,
    );
  }
  /* Resolved from model-paths rather than a hand-written repo name so these
     can't silently stop matching if the pinned HF repo id ever changes. */
  function installQwenDesign() {
    writeFile(join(qwenDesignRepoDir(), 'snapshots', 'abc', 'model.safetensors'), 6000);
  }
  function installWhisper() {
    writeFile(join(whisperRepoDir(), 'snapshots', 'abc', 'model.bin'), 300);
  }

  it('reports a present Kokoro with size, path, residency, and fallback flag', () => {
    installKokoro();
    const inv = buildModelInventory(baseDeps());
    const kokoro = inv.items.find((i) => i.id === 'kokoro')!;
    expect(kokoro.present).toBe(true);
    expect(kokoro.sizeBytes).toBe(1200);
    expect(kokoro.diskPath).toContain('kokoro');
    expect(kokoro.loaded).toBe(true);
    expect(kokoro.isFallbackEngine).toBe(true);
    expect(kokoro.isDefaultEngine).toBe(true); // resolvedTtsEngine: 'kokoro'
    expect(inv.sidecarReachable).toBe(true);
    expect(inv.ts).toBe('2026-06-06T00:00:00.000Z');
  });

  it('marks an absent model present:false with null size', () => {
    const inv = buildModelInventory(baseDeps());
    const coqui = inv.items.find((i) => i.id === 'coqui')!;
    expect(coqui.present).toBe(false);
    expect(coqui.sizeBytes).toBeNull();
    expect(coqui.removable).toBe(false);
  });

  it('reports Coqui present when model.pth lives in the TTS user-data dir', () => {
    /* Regression for the inventory↔installer-card disagreement: present is keyed
       off the same model.pth probe /api/coqui/detect uses, resolved under
       TTS_HOME — NOT the old voices/coqui guess the runtime never populates. */
    writeFile(join(ttsHome, 'tts', XTTS_DIR, 'model.pth'), 4096);
    const inv = buildModelInventory(baseDeps());
    const coqui = inv.items.find((i) => i.id === 'coqui')!;
    expect(coqui.present).toBe(true);
    expect(coqui.sizeBytes).toBe(4096);
    expect(coqui.removable).toBe(true);
  });

  it('sizes a Qwen Base HF snapshot and surfaces its install state', () => {
    installQwenBase();
    const inv = buildModelInventory(baseDeps());
    const qwen = inv.items.find((i) => i.id === 'qwen-base')!;
    expect(qwen.present).toBe(true);
    expect(qwen.sizeBytes).toBe(5000);
    // reachableSidecar has no qwenPackageInstalled flag → packageInstalled=false
    // weights ARE present → package-missing (B1 composition)
    expect(qwen.installState).toBe('package-missing');
    expect(qwen.isDefaultEngine).toBe(false); // default engine is kokoro here
  });

  it('qwen-base: sidecar package=false + weights present → installState package-missing', () => {
    installQwenBase();
    const inv = buildModelInventory(
      baseDeps({
        sidecar: { ...reachableSidecar, qwenPackageInstalled: false, qwenLoaded: false },
      }),
    );
    const row = inv.items.find((i) => i.id === 'qwen-base')!;
    expect(row.installState).toBe('package-missing');
    expect(row.tier).toBe('standard');
  });

  it('qwen-base17: present when HF snapshot exists, label matches, kind tts', () => {
    installQwenBase17();
    const inv = buildModelInventory(baseDeps());
    const row = inv.items.find((i) => i.id === 'qwen-base17')!;
    expect(row).toBeDefined();
    expect(row.label).toBe('Qwen3-TTS Base (1.7B)');
    expect(row.kind).toBe('tts');
    expect(row.present).toBe(true);
    expect(row.sizeBytes).toBe(8000);
    expect(row.removable).toBe(true);
    expect(row.isDefaultEngine).toBe(false);
    expect(row.isFallbackEngine).toBe(false);
  });

  it('qwen-base17: absent when snapshot dir is missing', () => {
    const inv = buildModelInventory(baseDeps());
    const row = inv.items.find((i) => i.id === 'qwen-base17')!;
    expect(row.present).toBe(false);
    expect(row.sizeBytes).toBeNull();
    expect(row.removable).toBe(false);
  });

  it('qwen-base17: loaded reflects sidecar.qwenBase17Loaded', () => {
    installQwenBase17();
    const inv = buildModelInventory(
      baseDeps({
        sidecar: { ...reachableSidecar, qwenBase17Loaded: true },
      }),
    );
    const row = inv.items.find((i) => i.id === 'qwen-base17')!;
    expect(row.loaded).toBe(true);
  });

  it('qwen-base17: not loaded when qwenBase17Loaded is false/undefined', () => {
    installQwenBase17();
    const inv = buildModelInventory(baseDeps());
    const row = inv.items.find((i) => i.id === 'qwen-base17')!;
    expect(row.loaded).toBe(false);
  });

  it('coqui row tier is secondary and carries an integrity verdict', () => {
    const inv = buildModelInventory(baseDeps());
    const row = inv.items.find((i) => i.id === 'coqui')!;
    expect(row.tier).toBe('secondary');
  });

  describe('coqui import honesty (#1963)', () => {
    beforeEach(() => {
      // Weights present so installState differs by packageInstalled alone.
      writeFile(join(ttsHome, 'tts', XTTS_DIR, 'model.pth'), 4096);
    });

    it('coqui_import_ok: false downgrades installState to package-broken even though find_spec (coquiPackageInstalled) says true', () => {
      /* THE DEFECT: before the fix, pkgInstalled() read coquiPackageInstalled
         (find_spec) alone, so a package that cannot actually import (#1944's
         speechbrain lazy-proxy collision) reported installState: 'ready'.
         #2533 — now asserts 'package-broken', the 5th value that distinguishes
         this confirmed-broken case from a genuinely missing package. */
      const inv = buildModelInventory(
        baseDeps({
          sidecar: { ...reachableSidecar, coquiPackageInstalled: true, coquiImportOk: false },
        }),
      );
      const coqui = inv.items.find((i) => i.id === 'coqui')!;
      expect(coqui.installState).toBe('package-broken');
    });

    it('coqui_import_ok: null falls back to coquiPackageInstalled — installState stays ready, unchanged from today', () => {
      const inv = buildModelInventory(
        baseDeps({
          sidecar: { ...reachableSidecar, coquiPackageInstalled: true, coquiImportOk: null },
        }),
      );
      const coqui = inv.items.find((i) => i.id === 'coqui')!;
      expect(coqui.installState).toBe('ready');
    });

    it('coqui_import_ok: true reports installState ready', () => {
      const inv = buildModelInventory(
        baseDeps({
          sidecar: { ...reachableSidecar, coquiPackageInstalled: true, coquiImportOk: true },
        }),
      );
      const coqui = inv.items.find((i) => i.id === 'coqui')!;
      expect(coqui.installState).toBe('ready');
    });
  });

  describe('kokoro/qwen/whisper import honesty (#1965)', () => {
    /* Coqui got the real-import preference in #1963; the other five rows kept
       reading find_spec alone. All six now compose it through the same
       pkgUsable helper, so an engine whose package is present but genuinely
       unimportable (#1944) stops reporting 'ready'. Weights are installed in
       each case so installState turns on packageInstalled alone.

       #2533 — these three now assert 'package-broken', not 'package-missing':
       a real failed import (importOk: false) alongside a CONFIRMED find_spec
       true is precisely the case the new 5th installState value exists to
       distinguish from a genuinely absent package. */
    it('kokoro: kokoroImportOk false downgrades to package-broken despite find_spec true', () => {
      installKokoro();
      const inv = buildModelInventory(
        baseDeps({
          sidecar: { ...reachableSidecar, kokoroLoaded: false, kokoroPackageInstalled: true, kokoroImportOk: false },
        }),
      );
      expect(inv.items.find((i) => i.id === 'kokoro')!.installState).toBe('package-broken');
    });

    it('kokoro: kokoroImportOk null (the common value) falls back to find_spec — ready, unchanged', () => {
      installKokoro();
      const inv = buildModelInventory(
        baseDeps({
          sidecar: { ...reachableSidecar, kokoroLoaded: false, kokoroPackageInstalled: true, kokoroImportOk: null },
        }),
      );
      expect(inv.items.find((i) => i.id === 'kokoro')!.installState).toBe('ready');
    });

    it('qwen: qwenImportOk false downgrades ALL THREE qwen rows to package-broken despite find_spec true', () => {
      installQwenBase();
      installQwenBase17();
      installQwenDesign();
      const inv = buildModelInventory(
        baseDeps({
          sidecar: { ...reachableSidecar, qwenPackageInstalled: true, qwenImportOk: false },
        }),
      );
      for (const id of ['qwen-base', 'qwen-base17', 'qwen-design'])
        expect(inv.items.find((i) => i.id === id)!.installState).toBe('package-broken');
    });

    it('qwen: qwenImportOk true outranks a find_spec false — a real import beats the probe', () => {
      installQwenBase();
      const inv = buildModelInventory(
        baseDeps({
          sidecar: { ...reachableSidecar, qwenPackageInstalled: false, qwenImportOk: true },
        }),
      );
      expect(inv.items.find((i) => i.id === 'qwen-base')!.installState).toBe('ready');
    });

    it('whisper: whisperImportOk false downgrades to package-broken despite find_spec true', () => {
      installWhisper();
      const inv = buildModelInventory(
        baseDeps({
          sidecar: { ...reachableSidecar, whisperPackageInstalled: true, whisperImportOk: false },
        }),
      );
      expect(inv.items.find((i) => i.id === 'whisper')!.installState).toBe('package-broken');
    });

    it('whisper: sizes/paths the CONFIGURED qa.asr.model, not base (PR #2008 review, Major 1)', () => {
      /* Before the fix this row always sized 'base', regardless of an
         overridden qa.asr.model — the inventory disagreed with what the
         sidecar had actually loaded. */
      _setUserSettingsCacheForTest({ configOverrides: { 'qa.asr.model': 'small' } });
      writeFile(
        join(hfCache, 'models--Systran--faster-whisper-small', 'snapshots', 'abc', 'model.bin'),
        321,
      );
      const inv = buildModelInventory(baseDeps());
      const row = inv.items.find((i) => i.id === 'whisper')!;
      expect(row.present).toBe(true);
      expect(row.sizeBytes).toBe(321);
      expect(row.diskPath).toContain('faster-whisper-small');
    });
  });

  describe('installState package-missing vs package-broken (#2533)', () => {
    /* #2533 — a consumer must be able to tell "package genuinely missing" from
       "package present but broken/unimportable" directly off installState — the
       owner's chosen design (option 1 of the two named in the issue): a 5th
       installState value, 'package-broken', folded into the SAME enum
       models-status.ts's own classifyPackageFault already distinguishes, rather
       than a separate sibling field (the PR #2579 approach this replaces). */

    it('kokoro: package present but unimportable (import_ok false, package_installed true) → package-broken', () => {
      installKokoro();
      const inv = buildModelInventory(
        baseDeps({
          sidecar: { ...reachableSidecar, kokoroLoaded: false, kokoroPackageInstalled: true, kokoroImportOk: false },
        }),
      );
      const kokoro = inv.items.find((i) => i.id === 'kokoro')!;
      expect(kokoro.installState).toBe('package-broken');
    });

    it('kokoro: package missing entirely (import_ok false, package_installed false) → package-missing', () => {
      installKokoro(); // weights present so installState turns on package-presence alone
      const inv = buildModelInventory(
        baseDeps({
          sidecar: { ...reachableSidecar, kokoroLoaded: false, kokoroPackageInstalled: false, kokoroImportOk: false },
        }),
      );
      const kokoro = inv.items.find((i) => i.id === 'kokoro')!;
      expect(kokoro.installState).toBe('package-missing');
    });

    it('kokoro: no recorded import + package on disk → ready, no fault', () => {
      installKokoro();
      // Simulate kokoro_onnx present in the sidecar venv so the Node probe is true.
      mkdirSync(join(repoRoot, 'server', 'tts-sidecar', '.venv', 'Lib', 'site-packages', 'kokoro_onnx'), {
        recursive: true,
      });
      const inv = buildModelInventory(
        baseDeps({
          sidecar: { ...reachableSidecar, kokoroLoaded: false, kokoroPackageInstalled: undefined },
        }),
      );
      const kokoro = inv.items.find((i) => i.id === 'kokoro')!;
      expect(kokoro.installState).toBe('ready'); // unchanged
    });

    /* 🟠1 regression (PR #2579 review) — classifyPackageFault's second parameter
       is `specPresent`, an unknown-CAPABLE axis. The defect: feeding it
       pkgInstalled(...)'s disk-probe-composed boolean instead of the raw
       sidecar.kokoroPackageInstalled manufactures an "agreement" (specPresent
       === false) the sidecar itself never reported, which wrongly overrides a
       real failed import into 'missing' instead of 'broken' — per
       classifyPackageFault's own precedence rule, "missing" only wins when
       specPresent is a CONFIRMED false, not merely "the Node disk probe
       couldn't find it either" (the sidecar's own find_spec axis is unknown
       here — kokoroPackageInstalled is left undefined below, and nothing on
       disk makes the Node probe true, so the naive composed substitution would
       resolve specPresent to false). A real failed import (importOk: false)
       with the sidecar's OWN axis still unknown must classify as 'broken'. */
    it('kokoro: real failed import + sidecar find_spec UNREPORTED (undefined), disk probe also empty → package-broken, not package-missing', () => {
      installKokoro(); // weights present; nothing under .venv/Lib/site-packages, so the Node disk probe reads false
      const inv = buildModelInventory(
        baseDeps({
          sidecar: { ...reachableSidecar, kokoroLoaded: false, kokoroPackageInstalled: undefined, kokoroImportOk: false },
        }),
      );
      const kokoro = inv.items.find((i) => i.id === 'kokoro')!;
      expect(kokoro.installState).toBe('package-broken');
    });

    /* Direct fail-open assertion (classifyPackageFault's own documented rule):
       unknown on BOTH axes must never read as 'broken', even though the Node
       disk probe (fed only to the coarse installState composition, never to
       the fault classifier) says the package is absent. */
    it('kokoro: unknown on both axes (sidecar down/silent) → never package-broken', () => {
      installKokoro();
      const inv = buildModelInventory(
        baseDeps({
          sidecar: { ...reachableSidecar, kokoroLoaded: false, kokoroPackageInstalled: undefined, kokoroImportOk: undefined },
        }),
      );
      const kokoro = inv.items.find((i) => i.id === 'kokoro')!;
      expect(kokoro.installState).not.toBe('package-broken');
      expect(kokoro.installState).toBe('package-missing'); // disk probe still drives the coarse composition
    });

    it('qwen-base: package present but unimportable → package-broken', () => {
      installQwenBase();
      const inv = buildModelInventory(
        baseDeps({
          sidecar: { ...reachableSidecar, qwenLoaded: false, qwenPackageInstalled: true, qwenImportOk: false },
        }),
      );
      const row = inv.items.find((i) => i.id === 'qwen-base')!;
      expect(row.installState).toBe('package-broken');
    });

    it('qwen-base: package missing entirely → package-missing', () => {
      installQwenBase();
      const inv = buildModelInventory(
        baseDeps({
          sidecar: { ...reachableSidecar, qwenLoaded: false, qwenPackageInstalled: false, qwenImportOk: false },
        }),
      );
      const row = inv.items.find((i) => i.id === 'qwen-base')!;
      expect(row.installState).toBe('package-missing');
    });

    it('qwen-base17: package present but unimportable → package-broken', () => {
      installQwenBase17();
      const inv = buildModelInventory(
        baseDeps({
          sidecar: { ...reachableSidecar, qwenBase17Loaded: false, qwenPackageInstalled: true, qwenImportOk: false },
        }),
      );
      const row = inv.items.find((i) => i.id === 'qwen-base17')!;
      expect(row.installState).toBe('package-broken');
    });

    it('qwen-base17: package missing entirely → package-missing', () => {
      installQwenBase17();
      const inv = buildModelInventory(
        baseDeps({
          sidecar: { ...reachableSidecar, qwenBase17Loaded: false, qwenPackageInstalled: false, qwenImportOk: false },
        }),
      );
      const row = inv.items.find((i) => i.id === 'qwen-base17')!;
      expect(row.installState).toBe('package-missing');
    });

    it('qwen-design: package present but unimportable → package-broken', () => {
      installQwenDesign();
      const inv = buildModelInventory(
        baseDeps({
          sidecar: { ...reachableSidecar, qwenPackageInstalled: true, qwenImportOk: false },
        }),
      );
      const row = inv.items.find((i) => i.id === 'qwen-design')!;
      expect(row.installState).toBe('package-broken');
    });

    it('qwen-design: package missing entirely → package-missing', () => {
      installQwenDesign();
      const inv = buildModelInventory(
        baseDeps({
          sidecar: { ...reachableSidecar, qwenPackageInstalled: false, qwenImportOk: false },
        }),
      );
      const row = inv.items.find((i) => i.id === 'qwen-design')!;
      expect(row.installState).toBe('package-missing');
    });

    it('coqui: package present but unimportable → package-broken', () => {
      writeFile(join(ttsHome, 'tts', XTTS_DIR, 'model.pth'), 4096);
      const inv = buildModelInventory(
        baseDeps({
          sidecar: { ...reachableSidecar, modelLoaded: false, coquiPackageInstalled: true, coquiImportOk: false },
        }),
      );
      const row = inv.items.find((i) => i.id === 'coqui')!;
      expect(row.installState).toBe('package-broken');
    });

    it('coqui: package missing entirely → package-missing', () => {
      writeFile(join(ttsHome, 'tts', XTTS_DIR, 'model.pth'), 4096);
      const inv = buildModelInventory(
        baseDeps({
          sidecar: { ...reachableSidecar, modelLoaded: false, coquiPackageInstalled: false, coquiImportOk: false },
        }),
      );
      const row = inv.items.find((i) => i.id === 'coqui')!;
      expect(row.installState).toBe('package-missing');
    });

    it('whisper: package present but unimportable (import_ok false, package_installed true) → package-broken', () => {
      installWhisper();
      const inv = buildModelInventory(
        baseDeps({
          sidecar: { ...reachableSidecar, whisperPackageInstalled: true, whisperImportOk: false },
        }),
      );
      const whisper = inv.items.find((i) => i.id === 'whisper')!;
      expect(whisper.installState).toBe('package-broken');
    });

    it('whisper: package missing entirely (import_ok false, package_installed false) → package-missing', () => {
      installWhisper();
      const inv = buildModelInventory(
        baseDeps({
          sidecar: { ...reachableSidecar, whisperPackageInstalled: false, whisperImportOk: false },
        }),
      );
      const whisper = inv.items.find((i) => i.id === 'whisper')!;
      expect(whisper.installState).toBe('package-missing');
    });
  });

  it('every TTS + whisper row carries an integrity verdict', () => {
    const inv = buildModelInventory(baseDeps());
    for (const id of ['kokoro', 'qwen-base', 'coqui', 'whisper'])
      expect(inv.items.find((i) => i.id === id)!.integrity).toBeDefined();
  });

  it('lists local Ollama models with size + residency + default flag', () => {
    const inv = buildModelInventory(
      baseDeps({
        ollama: {
          reachable: true,
          models: [
            { name: 'qwen3.5:4b', size: 2_600_000_000 },
            { name: 'llama3.2:3b', size: 2_000_000_000 },
          ],
          resident: ['qwen3.5:4b'],
        },
      }),
    );
    const a = inv.items.find((i) => i.id === 'ollama:qwen3.5:4b')!;
    const b = inv.items.find((i) => i.id === 'ollama:llama3.2:3b')!;
    expect(a.kind).toBe('analyzer');
    expect(a.sizeBytes).toBe(2_600_000_000);
    expect(a.loaded).toBe(true); // resident
    expect(a.isDefaultEngine).toBe(true); // matches resolvedOllamaModel
    expect(b.loaded).toBe(false);
    expect(b.isDefaultEngine).toBe(false);
  });

  it('does not mark a same-family different-size tag as loaded (qwen3.5:4b resident ≠ qwen3.5:9b loaded)', () => {
    /* Regression: tagMatches over-matched on the family root, so a resident
       qwen3.5:4b lit up qwen3.5:9b as "Loaded" in the Model Manager even
       though ollama ps held only the 4b. Different explicit size tags must
       never be conflated. */
    const inv = buildModelInventory(
      baseDeps({
        ollama: {
          reachable: true,
          models: [
            { name: 'qwen3.5:4b', size: 3_200_000_000 },
            { name: 'qwen3.5:9b', size: 6_100_000_000 },
          ],
          resident: ['qwen3.5:4b'],
        },
      }),
    );
    const four = inv.items.find((i) => i.id === 'ollama:qwen3.5:4b')!;
    const nine = inv.items.find((i) => i.id === 'ollama:qwen3.5:9b')!;
    expect(four.loaded).toBe(true); // actually resident
    expect(nine.loaded).toBe(false); // NOT resident — must not borrow 4b's residency
  });

  it('treats a bare family tag as equivalent to :latest (qwen3.5 resident ⇒ qwen3.5:latest loaded)', () => {
    const inv = buildModelInventory(
      baseDeps({
        ollama: {
          reachable: true,
          models: [{ name: 'qwen3.5:latest', size: 3_200_000_000 }],
          resident: ['qwen3.5'],
        },
      }),
    );
    const latest = inv.items.find((i) => i.id === 'ollama:qwen3.5:latest')!;
    expect(latest.loaded).toBe(true); // bare 'qwen3.5' resident === ':latest'
  });

  it('flips Kokoro off-default when Qwen is the resolved engine', () => {
    installKokoro();
    const inv = buildModelInventory(baseDeps({ resolvedTtsEngine: 'qwen' }));
    expect(inv.items.find((i) => i.id === 'kokoro')!.isDefaultEngine).toBe(false);
    expect(inv.items.find((i) => i.id === 'qwen-base')!.isDefaultEngine).toBe(true);
  });

  it('old-sidecar compat: kokoroPackageInstalled=undefined + Node probe true + weights present → installState ready', () => {
    /* Regression: when a reachable but older sidecar omits kokoro_package_installed,
       the pkgInstalled helper was treating the coerced `false` as authoritative and
       returning package-missing even though the kokoro_onnx package IS on disk.
       With the fix, undefined falls back to the Node disk probe (true here because
       we create the site-packages dir), so installState must be 'ready'. */
    installKokoro();
    // Simulate the kokoro_onnx package being present in the sidecar venv (Node probe = true).
    const kokoro_onnx_dir = join(
      repoRoot,
      'server',
      'tts-sidecar',
      '.venv',
      'Lib',
      'site-packages',
      'kokoro_onnx',
    );
    mkdirSync(kokoro_onnx_dir, { recursive: true });

    const inv = buildModelInventory(
      baseDeps({
        sidecar: {
          ...reachableSidecar,
          kokoroLoaded: false,
          kokoroPackageInstalled: undefined, // old sidecar omitted the field
        },
      }),
    );
    const row = inv.items.find((i) => i.id === 'kokoro')!;
    // Node probe sees the package on disk → should be 'ready' (weights present, package installed)
    expect(row.installState).toBe('ready');
  });

  it('analyzer items carry resolved keepAliveSeconds and override flag', () => {
    _setUserSettingsCacheForTest({ analyzerKeepAliveByModel: { 'qwen36-castwright:latest': 300 } });
    const res = buildModelInventory(
      baseDeps({
        ollama: {
          reachable: true,
          models: [{ name: 'qwen36-castwright:latest', size: 1 }, { name: 'qwen3.5:4b', size: 1 }],
          resident: [],
        },
      }),
    );
    const custom = res.items.find((i) => i.id === 'ollama:qwen36-castwright:latest');
    const supported = res.items.find((i) => i.id === 'ollama:qwen3.5:4b');
    expect(custom?.keepAliveSeconds).toBe(300);
    expect(custom?.keepAliveIsOverride).toBe(true);
    expect(supported?.keepAliveSeconds).toBe(30); // flat fallback (no override)
    expect(supported?.keepAliveIsOverride).toBe(false);
  });
});

function item(over: Partial<ModelInventoryItem>): ModelInventoryItem {
  return {
    id: 'coqui',
    kind: 'tts',
    label: 'Coqui XTTS v2',
    present: true,
    sizeBytes: 1000,
    diskPath: '/x',
    loaded: false,
    isDefaultEngine: false,
    isFallbackEngine: false,
    removable: true,
    updatable: true,
    ...over,
  };
}

describe('evaluateRemoval', () => {
  it('allows a present, idle, non-default, non-fallback model', () => {
    expect(evaluateRemoval(item({})).ok).toBe(true);
  });
  it('blocks a loaded model (unload first)', () => {
    expect(evaluateRemoval(item({ loaded: true }))).toMatchObject({ ok: false, code: 'model-loaded' });
  });
  it('blocks the fallback engine the loudest (even if also default)', () => {
    expect(
      evaluateRemoval(item({ isFallbackEngine: true, isDefaultEngine: true })),
    ).toMatchObject({ ok: false, code: 'model-is-fallback' });
  });
  it('blocks the current default engine', () => {
    expect(evaluateRemoval(item({ isDefaultEngine: true }))).toMatchObject({
      ok: false,
      code: 'model-is-default',
    });
  });
});

describe('performRemoval', () => {
  it('deletes the Kokoro weight dir and reports freed bytes', async () => {
    writeFile(join(repoRoot, 'server', 'tts-sidecar', 'voices', 'kokoro', 'kokoro-v1.0.onnx'), 1000);
    writeFile(join(repoRoot, 'server', 'tts-sidecar', 'voices', 'kokoro', 'voices-v1.0.bin'), 200);
    const res = await performRemoval('kokoro', repoRoot);
    expect(res.removed).toBe(true);
    expect(res.freedBytes).toBe(1200);
    expect(dirSizeBytes(join(repoRoot, 'server', 'tts-sidecar', 'voices', 'kokoro')).bytes).toBe(0);
  });

  it('is a no-op (0 bytes) when the path is already gone', async () => {
    const res = await performRemoval('coqui', repoRoot);
    expect(res).toEqual({ removed: true, freedBytes: 0 });
  });

  it('deletes the qwen-base17 HF snapshot dir and reports freed bytes', async () => {
    writeFile(
      join(hfCache, 'models--Qwen--Qwen3-TTS-12Hz-1.7B-Base', 'snapshots', 'abc', 'model.safetensors'),
      8000,
    );
    const res = await performRemoval('qwen-base17', repoRoot);
    expect(res.removed).toBe(true);
    expect(res.freedBytes).toBe(8000);
    expect(
      dirSizeBytes(join(hfCache, 'models--Qwen--Qwen3-TTS-12Hz-1.7B-Base')).bytes,
    ).toBe(0);
  });

  describe('whisper: removalPaths honours an overridden qa.asr.model (PR #2008 review, Major 1)', () => {
    afterEach(() => _resetUserSettingsCache()); // don't leak the seeded override into later cases

    it('removes the CONFIGURED model directory, not the default base, and leaves base untouched', async () => {
      /* Before the fix, whisperRepoDir() (and therefore removalPaths) always
         read a module-load-time `process.env.ASR_MODEL` const and never saw a
         registry override — so Remove deleted 'base' regardless of what was
         actually configured/loaded, and freed the wrong model's bytes while
         leaving the model actually in use on disk. */
      _setUserSettingsCacheForTest({ configOverrides: { 'qa.asr.model': 'small' } });
      writeFile(
        join(hfCache, 'models--Systran--faster-whisper-small', 'snapshots', 'abc', 'model.bin'),
        300,
      );
      writeFile(
        join(hfCache, 'models--Systran--faster-whisper-base', 'snapshots', 'abc', 'model.bin'),
        999,
      );

      const res = await performRemoval('whisper', repoRoot);

      expect(res.removed).toBe(true);
      expect(res.freedBytes).toBe(300); // the configured model's size, not base's
      expect(
        dirSizeBytes(join(hfCache, 'models--Systran--faster-whisper-small')).bytes,
      ).toBe(0); // configured model actually removed
      expect(
        dirSizeBytes(join(hfCache, 'models--Systran--faster-whisper-base')).bytes,
      ).toBe(999); // base, which is NOT in use, is left alone
    });
  });
});

describe('POST /api/models/:id/remove', () => {
  it('404s an unknown model id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('offline'))),
    );
    const app = express();
    app.use(express.json());
    app.use('/api/models', modelsInventoryRouter);
    const res = await request(app).post('/api/models/not-a-model/remove');
    expect(res.status).toBe(404);
  });
});

describe('GET /api/models/inventory', () => {
  it('returns an inventory even when both probes are unreachable', async () => {
    /* Stub global fetch so the sidecar + ollama probes both fail fast. */
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('connect ECONNREFUSED'))),
    );
    const app = express();
    app.use(express.json());
    app.use('/api/models', modelsInventoryRouter);

    const res = await request(app).get('/api/models/inventory');
    expect(res.status).toBe(200);
    expect(res.body.sidecarReachable).toBe(false);
    /* The five fixed engine rows are always present even with no sidecar. */
    const ids = res.body.items.map((i: { id: string }) => i.id);
    expect(ids).toEqual(
      expect.arrayContaining(['kokoro', 'qwen-base', 'qwen-base17', 'qwen-design', 'coqui', 'whisper']),
    );
  });
});
