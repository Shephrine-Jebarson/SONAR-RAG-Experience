import React, { useEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { TranscriptTurn, Citation, VoiceState } from '../types';
import {
  Bot,
  Volume2,
  FileText,
  Globe,
  Presentation,
  FileCode,
  ChevronRight,
  Sparkles
} from 'lucide-react';

interface AnswerPanelProps {
  lastTurn: TranscriptTurn | null;
  voiceState: VoiceState;
  onSelectCitation: (citation: Citation) => void;
  onReplayAudio: (text: string) => void;
  spokenCharIndex: number | null;
  speakingTurnId: string | null;
}

const getSourceIcon = (type: string) => {
  switch (type) {
    case 'pdf': return <FileText className="w-3.5 h-3.5 text-[#ff5c5c]" />;
    case 'url': return <Globe className="w-3.5 h-3.5 text-[var(--accent-cyan)]" />;
    case 'pptx': return <Presentation className="w-3.5 h-3.5 text-[#ffb020]" />;
    default: return <FileCode className="w-3.5 h-3.5 text-[var(--accent-violet)]" />;
  }
};

export const AnswerPanel: React.FC<AnswerPanelProps> = ({
  lastTurn,
  voiceState,
  onSelectCitation,
  onReplayAudio,
  spokenCharIndex,
  speakingTurnId
}) => {
  const isThinking = voiceState === 'processing';
  const spokenWordRef = useRef<HTMLSpanElement | null>(null);

  // Keep the word being spoken in view as TTS progresses through a long answer.
  useEffect(() => {
    if (spokenWordRef.current) {
      spokenWordRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [spokenCharIndex]);

  const renderAnswerText = (text: string, turnId: string) => {
    if (turnId !== speakingTurnId || spokenCharIndex === null) {
      return <>{text}</>;
    }
    // Highlight the word currently being spoken, in sync with TTS boundary events.
    let end = spokenCharIndex;
    while (end < text.length && text[end] !== ' ') end++;
    return (
      <>
        <span>{text.slice(0, spokenCharIndex)}</span>
        <span
          ref={spokenWordRef}
          className="bg-[#ffb020]/25 text-[#ffb020] rounded px-0.5 -mx-0.5 transition-colors duration-150"
        >
          {text.slice(spokenCharIndex, end)}
        </span>
        <span>{text.slice(end)}</span>
      </>
    );
  };

  return (
    <div className="glass rounded-3xl p-6 lg:p-7 flex flex-col h-full min-h-0">

      <div className="flex items-center gap-3 pb-5 mb-5 border-b border-[var(--border)] shrink-0">
        <div className="w-9 h-9 rounded-xl bg-[#ffb020]/10 border border-[#ffb020]/25 flex items-center justify-center text-[#ffb020]">
          <Bot className="w-4.5 h-4.5" />
        </div>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-[var(--text-primary)]">Answer</h2>
          <p className="text-xs text-[var(--text-secondary)] truncate">
            {lastTurn ? 'Latest response with its sources' : 'Responses appear here'}
          </p>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto -mr-2 pr-2">
        <AnimatePresence mode="wait">
          {isThinking && !lastTurn ? (
            <motion.div
              key="thinking"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="h-full flex flex-col items-center justify-center text-center gap-3"
            >
              <Sparkles className="w-6 h-6 text-[var(--accent-violet)] animate-dot" />
              <p className="text-sm text-[var(--text-secondary)]">Searching your sources…</p>
            </motion.div>
          ) : lastTurn ? (
            <motion.div
              key={lastTurn.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
              className="flex flex-col gap-5"
            >
              <div className="flex items-center justify-between gap-3">
                <span className="text-[11px] font-console text-[var(--text-muted)]">
                  {new Date(lastTurn.timestamp).toLocaleTimeString()}
                  {lastTurn.ragLatencyMs ? ` · ${lastTurn.ragLatencyMs}ms` : ''}
                </span>
                <button
                  onClick={() => onReplayAudio(lastTurn.aiResponseText)}
                  title="Replay this answer"
                  aria-label="Replay this answer"
                  className="px-3 py-1.5 rounded-lg bg-[#ffb020]/10 hover:bg-[#ffb020]/18 border border-[#ffb020]/25 text-[#ffb020] text-xs font-medium flex items-center gap-1.5 cursor-pointer transition-smooth active:scale-[0.97]"
                >
                  <Volume2 className="w-3.5 h-3.5" />
                  <span>Replay</span>
                </button>
              </div>

              <p className="text-[15px] lg:text-base font-humanist text-[var(--text-primary)] leading-[1.75]">
                {renderAnswerText(lastTurn.aiResponseText, lastTurn.id)}
              </p>

              {lastTurn.citations && lastTurn.citations.length > 0 && (
                <div className="pt-4 border-t border-[var(--border)] flex flex-col gap-2.5">
                  <span className="text-[11px] uppercase tracking-wider text-[var(--text-muted)]">
                    Sources · {lastTurn.citations.length}
                  </span>
                  <div className="flex flex-col gap-2">
                    {lastTurn.citations.map((cit, idx) => (
                      <button
                        key={idx}
                        onClick={() => onSelectCitation(cit)}
                        className="glass-inset hover:border-[var(--accent-cyan)]/45 rounded-xl px-3 py-2.5 flex items-center gap-2.5 text-left transition-smooth cursor-pointer group hover:translate-x-0.5"
                      >
                        {getSourceIcon(cit.type)}
                        <span className="flex-1 min-w-0 text-xs font-medium text-[var(--text-primary)] group-hover:text-[var(--accent-cyan)] truncate transition-smooth">
                          {cit.sourceName}
                        </span>
                        {cit.pageOrSection && (
                          <span className="text-[10px] text-[var(--text-muted)] shrink-0 hidden sm:inline">
                            {cit.pageOrSection}
                          </span>
                        )}
                        <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-[var(--accent-cyan)]/12 text-[var(--accent-cyan)] font-semibold shrink-0">
                          {(cit.relevanceScore * 100).toFixed(0)}%
                        </span>
                        <ChevronRight className="w-3.5 h-3.5 text-[var(--text-muted)] group-hover:text-[var(--accent-cyan)] shrink-0 transition-smooth" />
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </motion.div>
          ) : (
            <motion.div
              key="empty"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.2 }}
              className="h-full flex flex-col items-center justify-center text-center gap-3 py-10"
            >
              <div className="w-14 h-14 rounded-2xl glass-inset flex items-center justify-center">
                <Bot className="w-6 h-6 text-[var(--text-muted)]" />
              </div>
              <p className="text-sm font-medium text-[var(--text-secondary)]">No answer yet</p>
              <p className="text-xs text-[var(--text-muted)] max-w-[15rem] leading-relaxed">
                Ask a question once your sources are ready — the answer and the passages it came from will show up here.
              </p>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
};
