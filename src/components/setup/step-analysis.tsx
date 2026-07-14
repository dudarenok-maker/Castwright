/* Setup wizard — Step: Analysis (local-first).
   Two distinct cards: ① Local via Ollama (OllamaInstall + ModelPullStatus,
   closing the pull dead-end) and ② Online via Gemini (GeminiKeyField).
   Provision-only: the ACTIVE analyzer is chosen later in the Defaults step. */

import { useEffect, useState } from 'react';
import { OllamaInstall } from '../ollama-install';
import { ModelPullStatus, type OllamaHealthEnvelope } from '../model-pull-status';
import { GeminiKeyField } from '../account-forms';
import { useAppDispatch, useAppSelector } from '../../store';
import { saveGeminiApiKey, fetchAnalyzerModels } from '../../store/account-slice';
import { MODEL_OPTIONS } from '../../lib/models';
import { api } from '../../lib/api';
import type { SetupReadiness, BlockerDiagnosis } from '../../lib/api';

/* Known local analyzer-model family roots (qwen3.5, llama3.1, …) from the
   curated catalog. Used to gate the bridge line so an embedding-only install
   (e.g. nomic-embed-text) does NOT read as "analyzer available" — mirrors the
   server's anyAnalyzerModelPulled exclusion. */
const LOCAL_ANALYZER_ROOTS = new Set(
  MODEL_OPTIONS.filter((m) => m.engine === 'local').map((m) => m.id.split(':')[0]),
);

function AnalyzerBadge({ diagnosis }: { diagnosis: BlockerDiagnosis }) {
  const tone =
    diagnosis.status === 'pass'
      ? { dot: 'bg-emerald-600', chip: 'bg-emerald-100 text-emerald-800', label: 'Analyzer ready' }
      : diagnosis.status === 'warn'
        ? { dot: 'bg-amber-500', chip: 'bg-amber-100 text-amber-800', label: 'Analyzer ready — no backup' }
        : { dot: 'bg-rose-600', chip: 'bg-rose-100 text-rose-800', label: 'Analyzer needed' };
  return (
    <div className="space-y-1.5">
      <span
        data-blocker-status={diagnosis.status}
        className={['inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold', tone.chip].join(' ')}
      >
        <span className={['w-1.5 h-1.5 rounded-full', tone.dot].join(' ')} />
        {tone.label}
      </span>
      {/* Message-only: the two cards below ARE the remedies; no fix action here. */}
      {diagnosis.status !== 'pass' && <p className="text-xs text-ink/60">{diagnosis.message}</p>}
    </div>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return <h2 className="text-base font-semibold text-ink">{children}</h2>;
}

export function StepAnalysis({ readiness, onRefetch }: { readiness: SetupReadiness; onRefetch: () => void }) {
  const dispatch = useAppDispatch();
  const account = useAppSelector((s) => s.account);
  const [health, setHealth] = useState<OllamaHealthEnvelope | null>(null);

  useEffect(() => {
    void dispatch(fetchAnalyzerModels());
    void api.getOllamaHealth().then(setHealth).catch(() => {});
  }, [dispatch]);

  const handleGeminiSave = async (key: string | null) => {
    await dispatch(saveGeminiApiKey(key));
    onRefetch();
  };

  const handlePulled = () => {
    onRefetch();
    void dispatch(fetchAnalyzerModels());
  };

  // A pulled ANALYZER-CAPABLE local model → show the bridge line to Defaults.
  // `localAnalyzerModels` is the raw /api/tags list (embeddings included), so
  // filter to a curated analyzer family or a pull-allowlist match — never bare
  // `.length > 0`, which would light for an embedding-only box.
  const hasLocalAnalyzerModel = account.localAnalyzerModels.some((m) => {
    const root = m.name.split(':')[0];
    return LOCAL_ANALYZER_ROOTS.has(root) || account.pullableModels.some((p) => p.split(':')[0] === root);
  });

  return (
    <div className="space-y-8">
      <div className="flex items-start gap-3 flex-wrap">
        <h1 className="text-2xl font-semibold text-ink">Analysis</h1>
        <AnalyzerBadge diagnosis={readiness.blockers.analyzer} />
      </div>

      <p className="text-sm text-ink/60">
        The analyzer reads your manuscript and detects characters, scenes, and dialogue
        attribution. Castwright is local-first — run it on-device with Ollama, or use the
        free Gemini API. You pick which one runs in the Defaults step.
      </p>

      {/* ① Local via Ollama (primary, first) */}
      <section className="space-y-4">
        <SectionHeading>Local via Ollama</SectionHeading>
        <p className="text-xs text-ink/55">
          Runs the analyzer on your machine — no API key, needs a capable GPU and a one-time
          model download.
        </p>
        <OllamaInstall onInstalled={onRefetch} />
        <ModelPullStatus health={health} pullableModels={account.pullableModels} onPulled={handlePulled} />
        {hasLocalAnalyzerModel && (
          <p data-testid="analysis-local-bridge" className="text-xs text-emerald-700">
            ✓ Local analyzer available — pick it in the Defaults step to use it.
          </p>
        )}
      </section>

      {/* ② Online via Gemini (second) */}
      <section className="space-y-4">
        <SectionHeading>Online via Gemini</SectionHeading>
        <p className="text-xs text-ink/55">
          Uses Google's free Gemini tier — no local GPU required. Just paste an API key.
        </p>
        <div className="rounded-2xl border border-ink/10 bg-white p-4">
          <GeminiKeyField status={account.apiKeyStatus} onSave={handleGeminiSave} />
        </div>
      </section>
    </div>
  );
}
