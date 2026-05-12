import { useEffect, useRef, useState } from 'react';
import { IconCheck, IconSpinner } from '../lib/icons';
import { SectionLabel, MixedHeading } from '../components/primitives';
import { api } from '../lib/api';
import { ANALYSIS_PHASES } from '../data/analysis-phases';
import type { AnalyseResponse } from '../lib/types';

interface Props {
  manuscriptId: string | null | undefined;
  title?: string | null;
  model?: string;
  onComplete: (payload: AnalyseResponse) => void;
}

export function AnalysingView({ manuscriptId, title, model, onComplete }: Props) {
  const [phase, setPhase] = useState(0);
  const [phaseProgress, setPhaseProgress] = useState(0);
  const [logs, setLogs] = useState<Record<number, string[]>>({});
  const [error, setError] = useState<string | null>(null);
  const completedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const id = manuscriptId || 'mns_demo_' + Math.random().toString(36).slice(2, 8);
      try {
        const payload = await api.analyseManuscript(id, {
          model,
          onPhase: ({ phaseId, progress }) => {
            if (cancelled) return;
            setPhase(phaseId);
            setPhaseProgress(progress);
          },
          onLog: ({ phaseId, message }) => {
            if (cancelled) return;
            setLogs(prev => ({ ...prev, [phaseId]: [...(prev[phaseId] ?? []), message] }));
          },
        });
        if (cancelled || completedRef.current) return;
        completedRef.current = true;
        onComplete(payload);
      } catch (e) {
        if (cancelled) return;
        setError((e as Error).message || 'Analysis failed.');
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manuscriptId]);

  const overall = (phase + phaseProgress) / ANALYSIS_PHASES.length;
  const activeLogs = logs[phase] ?? [];

  return (
    <div className="relative min-h-[calc(100vh-64px)] flex items-center justify-center px-6 py-16">
      <div className="absolute inset-0 bg-gradient-hero-wash opacity-60 pointer-events-none"/>
      <div className="relative max-w-2xl w-full">
        <div className="text-center mb-10">
          <SectionLabel>Analysing</SectionLabel>
          <div className="mt-5">
            <MixedHeading level="h1" regular="Reading" bold={title || 'The Northern Star'}/>
          </div>
          <p className="mt-4 text-ink/70">This usually takes 60 to 90 seconds.</p>
          {error && (
            <div className="mt-6 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-left">
              <p className="text-sm font-semibold text-red-900">Analysis failed</p>
              <p className="mt-1 text-sm text-red-800 break-words">{error}</p>
              <p className="mt-2 text-xs text-red-700/80">
                Check the server terminal and <code>server/handoff/outbox/*.errors.json</code> for details, then reload to retry.
              </p>
            </div>
          )}
        </div>

        <div className="mb-8">
          <div className="flex items-center justify-between text-xs text-ink/60 mb-2">
            <span>Overall</span><span className="tabular-nums font-semibold text-ink">{Math.round(overall * 100)}%</span>
          </div>
          <div className="relative h-2 rounded-full bg-ink/[0.06] overflow-hidden">
            <div className="absolute inset-y-0 left-0 bg-gradient-progress rounded-full" style={{ width: `${overall * 100}%` }}>
              <div className="absolute inset-0 stripe-travel"/>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-3xl border border-ink/10 shadow-card divide-y divide-ink/5">
          {ANALYSIS_PHASES.map(p => {
            const isActive = phase === p.id;
            const isDone   = phase > p.id;
            return (
              <div key={p.id} className="px-6 py-4 flex items-start gap-4">
                <div className="mt-1 shrink-0">
                  {isDone   && <span className="w-7 h-7 rounded-full bg-emerald-100 grid place-items-center"><IconCheck className="w-4 h-4 text-emerald-700"/></span>}
                  {isActive && <span className="w-7 h-7 rounded-full bg-peach/20 grid place-items-center"><IconSpinner className="w-4 h-4 text-magenta"/></span>}
                  {!isDone && !isActive && <span className="w-7 h-7 rounded-full border border-ink/15"/>}
                </div>
                <div className="flex-1 min-w-0">
                  <p className={`font-semibold ${isDone || isActive ? 'text-ink' : 'text-ink/40'}`}>{p.label}</p>
                  <p className={`text-sm mt-0.5 ${isDone || isActive ? 'text-ink/60' : 'text-ink/30'}`}>{p.detail}</p>
                  {isActive && (
                    <>
                      <div className="mt-3 h-1 rounded-full bg-ink/[0.06] overflow-hidden">
                        <div className="h-full bg-gradient-progress rounded-full" style={{ width: `${phaseProgress * 100}%` }}/>
                      </div>
                      {activeLogs.length > 0 && (
                        <ul className="mt-3 space-y-1.5 text-xs font-mono text-ink/60">
                          {activeLogs.map((s, i) => <li key={i} className="tick-up">{s}</li>)}
                        </ul>
                      )}
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
