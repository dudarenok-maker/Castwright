/* Setup wizard — Step: Models.
   Composes the in-app installers for the voice engines (shared Python runtime +
   Kokoro default, Qwen/Coqui as collapsible alternatives) and the analyzer setup
   (Gemini key recommended, local Ollama as collapsible alternative).

   Each install callback (`onInstalled` / `onBootstrapped`) is wired to
   `onRefetch` so the wizard re-probes readiness after every completed install. */

import { VenvBootstrap } from '../venv-bootstrap';
import { KokoroInstall } from '../kokoro-install';
import { QwenInstall } from '../qwen-install';
import { CoquiInstall } from '../coqui-install';
import { OllamaInstall } from '../ollama-install';
import { GeminiKeyField } from '../account-forms';
import { useAppDispatch, useAppSelector } from '../../store';
import { saveGeminiApiKey } from '../../store/account-slice';
import type { SetupReadiness } from '../../lib/api';

// ── small status badge ──────────────────────────────────────────────────────

function BlockerBadge({
  status,
  label,
}: {
  status: 'pass' | 'fail';
  label: string;
}) {
  const isPass = status === 'pass';
  return (
    <span
      data-blocker-status={status}
      className={[
        'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold',
        isPass
          ? 'bg-emerald-100 text-emerald-800'
          : 'bg-amber-100 text-amber-800',
      ].join(' ')}
    >
      <span
        className={[
          'w-1.5 h-1.5 rounded-full',
          isPass ? 'bg-emerald-600' : 'bg-amber-600',
        ].join(' ')}
      />
      {label}
    </span>
  );
}

// ── section heading ─────────────────────────────────────────────────────────

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-base font-semibold text-ink">{children}</h2>
  );
}

// ── StepModels ──────────────────────────────────────────────────────────────

export function StepModels({
  readiness,
  onRefetch,
}: {
  readiness: SetupReadiness;
  onRefetch: () => void;
}) {
  const dispatch = useAppDispatch();
  const account = useAppSelector((s) => s.account);

  const handleGeminiSave = async (key: string | null) => {
    await dispatch(saveGeminiApiKey(key));
    onRefetch();
  };

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-semibold text-ink">Models</h1>

      {/* ── Voice engines section ───────────────────────────────────── */}
      <section className="space-y-4">
        <div className="flex items-center gap-3">
          <SectionHeading>Voice engines</SectionHeading>
          <BlockerBadge
            status={readiness.blockers.sidecar}
            label={readiness.blockers.sidecar === 'pass' ? 'Runtime ready' : 'Runtime needed'}
          />
          <BlockerBadge
            status={readiness.blockers.tts}
            label={readiness.blockers.tts === 'pass' ? 'Voice ready' : 'Voice needed'}
          />
        </div>

        <p className="text-sm text-ink/60">
          Voice engines turn your manuscript into speech. They all share one Python
          runtime — set it up once, then every voice engine can use it.
        </p>

        <VenvBootstrap onBootstrapped={onRefetch} />
        <KokoroInstall onInstalled={onRefetch} />

        {/* Alternative engines — collapsible */}
        <details className="group rounded-2xl border border-ink/10">
          <summary className="flex cursor-pointer items-center justify-between px-4 py-3 text-sm font-medium text-ink select-none">
            <span>Alternative voice engines</span>
            <span className="text-xs text-ink/50 group-open:hidden">
              Qwen3-TTS · Coqui XTTS v2
            </span>
            <span className="text-xs text-ink/50 hidden group-open:inline">
              Hide
            </span>
          </summary>
          <div className="px-4 pb-4 space-y-4">
            <p className="text-xs text-ink/55">
              Kokoro is the default engine and covers most use cases.
              Install Qwen3-TTS for bespoke per-character voice design, or
              Coqui XTTS v2 for zero-shot cloning.
            </p>
            <QwenInstall onInstalled={onRefetch} />
            <CoquiInstall onInstalled={onRefetch} />
          </div>
        </details>
      </section>

      {/* ── Analyzer section ────────────────────────────────────────── */}
      <section className="space-y-4">
        <div className="flex items-center gap-3">
          <SectionHeading>Analyzer</SectionHeading>
          <BlockerBadge
            status={readiness.blockers.analyzer}
            label={readiness.blockers.analyzer === 'pass' ? 'Analyzer ready' : 'Analyzer needed'}
          />
        </div>

        <p className="text-sm text-ink/60">
          The analyzer reads your manuscript and detects characters, scenes, and
          dialogue attribution. A Gemini API key is the recommended option — it
          uses the free tier and needs no local GPU.
        </p>

        <div className="rounded-2xl border border-ink/10 bg-white p-4">
          <GeminiKeyField
            status={account.apiKeyStatus}
            onSave={handleGeminiSave}
          />
        </div>

        {/* Local analyzer — collapsible */}
        <details className="group rounded-2xl border border-ink/10">
          <summary className="flex cursor-pointer items-center justify-between px-4 py-3 text-sm font-medium text-ink select-none">
            <span>Use a local analyzer instead</span>
            <span className="text-xs text-ink/50 group-open:hidden">
              Ollama · runs on-device
            </span>
            <span className="text-xs text-ink/50 hidden group-open:inline">
              Hide
            </span>
          </summary>
          <div className="px-4 pb-4 space-y-4">
            <p className="text-xs text-ink/55">
              Ollama runs the analyzer model on your machine — no API key needed,
              but requires a capable GPU and a one-time model download.
            </p>
            <OllamaInstall onInstalled={onRefetch} />
          </div>
        </details>
      </section>
    </div>
  );
}
