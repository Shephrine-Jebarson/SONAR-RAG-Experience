import React from 'react';
import { Citation } from '../types';
import { FileText, Globe, FileCode, Presentation, X, Percent, Hash, AlignLeft, ShieldCheck } from 'lucide-react';

interface SourceExcerptModalProps {
  citation: Citation | null;
  onClose: () => void;
}

export const SourceExcerptModal: React.FC<SourceExcerptModalProps> = ({ citation, onClose }) => {
  if (!citation) return null;

  const matchPercent = (citation.relevanceScore * 100).toFixed(1);

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-fade-in">
      <div className="glass border border-[var(--border)] rounded-xl max-w-xl w-full p-5 shadow-2xl relative">

        {/* Modal Header */}
        <div className="flex items-start justify-between border-b border-[var(--border)] pb-3 mb-4">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded bg-[var(--surface-hover)] border border-[var(--border)] text-[var(--accent-cyan)]">
              {citation.type === 'pdf' ? <FileText className="w-5 h-5 text-[#ff5c5c]" /> :
               citation.type === 'url' ? <Globe className="w-5 h-5 text-[var(--accent-cyan)]" /> :
               citation.type === 'pptx' ? <Presentation className="w-5 h-5 text-[#ffb020]" /> :
               <FileCode className="w-5 h-5 text-[var(--accent-violet)]" />}
            </div>

            <div>
              <span className="text-[10px] font-sans text-[var(--text-secondary)] block">
                Cited from
              </span>
              <h3 className="font-sans text-sm text-[var(--text-primary)] font-semibold truncate max-w-md">
                {citation.sourceName}
              </h3>
            </div>
          </div>

          <button
            onClick={onClose}
            className="flex items-center justify-center w-11 h-11 text-[var(--text-secondary)] hover:text-white rounded hover:bg-[var(--surface-hover)] cursor-pointer"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Stats Bar */}
        <div className="grid grid-cols-3 gap-2 mb-4 text-xs font-console">

          <div className="bg-[rgba(0,0,0,0.22)] border border-[var(--border)] p-2 rounded flex flex-col items-center">
            <span className="text-[9px] text-[var(--text-secondary)]">Match</span>
            <span className="text-[var(--accent-cyan)] font-medium flex items-center gap-1">
              <Percent className="w-3 h-3" />
              {matchPercent}%
            </span>
          </div>

          <div className="bg-[rgba(0,0,0,0.22)] border border-[var(--border)] p-2 rounded flex flex-col items-center">
            <span className="text-[9px] text-[var(--text-secondary)]">Reference</span>
            <span className="text-[var(--accent-violet)] font-medium flex items-center gap-1 truncate max-w-full" title={citation.chunkId}>
              <Hash className="w-3 h-3 shrink-0" />
              <span className="truncate">{citation.chunkId}</span>
            </span>
          </div>

          <div className="bg-[rgba(0,0,0,0.22)] border border-[var(--border)] p-2 rounded flex flex-col items-center">
            <span className="text-[9px] text-[var(--text-secondary)]">Location</span>
            <span className="text-[#ffb020] font-medium truncate max-w-full">
              {citation.pageOrSection || 'Section 1'}
            </span>
          </div>

        </div>

        {/* Excerpt Body */}
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 text-xs font-sans text-[var(--text-secondary)]">
            <AlignLeft className="w-3.5 h-3.5 text-[var(--accent-cyan)]" />
            <span>Excerpt</span>
          </div>

          <div className="bg-[rgba(0,0,0,0.3)] border border-[var(--surface-hover)] rounded-lg p-3.5 text-xs font-humanist text-[var(--text-primary)] leading-relaxed max-h-60 overflow-y-auto shadow-inner">
            "{citation.excerptText}"
          </div>
        </div>

        {/* Footer */}
        <div className="mt-4 pt-3 border-t border-[var(--border)] flex items-center justify-between text-[10px] font-console text-[var(--text-secondary)]">
          <span className="flex items-center gap-1">
            <ShieldCheck className="w-3.5 h-3.5 text-[var(--accent-cyan)]" />
            Verified source
          </span>

          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded bg-[var(--surface-hover)] hover:bg-[var(--border)] text-[var(--text-primary)] border border-[var(--border)] font-sans text-xs font-medium cursor-pointer"
          >
            Close
          </button>
        </div>

      </div>
    </div>
  );
};
