import React, { useEffect, useRef, useState } from 'react';
import { TranscriptTurn, Citation } from '../types';
import {
  MessageSquare,
  Volume2,
  Download,
  Trash2,
  Lock,
  Unlock,
  FileText,
  Globe,
  Presentation,
  FileCode,
  User,
  Bot,
  X
} from 'lucide-react';

interface HistoryDrawerProps {
  open: boolean;
  onClose: () => void;
  transcript: TranscriptTurn[];
  onSelectCitation: (citation: Citation) => void;
  onClearTranscript: () => void;
  onReplayAudio: (text: string) => void;
  spokenCharIndex: number | null;
  speakingTurnId: string | null;
}

export const HistoryDrawer: React.FC<HistoryDrawerProps> = ({
  open,
  onClose,
  transcript,
  onSelectCitation,
  onClearTranscript,
  onReplayAudio,
  spokenCharIndex,
  speakingTurnId
}) => {
  const [autoScroll, setAutoScroll] = useState<boolean>(true);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const spokenWordRef = useRef<HTMLSpanElement | null>(null);

  // Auto-scroll to the newest turn (unchanged behaviour, now inside the drawer)
  useEffect(() => {
    if (open && autoScroll && scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
    }
  }, [transcript, autoScroll, open]);

  useEffect(() => {
    if (spokenWordRef.current) {
      spokenWordRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [spokenCharIndex]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const renderResponseText = (text: string, turnId: string) => {
    if (turnId !== speakingTurnId || spokenCharIndex === null) return <span>{text}</span>;
    let end = spokenCharIndex;
    while (end < text.length && text[end] !== ' ') end++;
    return (
      <>
        <span>{text.slice(0, spokenCharIndex)}</span>
        <span ref={spokenWordRef} className="bg-[#ffb020]/25 text-[#ffb020] rounded px-0.5">
          {text.slice(spokenCharIndex, end)}
        </span>
        <span>{text.slice(end)}</span>
      </>
    );
  };

  const handleExportTranscript = () => {
    if (transcript.length === 0) return;

    const formattedLog = transcript.map((turn, idx) => `
==================================================
TURN #${String(idx + 1).padStart(2, '0')} [${new Date(turn.timestamp).toLocaleTimeString()}]
USER: "${turn.userSpeechText}"
AI RESPONSE: "${turn.aiResponseText}"
LATENCY: ${turn.ragLatencyMs || 0} ms
CITED SOURCES:
${turn.citations.map(c => ` - [${c.type.toUpperCase()}] ${c.sourceName} (${(c.relevanceScore * 100).toFixed(1)}% match)`).join('\n')}
==================================================
`).join('\n');

    const blob = new Blob([formattedLog], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sonar-rag-transcript-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const getSourceIcon = (type: string) => {
    switch (type) {
      case 'pdf': return <FileText className="w-3 h-3 text-[#ff5c5c]" />;
      case 'url': return <Globe className="w-3 h-3 text-[var(--accent-cyan)]" />;
      case 'pptx': return <Presentation className="w-3 h-3 text-[#ffb020]" />;
      default: return <FileCode className="w-3 h-3 text-[var(--accent-violet)]" />;
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* Scrim */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-fade-in"
        onClick={onClose}
        aria-hidden="true"
      />

      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Conversation history"
        className="relative w-full max-w-lg h-full bg-[#0b0f18]/95 backdrop-blur-2xl border-l border-[var(--border)] shadow-2xl flex flex-col animate-drawer-in"
      >
        {/* Drawer header */}
        <div className="flex items-center justify-between gap-3 px-6 py-5 border-b border-[var(--border)]">
          <div>
            <h2 className="text-base font-semibold text-[var(--text-primary)]">Conversation history</h2>
            <p className="text-xs text-[var(--text-secondary)] mt-0.5">
              {transcript.length === 0
                ? 'No turns yet'
                : `${transcript.length} ${transcript.length === 1 ? 'turn' : 'turns'} this session`}
            </p>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setAutoScroll(!autoScroll)}
              aria-pressed={autoScroll}
              aria-label={autoScroll ? 'Disable auto-scroll' : 'Enable auto-scroll'}
              title="Automatically scroll to the latest turn"
              className={`flex items-center justify-center w-11 h-11 rounded-xl border transition-smooth cursor-pointer ${
                autoScroll
                  ? 'bg-[var(--accent-cyan)]/10 border-[var(--accent-cyan)]/30 text-[var(--accent-cyan)]'
                  : 'bg-[var(--surface)] border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]'
              }`}
            >
              {autoScroll ? <Lock className="w-4 h-4" /> : <Unlock className="w-4 h-4" />}
            </button>

            <button
              onClick={handleExportTranscript}
              disabled={transcript.length === 0}
              aria-label="Download this conversation"
              title="Download this conversation"
              className="flex items-center justify-center w-11 h-11 rounded-xl bg-[var(--surface)] border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] transition-smooth cursor-pointer disabled:opacity-35 disabled:cursor-not-allowed"
            >
              <Download className="w-4 h-4" />
            </button>

            <button
              onClick={onClearTranscript}
              disabled={transcript.length === 0}
              aria-label="Clear conversation"
              title="Clear conversation"
              className="flex items-center justify-center w-11 h-11 rounded-xl bg-[var(--surface)] border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[#ff5c5c]/12 hover:text-[#ff5c5c] transition-smooth cursor-pointer disabled:opacity-35 disabled:cursor-not-allowed"
            >
              <Trash2 className="w-4 h-4" />
            </button>

            <button
              onClick={onClose}
              aria-label="Close history"
              title="Close history"
              className="flex items-center justify-center w-11 h-11 rounded-xl bg-[var(--surface)] border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] transition-smooth cursor-pointer ml-1"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Turns */}
        <div ref={scrollContainerRef} className="flex-1 overflow-y-auto px-6 py-5 space-y-4 min-h-0">
          {transcript.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center gap-3 py-16">
              <div className="w-14 h-14 rounded-2xl glass-inset flex items-center justify-center">
                <MessageSquare className="w-6 h-6 text-[var(--text-muted)]" />
              </div>
              <p className="text-sm font-medium text-[var(--text-secondary)]">No conversations yet</p>
              <p className="text-xs text-[var(--text-muted)] max-w-[16rem] leading-relaxed">
                Your questions and answers will be collected here as you talk.
              </p>
            </div>
          ) : (
            transcript.map((turn, index) => (
              <div key={turn.id} className="glass rounded-2xl p-4 flex flex-col gap-3">
                <div className="flex items-center justify-between text-[11px] font-console text-[var(--text-muted)] border-b border-[var(--border)] pb-2">
                  <div className="flex items-center gap-2">
                    <span className="text-[var(--accent-cyan)] font-medium">#{index + 1}</span>
                    <span>·</span>
                    <span>{new Date(turn.timestamp).toLocaleTimeString()}</span>
                  </div>
                  {turn.ragLatencyMs && <span>{turn.ragLatencyMs}ms</span>}
                </div>

                <div className="flex items-start gap-2.5">
                  <div className="w-6 h-6 rounded-lg bg-[var(--accent-cyan)]/10 border border-[var(--accent-cyan)]/25 flex items-center justify-center text-[var(--accent-cyan)] shrink-0 mt-0.5">
                    <User className="w-3.5 h-3.5" />
                  </div>
                  <p className="flex-1 text-xs font-humanist text-[var(--text-primary)] leading-relaxed italic glass-inset rounded-xl p-2.5">
                    "{turn.userSpeechText}"
                  </p>
                </div>

                <div className="flex items-start gap-2.5">
                  <div className="w-6 h-6 rounded-lg bg-[#ffb020]/10 border border-[#ffb020]/25 flex items-center justify-center text-[#ffb020] shrink-0 mt-0.5">
                    <Bot className="w-3.5 h-3.5" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-medium text-[#ffb020]">Answer</span>
                      <button
                        onClick={() => onReplayAudio(turn.aiResponseText)}
                        title="Replay this answer"
                        aria-label="Replay this answer"
                        className="px-2 py-1 rounded-lg text-[11px] text-[#ffb020] hover:bg-[#ffb020]/12 transition-smooth cursor-pointer flex items-center gap-1"
                      >
                        <Volume2 className="w-3.5 h-3.5" />
                        <span>Replay</span>
                      </button>
                    </div>

                    <p className="text-sm font-humanist text-[var(--text-primary)] leading-relaxed mt-1">
                      {renderResponseText(turn.aiResponseText, turn.id)}
                    </p>

                    {turn.citations && turn.citations.length > 0 && (
                      <div className="mt-2.5 pt-2 border-t border-[var(--border)] flex flex-wrap gap-1.5">
                        {turn.citations.map((cit, cIdx) => (
                          <button
                            key={cIdx}
                            onClick={() => onSelectCitation(cit)}
                            className="glass-inset hover:border-[var(--accent-cyan)]/50 rounded-lg px-2.5 py-1 flex items-center gap-1.5 text-[11px] font-console text-[var(--text-primary)] transition-smooth cursor-pointer group"
                          >
                            {getSourceIcon(cit.type)}
                            <span className="truncate max-w-[120px] font-medium group-hover:text-[var(--accent-cyan)]">
                              {cit.sourceName}
                            </span>
                            <span className="text-[10px] px-1 rounded bg-[var(--accent-cyan)]/12 text-[var(--accent-cyan)] font-semibold">
                              {(cit.relevanceScore * 100).toFixed(0)}%
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </aside>
    </div>
  );
};
