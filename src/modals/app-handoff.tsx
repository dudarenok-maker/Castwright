import { useState, type ReactNode } from 'react';
import {
  IconClose,
  IconArrowLeft,
  IconWifi,
  IconFolder,
  IconChevR,
  IconUpload,
  IconAirdrop,
  IconMobile,
  IconQrCode,
  IconShare,
  IconPlus,
  IconCheck,
  IconSignal,
  IconWifiBars,
  IconBattery,
} from '../lib/icons';
import { PrimaryButton } from '../components/primitives';
import { WALKTHROUGH_STEPS } from '../data/walkthroughs';
import type { ListenerApp } from '../lib/types';

interface Props {
  app: ListenerApp | null;
  onClose: () => void;
  onComplete?: (app: ListenerApp) => void;
}

export function AppHandoffModal({ app, onClose, onComplete }: Props) {
  const [step, setStep] = useState(0);
  if (!app) return null;
  const steps = WALKTHROUGH_STEPS[app.id] || [];
  if (steps.length === 0) return null;
  const current = steps[step];
  const isLast = step === steps.length - 1;
  const next = () => {
    if (isLast) {
      onComplete?.(app);
      onClose();
    } else setStep(step + 1);
  };
  const prev = () => step > 0 && setStep(step - 1);
  return (
    <>
      <div onClick={onClose} className="fixed inset-0 bg-ink/40 z-50 fade-in" />
      <div className="fixed inset-0 z-50 grid place-items-center p-6 pointer-events-none">
        <div className="bg-white rounded-3xl shadow-float w-full max-w-2xl pointer-events-auto fade-in overflow-hidden">
          <div
            className="px-6 py-4 flex items-center gap-3 border-b border-ink/10"
            style={{
              background: `linear-gradient(135deg, ${app.gradient[0]}, ${app.gradient[1]})`,
            }}
          >
            <span className="w-10 h-10 rounded-xl bg-white/15 backdrop-blur-sm grid place-items-center text-white font-bold text-sm">
              {app.glyph}
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-[10px] uppercase tracking-widest text-white/70 font-semibold">
                First listen on
              </p>
              <h3 className="text-lg font-bold text-white leading-tight truncate">{app.name}</h3>
            </div>
            <button onClick={onClose} className="p-2 rounded-full hover:bg-white/15 text-white/80">
              <IconClose className="w-4 h-4" />
            </button>
          </div>

          <div className="px-6 pt-5 flex items-center gap-2">
            {steps.map((_, i) => (
              <div key={i} className="flex-1 h-1 rounded-full bg-ink/[0.06] overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${i < step ? 'bg-ink' : i === step ? 'bg-gradient-progress' : 'bg-transparent'}`}
                  style={{ width: i <= step ? '100%' : '0%' }}
                />
              </div>
            ))}
            <span className="text-[11px] tabular-nums text-ink/50 font-semibold ml-2">
              {step + 1}/{steps.length}
            </span>
          </div>

          <div className="p-6 fade-in" key={current.id}>
            <HandoffIllustration kind={current.illustration} app={app} />
            <h4 className="mt-6 text-2xl font-bold text-ink leading-tight">{current.title}</h4>
            <p className="mt-2 text-ink/70 leading-relaxed">{current.description}</p>
            {current.detail && (
              <p className="mt-3 inline-block px-3 py-1 rounded-full bg-canvas border border-ink/10 text-xs text-ink/60 font-mono">
                {current.detail}
              </p>
            )}
            {current.input && (
              <div className="mt-4">
                <input
                  type={current.input.type}
                  defaultValue={current.input.value}
                  placeholder={current.input.placeholder}
                  className="w-full px-4 py-3 rounded-xl bg-canvas border border-ink/10 text-sm font-mono text-ink focus:outline-none focus:border-peach"
                />
              </div>
            )}
          </div>

          <div className="px-6 py-4 border-t border-ink/10 flex items-center justify-between gap-3">
            <button
              onClick={prev}
              disabled={step === 0}
              className="inline-flex items-center gap-1.5 text-sm font-medium text-ink/60 hover:text-ink disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <IconArrowLeft className="w-4 h-4" /> Back
            </button>
            <PrimaryButton variant="dark" onClick={next}>
              {isLast ? `Open in ${app.name}` : 'Continue'}
            </PrimaryButton>
          </div>
        </div>
      </div>
    </>
  );
}

interface IllustrationProps {
  kind: string;
  app: ListenerApp;
}
function HandoffIllustration({ kind, app }: IllustrationProps) {
  const [from, to] = app.gradient;
  const grad = `linear-gradient(135deg, ${from}, ${to})`;
  if (kind === 'server') {
    return (
      <div className="aspect-[2/1] rounded-2xl bg-canvas border border-ink/10 grid place-items-center relative overflow-hidden">
        <div className="grid grid-cols-3 gap-3 w-2/3">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="rounded-lg p-3"
              style={{
                background: i === 1 ? grad : 'white',
                border: i === 1 ? 'none' : '1px solid rgba(15,14,13,0.08)',
              }}
            >
              <span
                className="block w-full h-1 rounded-full mb-1"
                style={{ background: i === 1 ? 'rgba(255,255,255,0.6)' : 'rgba(15,14,13,0.1)' }}
              />
              <span
                className="block w-3/4 h-1 rounded-full"
                style={{ background: i === 1 ? 'rgba(255,255,255,0.4)' : 'rgba(15,14,13,0.06)' }}
              />
            </div>
          ))}
        </div>
        <span className="absolute bottom-3 right-4 inline-flex items-center gap-1.5 text-[11px] text-ink/50">
          <IconWifi className="w-3 h-3" /> connected
        </span>
      </div>
    );
  }
  if (kind === 'folder') {
    return (
      <div className="aspect-[2/1] rounded-2xl bg-canvas border border-ink/10 p-5 flex items-center gap-3">
        <span
          className="w-12 h-12 rounded-xl grid place-items-center text-white"
          style={{ background: grad }}
        >
          <IconFolder className="w-6 h-6" />
        </span>
        <div className="flex-1 flex items-center gap-1.5 text-xs text-ink/50 font-mono overflow-hidden">
          <span className="px-2 py-0.5 rounded bg-white border border-ink/10">Audiobooks</span>
          <IconChevR className="w-3 h-3 shrink-0" />
          <span className="px-2 py-0.5 rounded bg-white border border-ink/10">Mike Dudarenok</span>
          <IconChevR className="w-3 h-3 shrink-0" />
          <span
            className="px-2 py-0.5 rounded font-semibold text-ink"
            style={{ background: `${from}20`, border: `1px solid ${from}40` }}
          >
            The Northern Star
          </span>
        </div>
      </div>
    );
  }
  if (kind === 'device-grid') {
    return (
      <div className="aspect-[2/1] rounded-2xl bg-canvas border border-ink/10 grid grid-cols-3 gap-3 p-4">
        {['iOS', 'Android', 'Web'].map((p) => (
          <div
            key={p}
            className="rounded-xl border border-ink/10 bg-white p-3 flex flex-col items-center justify-center text-center gap-2"
          >
            <span
              className="w-8 h-8 rounded-lg grid place-items-center text-white text-[10px] font-bold"
              style={{ background: grad }}
            >
              {p.slice(0, 2)}
            </span>
            <span className="text-[10px] uppercase tracking-wider text-ink/60 font-semibold">
              {p}
            </span>
          </div>
        ))}
      </div>
    );
  }
  if (kind === 'airdrop' || kind === 'airdrop-flow') {
    return (
      <div className="aspect-[2/1] rounded-2xl bg-canvas border border-ink/10 grid grid-cols-[1fr_auto_1fr] items-center gap-4 p-5">
        <div className="rounded-xl border border-ink/10 bg-white p-3 text-center">
          <IconUpload className="w-5 h-5 mx-auto text-ink/60 mb-1" />
          <span className="text-[10px] uppercase tracking-wider text-ink/60">Mac</span>
        </div>
        <div className="text-center">
          <span
            className="w-12 h-12 rounded-full grid place-items-center text-white mx-auto"
            style={{ background: grad }}
          >
            <IconAirdrop className="w-6 h-6" />
          </span>
          <span className="block text-[10px] uppercase tracking-wider text-ink/60 mt-1.5">
            AirDrop
          </span>
        </div>
        <div className="rounded-xl border border-ink/10 bg-white p-3 text-center">
          <IconMobile className="w-5 h-5 mx-auto text-ink/60 mb-1" />
          <span className="text-[10px] uppercase tracking-wider text-ink/60">iPhone</span>
        </div>
      </div>
    );
  }
  if (kind === 'qr-code') {
    return (
      <div className="aspect-[2/1] rounded-2xl bg-canvas border border-ink/10 grid grid-cols-[auto_1fr] gap-5 items-center p-5">
        <span
          className="w-28 h-28 rounded-xl grid place-items-center text-white"
          style={{ background: grad }}
        >
          <IconQrCode className="w-14 h-14" />
        </span>
        <div>
          <p className="text-sm font-semibold text-ink">Scan with your phone camera</p>
          <p className="text-xs text-ink/60 mt-1 leading-relaxed">
            Opens the download directly. No cloud upload, no email. The link expires in 24 hours.
          </p>
        </div>
      </div>
    );
  }
  if (kind === 'folder-android') {
    return (
      <div className="aspect-[2/1] rounded-2xl bg-canvas border border-ink/10 p-5 flex flex-col items-center justify-center gap-3">
        <div className="flex items-center gap-2 text-xs font-mono text-ink/60">
          <IconMobile className="w-4 h-4" />
          <span>/storage/emulated/0/</span>
          <span
            className="px-2 py-0.5 rounded font-semibold text-ink"
            style={{ background: `${from}20`, border: `1px solid ${from}40` }}
          >
            AudioBooks/
          </span>
        </div>
        <p className="text-xs text-ink/50 text-center">
          Smart AudioBook Player auto-scans this folder.
        </p>
      </div>
    );
  }
  if (kind === 'share-sheet') {
    return (
      <div className="aspect-[2/1] rounded-2xl bg-canvas border border-ink/10 p-5 flex items-center gap-3">
        <span className="w-12 h-12 rounded-xl bg-white border border-ink/10 grid place-items-center">
          <IconShare className="w-5 h-5 text-ink/60" />
        </span>
        <IconChevR className="w-4 h-4 text-ink/40" />
        <div className="flex items-center gap-2">
          {[0, 1].map((i) => (
            <span key={i} className="w-10 h-10 rounded-lg bg-white border border-ink/10" />
          ))}
          <span
            className="w-10 h-10 rounded-lg grid place-items-center text-white font-bold text-[10px]"
            style={{ background: grad }}
          >
            {app.glyph}
          </span>
        </div>
      </div>
    );
  }
  if (kind === 'app-listing') {
    return (
      <div className="aspect-[2/1] rounded-2xl bg-canvas border border-ink/10 p-4">
        <div className="bg-white rounded-xl border border-ink/10 p-3 flex items-center gap-3">
          <span className="w-12 h-12 rounded-lg shrink-0" style={{ background: grad }} />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold text-ink truncate">The Northern Star</p>
            <p className="text-xs text-ink/55 truncate">Mike Dudarenok · 4h 38m</p>
            <div className="mt-1.5 flex items-center gap-1.5">
              <span className="text-[10px] tabular-nums text-ink/50">CH 01</span>
              <div className="flex-1 h-0.5 rounded-full bg-ink/[0.08]">
                <div className="w-0 h-full rounded-full bg-ink" />
              </div>
              <span className="text-[10px] tabular-nums text-ink/50">0%</span>
            </div>
          </div>
        </div>
      </div>
    );
  }
  if (kind === 'complete') {
    return (
      <div
        className="aspect-[2/1] rounded-2xl grid place-items-center text-center p-6"
        style={{ background: `${from}10` }}
      >
        <div>
          <span
            className="w-16 h-16 mx-auto rounded-full grid place-items-center text-white shadow-card"
            style={{ background: grad }}
          >
            <IconCheck className="w-8 h-8" />
          </span>
          <p className="mt-3 font-bold text-ink">Ready to listen</p>
          <p className="text-xs text-ink/60 mt-1">Open {app.name} to start.</p>
        </div>
      </div>
    );
  }
  if (kind === 'ios-share-sheet')
    return (
      <PhoneFrame>
        <IOSShareSheet app={app} />
      </PhoneFrame>
    );
  if (kind === 'android-files')
    return (
      <PhoneFrame platform="android">
        <AndroidFiles app={app} />
      </PhoneFrame>
    );
  return <div className="aspect-[2/1] rounded-2xl bg-canvas border border-ink/10" />;
}

function PhoneFrame({
  platform = 'ios',
  children,
}: {
  platform?: 'ios' | 'android';
  children: ReactNode;
}) {
  return (
    <div className="aspect-[2/1] rounded-2xl bg-canvas border border-ink/10 grid place-items-center p-4 overflow-hidden">
      <div className="relative" style={{ width: 240, height: 380 }}>
        <div className="absolute inset-0 rounded-[34px] bg-ink shadow-float" />
        <div className="absolute inset-[3px] rounded-[31px] bg-ink" />
        <div className="absolute inset-[6px] rounded-[28px] bg-white overflow-hidden flex flex-col">
          <div className="h-7 px-5 flex items-center justify-between text-[10px] font-semibold text-ink/90 shrink-0">
            <span className="tabular-nums">9:41</span>
            <div className="flex items-center gap-1">
              <IconSignal className="w-3 h-3" />
              <IconWifiBars className="w-3 h-3" />
              <IconBattery className="w-4 h-4" />
            </div>
          </div>
          <div className="flex-1 min-h-0 relative">{children}</div>
        </div>
        {platform === 'ios' && (
          <div className="absolute top-1.5 left-1/2 -translate-x-1/2 w-20 h-5 bg-ink rounded-b-2xl" />
        )}
        <div className="absolute bottom-2 left-1/2 -translate-x-1/2 w-16 h-1 rounded-full bg-ink/30" />
      </div>
    </div>
  );
}

interface ShareItem {
  id: string;
  glyph: string;
  color?: string;
  gradient?: string;
  target?: boolean;
}

function IOSShareSheet({ app }: { app: ListenerApp }) {
  const [from, to] = app.gradient;
  const grad = `linear-gradient(135deg, ${from}, ${to})`;
  const shareRow: ShareItem[] = [
    { id: 'airdrop', glyph: 'AD', color: '#3D5BA9' },
    { id: 'msg', glyph: 'M', color: '#34A853' },
    { id: 'mail', glyph: '@', color: '#1F8AC0' },
  ];
  const appRow: ShareItem[] = [
    { id: 'files', glyph: 'F', color: '#1F8AC0' },
    { id: 'books', glyph: 'B', color: '#FF9500' },
    { id: 'target', glyph: app.glyph, gradient: grad, target: true },
    { id: 'drive', glyph: 'D', color: '#34A853' },
  ];
  return (
    <div className="absolute inset-0 flex flex-col">
      <div className="flex-1 bg-ink/[0.02] flex items-center justify-center text-[10px] text-ink/40">
        Files · Downloads
      </div>
      <div className="bg-white border-t border-ink/10 rounded-t-2xl shadow-float p-3 space-y-2">
        <div className="flex items-center gap-2 pb-2 border-b border-ink/5">
          <span
            className="w-7 h-7 rounded-md grid place-items-center text-white text-[8px] font-bold"
            style={{ background: grad }}
          >
            M4B
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[9px] font-semibold text-ink truncate">Northern Star.m4b</p>
            <p className="text-[7px] text-ink/55">Audiobook · 287 MB</p>
          </div>
        </div>
        <div className="flex items-center gap-2 overflow-x-auto">
          {shareRow.map((item) => (
            <span key={item.id} className="flex flex-col items-center gap-1 shrink-0">
              <span
                className="w-9 h-9 rounded-full grid place-items-center text-white text-[10px] font-bold"
                style={{ background: item.color }}
              >
                {item.glyph}
              </span>
              <span className="text-[7px] text-ink/60">
                {item.id === 'airdrop' ? 'AirDrop' : item.id === 'msg' ? 'Messages' : 'Mail'}
              </span>
            </span>
          ))}
        </div>
        <div className="flex items-center gap-2 overflow-x-auto pt-1 border-t border-ink/5">
          {appRow.map((item) => (
            <span
              key={item.id}
              className={`flex flex-col items-center gap-1 shrink-0 ${item.target ? 'relative' : ''}`}
            >
              <span
                className={`w-9 h-9 rounded-lg grid place-items-center text-white text-[10px] font-bold ${item.target ? 'ring-2 ring-offset-1 ring-peach' : ''}`}
                style={{ background: item.gradient || item.color }}
              >
                {item.glyph}
              </span>
              <span className={`text-[7px] ${item.target ? 'text-ink font-bold' : 'text-ink/60'}`}>
                {item.target
                  ? app.name.split(' ')[0]
                  : item.id === 'files'
                    ? 'Files'
                    : item.id === 'books'
                      ? 'Books'
                      : 'Drive'}
              </span>
            </span>
          ))}
        </div>
        <div className="pt-1 border-t border-ink/5 space-y-0.5">
          {[
            { label: `Open in ${app.name}`, highlight: true },
            { label: 'Save to Files', highlight: false },
            { label: 'Mark as ready', highlight: false },
          ].map((a) => (
            <div
              key={a.label}
              className={`flex items-center justify-between text-[9px] py-1 px-1 rounded ${a.highlight ? 'bg-peach/15 text-magenta font-bold' : 'text-ink/70'}`}
            >
              <span>{a.label}</span>
              {a.highlight && <IconCheck className="w-2.5 h-2.5" />}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function AndroidFiles({ app }: { app: ListenerApp }) {
  const [from, to] = app.gradient;
  const grad = `linear-gradient(135deg, ${from}, ${to})`;
  return (
    <div className="absolute inset-0 flex flex-col bg-canvas">
      <div className="px-3 py-2 flex items-center gap-2 border-b border-ink/10 bg-white">
        <span className="text-ink/70 font-bold text-sm">≡</span>
        <span className="text-[10px] font-bold text-ink flex-1 truncate">Files</span>
        <span className="text-ink/50 text-xs">⋮</span>
      </div>
      <div className="px-3 py-1.5 text-[8px] text-ink/55 font-mono border-b border-ink/5 bg-white">
        Internal storage <span className="text-ink/30">›</span>{' '}
        <span className="text-ink font-bold">AudioBooks</span>
      </div>
      <div className="flex-1 overflow-y-auto bg-white">
        <div className="px-3 py-2.5 flex items-center gap-2 bg-peach/15 border-l-2 border-peach">
          <span
            className="w-8 h-8 rounded-md grid place-items-center text-white text-[8px] font-bold shrink-0"
            style={{ background: grad }}
          >
            M4B
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[9px] font-bold text-ink truncate">Northern_Star.m4b</p>
            <p className="text-[7px] text-ink/55">287 MB · Just now</p>
          </div>
          <span className="text-[7px] text-magenta font-bold uppercase tracking-wider">New</span>
        </div>
        {['Solway_Bay.m4b', 'Carricks_Compass_sample.m4a'].map((name, i) => (
          <div key={name} className="px-3 py-2.5 flex items-center gap-2 border-t border-ink/5">
            <span className="w-8 h-8 rounded-md bg-ink/[0.06] grid place-items-center text-ink/40 text-[8px] font-bold shrink-0">
              {name.endsWith('m4b') ? 'M4B' : 'M4A'}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[9px] font-medium text-ink/85 truncate">{name}</p>
              <p className="text-[7px] text-ink/45">
                {i === 0 ? '246 MB · 3 days ago' : '38 MB · Last week'}
              </p>
            </div>
          </div>
        ))}
      </div>
      <span
        className="absolute bottom-3 right-3 w-9 h-9 rounded-full grid place-items-center text-white shadow-card"
        style={{ background: grad }}
      >
        <IconPlus className="w-4 h-4" />
      </span>
    </div>
  );
}
