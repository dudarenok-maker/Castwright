import { useRef, useState } from 'react';
import { IconUpload, IconSpinner } from '../lib/icons';
import { SectionLabel, MixedHeading, PrimaryButton } from '../components/primitives';
import { api } from '../lib/api';
import { SAMPLE_MANUSCRIPT_MD } from '../mocks/canned-data';
import type { UploadResponse } from '../lib/types';

interface Props {
  onUploaded: (res: UploadResponse) => void;
}

export function UploadView({ onUploaded }: Props) {
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy]         = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pastedText, setPastedText] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function processText(args: { text: string; fileName?: string; format?: 'markdown' | 'plaintext' | 'epub' | 'docx' }) {
    setError(null);
    setBusy(true);
    try {
      const res = await api.uploadManuscript(args);
      onUploaded(res);
    } catch (e) {
      setError((e as Error)?.message || 'Upload failed.');
      setBusy(false);
    }
  }

  async function handleFile(file?: File | null) {
    if (!file) return;
    const okExt = /\.(md|markdown|txt|text)$/i.test(file.name);
    if (!okExt) {
      setError(`${file.name.split('.').pop()?.toUpperCase()} files need server conversion (not wired in this prototype). Try .md or .txt.`);
      return;
    }
    const text = await file.text();
    await processText({ text, fileName: file.name });
  }

  async function handleSample() {
    await processText({ text: SAMPLE_MANUSCRIPT_MD, fileName: 'the-northern-star.md', format: 'markdown' });
  }

  return (
    <div className="relative min-h-[calc(100vh-64px)] flex items-center justify-center px-6 py-16">
      <div className="absolute inset-0 bg-gradient-hero-wash opacity-90 pointer-events-none"/>
      <div className="relative max-w-3xl w-full">
        <div className="text-center mb-10">
          <SectionLabel>Start a new project</SectionLabel>
          <div className="mt-5">
            <MixedHeading level="h1" regular="Drop your manuscript to" bold="meet the cast"/>
          </div>
          <p className="mt-4 text-lg text-ink/70">We'll read the book, find every speaking character, and synthesise a voice profile for each one — generated from the prose, not picked from a list.</p>
        </div>

        <div onDragEnter={(e) => { e.preventDefault(); setDragOver(true); }}
             onDragLeave={() => setDragOver(false)}
             onDragOver={(e) => e.preventDefault()}
             onDrop={(e) => { e.preventDefault(); setDragOver(false); handleFile(e.dataTransfer.files?.[0]); }}
             className={`relative bg-white rounded-3xl border-2 border-dashed transition-all p-12 text-center cursor-pointer ${busy ? 'opacity-60 cursor-wait' : ''} ${dragOver ? 'border-peach bg-peach/5 scale-[1.01]' : 'border-ink/15 hover:border-ink/30'}`}
             onClick={() => !busy && fileInputRef.current?.click()}>
          <input ref={fileInputRef} type="file" hidden
                 accept=".md,.markdown,.txt,.text"
                 onChange={(e) => handleFile(e.target.files?.[0])}/>
          <div className="w-16 h-16 mx-auto rounded-full bg-canvas grid place-items-center mb-5">
            {busy ? <IconSpinner className="w-7 h-7 text-magenta"/> : <IconUpload className="w-7 h-7 text-ink"/>}
          </div>
          <p className="text-lg font-semibold text-ink">{busy ? 'Reading manuscript…' : 'Drop a manuscript here'}</p>
          <p className="text-sm text-ink/60 mt-1">{busy ? 'Hashing and registering with the server.' : 'or click to browse files'}</p>
          <div className="mt-6 flex items-center justify-center gap-4 text-xs text-ink/50">
            <span>Markdown</span>·<span>Plain text</span>·<span className="opacity-60">EPUB (server-only)</span>·<span className="opacity-60">DOCX (server-only)</span>
          </div>
        </div>

        {error && (
          <div className="mt-4 px-4 py-3 rounded-2xl bg-rose-50 border border-rose-200 text-sm text-rose-900">
            {error}
          </div>
        )}

        <div className="mt-5 flex items-center justify-center gap-3 text-sm">
          <button disabled={busy} onClick={handleSample}
                  className="px-4 py-2 rounded-full bg-white border border-ink/15 text-ink/80 hover:border-ink/30 hover:text-ink disabled:opacity-50">
            Use sample manuscript
          </button>
          <button disabled={busy} onClick={() => setPasteOpen(v => !v)}
                  className="px-4 py-2 rounded-full bg-white border border-ink/15 text-ink/80 hover:border-ink/30 hover:text-ink disabled:opacity-50">
            {pasteOpen ? 'Hide paste' : 'Paste text'}
          </button>
        </div>

        {pasteOpen && (
          <div className="mt-4 bg-white rounded-3xl border border-ink/10 p-5">
            <textarea value={pastedText} onChange={(e) => setPastedText(e.target.value)}
                      placeholder="# Chapter 1&#10;&#10;Paste your manuscript here…"
                      className="w-full h-44 rounded-xl border border-ink/10 px-4 py-3 text-sm font-mono text-ink/80 focus:outline-none focus:border-peach"/>
            <div className="mt-3 flex justify-end">
              <PrimaryButton variant="dark"
                             onClick={() => !busy && pastedText.trim() && processText({ text: pastedText, fileName: 'pasted.md', format: 'markdown' })}>
                Upload pasted text
              </PrimaryButton>
            </div>
          </div>
        )}

        <p className="text-center text-xs text-ink/40 mt-8">Working on a series? Voices from previous books are available in your library — we'll match characters automatically.</p>
      </div>
    </div>
  );
}
