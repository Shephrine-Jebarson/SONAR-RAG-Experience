import React, { useState, useRef } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { RAGSource, SourceType, DiscreteProcessingStep } from '../types';
import {
  FileText,
  FileCode,
  Presentation,
  Globe,
  UploadCloud,
  Plus,
  X,
  Check,
  Zap,
  ArrowRight
} from 'lucide-react';

interface SourcePanelProps {
  sources: RAGSource[];
  onUploadFile: (file: File) => void;
  onAddUrl: (url: string) => void;
  onRemoveSource: (id: string) => void;
  onProcessSources: () => void;
  isProcessing: boolean;
  processingSteps: DiscreteProcessingStep[];
}

type Tab = 'documents' | 'urls';

export const SourcePanel: React.FC<SourcePanelProps> = ({
  sources,
  onUploadFile,
  onAddUrl,
  onRemoveSource,
  onProcessSources,
  isProcessing,
  processingSteps
}) => {
  const [tab, setTab] = useState<Tab>('documents');
  const [urlInput, setUrlInput] = useState('');
  const [urlError, setUrlError] = useState('');
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleAddUrlChip = (e: React.FormEvent) => {
    e.preventDefault();
    setUrlError('');
    if (!urlInput || !urlInput.trim()) return;

    let targetUrl = urlInput.trim();
    if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
      targetUrl = 'https://' + targetUrl;
    }

    try {
      new URL(targetUrl);
      onAddUrl(targetUrl);
      setUrlInput('');
    } catch {
      setUrlError("That doesn't look like a valid URL.");
    }
  };

  const handleDragOver = (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); setIsDragOver(true); };
  const handleDragLeave = (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); setIsDragOver(false); };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      Array.from(e.dataTransfer.files).forEach(file => onUploadFile(file));
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      Array.from(e.target.files).forEach(file => onUploadFile(file));
    }
  };

  const getSourceIcon = (type: SourceType) => {
    switch (type) {
      case 'pdf': return <FileText className="w-4 h-4 text-[#ff5c5c]" />;
      case 'pptx': return <Presentation className="w-4 h-4 text-[#ffb020]" />;
      case 'url': return <Globe className="w-4 h-4 text-[var(--accent-cyan)]" />;
      default: return <FileCode className="w-4 h-4 text-[var(--accent-violet)]" />;
    }
  };

  const pendingSourcesCount = sources.filter(s => s.status === 'pending').length;
  const canProcess = !isProcessing && sources.length > 0;

  return (
    <div className="glass rounded-3xl p-6 lg:p-7 flex flex-col h-full min-h-0 gap-5">

      <div className="flex items-center gap-3 shrink-0">
        <div className="w-9 h-9 rounded-xl bg-[var(--accent-cyan)]/12 border border-[var(--accent-cyan)]/25 flex items-center justify-center text-[var(--accent-cyan)]">
          <UploadCloud className="w-4.5 h-4.5" />
        </div>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-[var(--text-primary)]">Sources</h2>
          <p className="text-xs text-[var(--text-secondary)] truncate">Documents and links to search</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 p-1 rounded-xl glass-inset shrink-0">
        {(['documents', 'urls'] as Tab[]).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 px-3 py-2 rounded-lg text-xs font-medium transition-smooth cursor-pointer ${
              tab === t
                ? 'bg-[var(--surface-hover)] text-[var(--text-primary)] shadow-sm'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            {t === 'documents' ? 'Documents' : 'Web links'}
          </button>
        ))}
      </div>

      {tab === 'documents' ? (
        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          className={`rounded-2xl border border-dashed p-6 text-center cursor-pointer transition-smooth shrink-0 ${
            isDragOver
              ? 'border-[var(--accent-cyan)] bg-[var(--accent-cyan)]/8 scale-[1.01]'
              : 'border-[var(--border-strong)] hover:border-[var(--accent-cyan)]/45 hover:bg-[var(--surface-hover)]'
          }`}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.txt,.pptx"
            multiple
            onChange={handleFileChange}
            className="hidden"
          />
          <div className="flex flex-col items-center gap-2 pointer-events-none">
            <div className="w-11 h-11 rounded-2xl glass-inset flex items-center justify-center">
              <UploadCloud className="w-5 h-5 text-[var(--accent-cyan)]" />
            </div>
            <div className="text-sm font-medium text-[var(--text-primary)]">
              Drop files or <span className="text-[var(--accent-cyan)]">browse</span>
            </div>
            <p className="text-[11px] text-[var(--text-muted)]">PDF · TXT · PPTX</p>
          </div>
        </div>
      ) : (
        <form onSubmit={handleAddUrlChip} className="flex flex-col gap-2 shrink-0">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Globe className="w-4 h-4 text-[var(--text-muted)] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                placeholder="Paste a link…"
                aria-label="Web page URL"
                className="w-full glass-inset rounded-xl pl-10 pr-3 py-3 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent-cyan)]/50 transition-smooth"
              />
            </div>
            <button
              type="submit"
              aria-label="Add link"
              className="flex items-center justify-center w-12 h-12 rounded-xl bg-accent-gradient text-[#06131a] transition-smooth hover:brightness-110 active:scale-[0.97] cursor-pointer shrink-0"
            >
              <Plus className="w-4.5 h-4.5" />
            </button>
          </div>
          {urlError && <span className="text-[11px] text-[#ff5c5c] px-1">{urlError}</span>}
        </form>
      )}

      {/* Source list */}
      <div className="flex-1 min-h-0 flex flex-col gap-2 overflow-y-auto -mr-2 pr-2">
        {sources.length === 0 ? (
          <div className="rounded-2xl glass-inset px-4 py-5 text-center">
            <p className="text-xs text-[var(--text-muted)]">Nothing added yet.</p>
          </div>
        ) : (
          <AnimatePresence initial={false}>
            {sources.map(src => (
              <motion.div
                key={src.id}
                layout
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, x: -8 }}
                transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
                className="glass-inset rounded-xl p-3 flex items-center justify-between gap-2 group hover:border-[var(--border-strong)] transition-smooth"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-8 h-8 rounded-lg bg-[var(--surface)] border border-[var(--border)] flex items-center justify-center shrink-0">
                    {getSourceIcon(src.type)}
                  </div>
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-[var(--text-primary)] truncate">{src.name}</div>
                    <div className="flex items-center gap-1.5 text-[11px] text-[var(--text-muted)] mt-0.5">
                      <span className="uppercase">{src.type}</span>
                      {src.chunkCount ? <span>· {src.chunkCount} chunks</span> : null}
                      <span
                        className={`px-1.5 rounded ${
                          src.status === 'indexed' ? 'bg-[var(--accent-cyan)]/12 text-[var(--accent-cyan)]'
                          : src.status === 'pending' ? 'bg-[#ffb020]/12 text-[#ffb020]'
                          : 'bg-[#ff5c5c]/12 text-[#ff5c5c]'
                        }`}
                      >
                        {src.status === 'indexed' ? 'Ready' : src.status === 'pending' ? 'Not processed' : src.status}
                      </span>
                    </div>
                  </div>
                </div>

                <button
                  onClick={() => onRemoveSource(src.id)}
                  aria-label={`Remove ${src.name}`}
                  title="Remove source"
                  className="flex items-center justify-center w-11 h-11 rounded-lg text-[var(--text-muted)] hover:text-[#ff5c5c] hover:bg-[#ff5c5c]/10 transition-smooth cursor-pointer shrink-0"
                >
                  <X className="w-4 h-4" />
                </button>
              </motion.div>
            ))}
          </AnimatePresence>
        )}
      </div>

      {/* Processing steps */}
      <AnimatePresence>
        {isProcessing && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden shrink-0"
          >
            <div className="grid grid-cols-2 gap-1.5">
              {processingSteps.map(step => {
                const done = step.status === 'completed';
                const active = step.status === 'in_progress';
                return (
                  <div
                    key={step.id}
                    className={`px-2.5 py-2 rounded-lg border text-[11px] flex items-center gap-1.5 transition-smooth ${
                      done ? 'bg-[var(--accent-cyan)]/8 border-[var(--accent-cyan)]/25 text-[var(--accent-cyan)]'
                      : active ? 'bg-[var(--accent-violet)]/8 border-[var(--accent-violet)]/30 text-[var(--accent-violet)]'
                      : 'glass-inset text-[var(--text-muted)]'
                    }`}
                  >
                    {done
                      ? <Check className="w-3 h-3 shrink-0" strokeWidth={3} />
                      : <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${active ? 'bg-[var(--accent-violet)] animate-dot' : 'bg-[var(--text-muted)]'}`} />}
                    <span className="truncate">{step.label}</span>
                  </div>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Process action */}
      <div className="shrink-0 flex flex-col gap-2">
        <button
          onClick={onProcessSources}
          disabled={!canProcess}
          className={`w-full h-12 rounded-xl text-sm font-semibold flex items-center justify-center gap-2 transition-smooth ${
            isProcessing
              ? 'glass-inset text-[var(--accent-violet)] cursor-wait'
              : canProcess
              ? pendingSourcesCount > 0
                ? 'bg-[var(--accent-cyan)]/14 border border-[var(--accent-cyan)]/40 text-[var(--accent-cyan)] hover:bg-[var(--accent-cyan)]/22 cursor-pointer active:scale-[0.99]'
                : 'glass-inset text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer'
              : 'glass-inset text-[var(--text-muted)] cursor-not-allowed'
          }`}
        >
          {isProcessing
            ? <><Zap className="w-4 h-4 animate-dot" /><span>Processing…</span></>
            : <><span>Process sources</span><ArrowRight className="w-4 h-4" /></>}
        </button>

        <p className="text-[11px] text-[var(--text-muted)] text-center leading-relaxed">
          {isProcessing
            ? 'Extracting text, creating embeddings, and indexing.'
            : pendingSourcesCount > 0
            ? `${pendingSourcesCount} source${pendingSourcesCount > 1 ? 's' : ''} waiting to be processed.`
            : sources.length > 0
            ? 'All sources are indexed and searchable.'
            : 'Add a source to get started.'}
        </p>
      </div>
    </div>
  );
};
