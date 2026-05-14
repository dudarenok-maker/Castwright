import { useRef, useState } from 'react';
import { IconUpload, IconSpinner } from '../lib/icons';
import { SectionLabel, MixedHeading, PrimaryButton } from '../components/primitives';
import { api } from '../lib/api';
import type { UploadArgs } from '../lib/api';
import { SAMPLE_MANUSCRIPT_MD } from '../mocks/canned-data';
import { MODEL_OPTION_GROUPS } from '../lib/models';
import { useAppDispatch, useAppSelector } from '../store';
import { uiActions } from '../store/ui-slice';
import { manuscriptActions } from '../store/manuscript-slice';

const TEXT_EXT_RE = /\.(md|markdown|txt|text)$/i;
const BINARY_EXT_RE = /\.(pdf|epub)$/i;

export function UploadView() {
  const dispatch = useAppDispatch();
  const selectedModel = useAppSelector(s => s.ui.selectedModel);
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy]         = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pastedText, setPastedText] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function processUpload(args: UploadArgs) {
    setError(null);
    setBusy(true);
    try {
      const res = await api.importManuscript(args);
      dispatch(manuscriptActions.setImportCandidate({ tempId: res.tempId, ...res.candidate }));
    } catch (e) {
      setError((e as Error)?.message || 'Import failed.');
      setBusy(false);
    }
  }

  async function handleFile(file?: File | null) {
    if (!file) return;
    if (TEXT_EXT_RE.test(file.name)) {
      const text = await file.text();
      await processUpload({ text, fileName: file.name });
      return;
    }
    if (BINARY_EXT_RE.test(file.name)) {
      await processUpload({ file, fileName: file.name });
      return;
    }
    setError(`${file.name.split('.').pop()?.toUpperCase()} files aren't supported. Try .md, .txt, .pdf, or .epub.`);
  }

  async function handleSample() {
    await processUpload({ text: SAMPLE_MANUSCRIPT_MD, fileName: 'the-northern-star.md', format: 'markdown' });
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

        <div className="mb-5 flex items-center justify-center gap-3 text-sm">
          <label htmlFor="model-select" className="text-ink/60">Analysis model</label>
          <select id="model-select" value={selectedModel} disabled={busy}
                  onChange={(e) => dispatch(uiActions.setSelectedModel(e.target.value))}
                  className="px-3 py-1.5 rounded-full bg-white border border-ink/15 text-ink/80 hover:border-ink/30 focus:outline-none focus:border-peach disabled:opacity-50">
            {MODEL_OPTION_GROUPS.map(g => (
              <optgroup key={g.engine} label={g.label}>
                {g.models.map(m => (
                  <option key={m.id} value={m.id}>{m.label}{m.hint ? ` — ${m.hint}` : ''}</option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>

        <div onDragEnter={(e) => { e.preventDefault(); setDragOver(true); }}
             onDragLeave={() => setDragOver(false)}
             onDragOver={(e) => e.preventDefault()}
             onDrop={(e) => { e.preventDefault(); setDragOver(false); handleFile(e.dataTransfer.files?.[0]); }}
             className={`relative bg-white rounded-3xl border-2 border-dashed transition-all p-12 text-center cursor-pointer ${busy ? 'opacity-60 cursor-wait' : ''} ${dragOver ? 'border-peach bg-peach/5 scale-[1.01]' : 'border-ink/15 hover:border-ink/30'}`}
             onClick={() => !busy && fileInputRef.current?.click()}>
          <input ref={fileInputRef} type="file" hidden
                 accept=".md,.markdown,.txt,.text,.pdf,.epub"
                 onChange={(e) => handleFile(e.target.files?.[0])}/>
          <div className="w-16 h-16 mx-auto rounded-full bg-canvas grid place-items-center mb-5">
            {busy ? <IconSpinner className="w-7 h-7 text-magenta"/> : <IconUpload className="w-7 h-7 text-ink"/>}
          </div>
          <p className="text-lg font-semibold text-ink">{busy ? 'Reading manuscript…' : 'Drop a manuscript here'}</p>
          <p className="text-sm text-ink/60 mt-1">{busy ? 'Hashing and registering with the server.' : 'or click to browse files'}</p>
          <div className="mt-6 flex items-center justify-center gap-4 text-xs text-ink/50">
            <span>Markdown</span>·<span>Plain text</span>·<span>EPUB</span>·<span>PDF</span>
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
                             onClick={() => !busy && pastedText.trim() && processUpload({ text: pastedText, fileName: 'pasted.md', format: 'markdown' })}>
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
