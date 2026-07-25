import { useRef, useState } from 'react';

type Phase = 'idle' | 'recording' | 'recorded' | 'denied';

export function VoiceRecorder({ onRecorded }: { onRecorded: (blob: Blob) => void }) {
  const [phase, setPhase] = useState<Phase>('idle');
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  async function start() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const rec = new MediaRecorder(stream);
      chunksRef.current = [];
      rec.ondataavailable = (e) => chunksRef.current.push(e.data);
      rec.onstop = () => {
        onRecorded(new Blob(chunksRef.current, { type: 'audio/webm' }));
        streamRef.current?.getTracks().forEach((t) => t.stop());
        setPhase('recorded');
      };
      recorderRef.current = rec;
      rec.start();
      setPhase('recording');
    } catch {
      setPhase('denied');
    }
  }
  function stop() { recorderRef.current?.stop(); }

  if (phase === 'denied') {
    return (
      <div className="text-sm text-magenta">
        Mic access was blocked. Enable microphone permission or use the Upload tab instead.
        <button className="ml-2 underline min-h-[44px] fine-pointer:min-h-0" onClick={() => setPhase('idle')}>Try again</button>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-3">
      {phase === 'recording'
        ? <button className="min-h-[44px] fine-pointer:min-h-0" onClick={stop}>Stop</button>
        : <button className="min-h-[44px] fine-pointer:min-h-0" onClick={start}>{phase === 'recorded' ? 'Re-record' : 'Record'}</button>}
      {phase === 'recording' && <span aria-hidden className="animate-pulse">●</span>}
    </div>
  );
}
