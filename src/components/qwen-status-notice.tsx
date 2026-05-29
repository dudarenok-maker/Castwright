/* Install-check warning + promo nudge for Qwen3-TTS (qwen-default phase 4).

   Shown on the cast-selection surfaces when Qwen ISN'T installed: tells the
   user their books render in Kokoro and that installing Qwen unlocks bespoke
   per-character voices, linking to Account → Models (where <QwenInstall/>
   lives). Renders NOTHING when Qwen is installed — installed users aren't
   nagged. Self-contained (one-shot /api/qwen/detect probe, no redux), matching
   the <QwenInstall/> pattern. */

import { useEffect, useState } from 'react';

interface DetectResp {
  state: 'not-installed' | 'weights-missing' | 'ready' | 'loaded';
  installed: boolean;
}

export function QwenStatusNotice() {
  const [detect, setDetect] = useState<DetectResp | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch('/api/qwen/detect');
        if (!res.ok) return;
        const body = (await res.json()) as DetectResp;
        if (alive) setDetect(body);
      } catch {
        /* Unreachable probe → stay silent rather than show a false warning. */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Only nudge when we KNOW Qwen isn't installed. Unknown/installed → render nothing.
  if (!detect || detect.installed) return null;

  return (
    <div
      data-testid="qwen-status-notice"
      className="rounded-xl border border-amber-200 bg-amber-50/70 px-4 py-3 text-sm text-amber-900 flex items-start gap-3"
    >
      <span className="mt-0.5 w-2 h-2 rounded-full bg-amber-500 shrink-0" />
      <p className="flex-1">
        <span className="font-medium">Qwen3-TTS isn't installed.</span> Characters render in Kokoro
        until you install it. For the best quality — a unique designed voice per character — install
        Qwen3-TTS in{' '}
        <a href="#/account" className="underline font-medium hover:text-amber-950">
          Account → Models
        </a>
        .
      </p>
    </div>
  );
}
