import React from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { VoiceState, HealthCheckResult, RAGSource } from '../types';
import { AudioWaveform, Database, History, SlidersHorizontal } from 'lucide-react';
import { OnboardingSteps } from './OnboardingSteps';
import { VOICE_STATE_COLOR, VOICE_STATE_LABEL, isLiveState } from './voiceStateStyles';

interface HeaderConsoleProps {
  voiceState: VoiceState;
  health: HealthCheckResult;
  sources: RAGSource[];
  onOpenSettings: () => void;
  onOpenHistory: () => void;
  historyCount: number;
  hasSources: boolean;
  isProcessingSources: boolean;
  hasIndexedSources: boolean;
  hasConversation: boolean;
}

export const HeaderConsole: React.FC<HeaderConsoleProps> = ({
  voiceState,
  health,
  sources,
  onOpenSettings,
  onOpenHistory,
  historyCount,
  hasSources,
  isProcessingSources,
  hasIndexedSources,
  hasConversation
}) => {
  const prefersReducedMotion = useReducedMotion();
  const indexedCount = sources.filter(s => s.status === 'indexed').length;
  const color = VOICE_STATE_COLOR[voiceState];
  const live = !prefersReducedMotion && isLiveState(voiceState);

  const healthColor =
    health.status === 'online'   ? 'var(--accent-cyan)'
    : health.status === 'degraded' ? '#ffb020'
    : health.status === 'checking' ? 'var(--text-muted)'
    : '#ff5c5c';

  return (
    <header className="w-full border-b border-[var(--border)] px-5 md:px-8 py-4 shrink-0">
      <div className="max-w-[1600px] mx-auto flex flex-col lg:flex-row items-center justify-between gap-4">

        {/* Brand + live state */}
        <div className="flex items-center gap-3 w-full lg:w-auto justify-between lg:justify-start shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-accent-gradient flex items-center justify-center text-[#06131a] shadow-lg">
              <AudioWaveform className="w-[18px] h-[18px]" />
            </div>
            <div className="leading-tight">
              <div className="text-[15px] font-bold text-[var(--text-primary)] tracking-tight">SONAR-RAG</div>
              <div className="text-[11px] text-[var(--text-muted)] -mt-0.5">Voice knowledge assistant</div>
            </div>
          </div>

          <div className="flex items-center gap-2 pl-3 pr-3.5 py-1.5 rounded-full glass">
            <motion.span
              animate={{ opacity: live ? [1, 0.42, 1] : 1 }}
              transition={{ duration: 1.7, repeat: live ? Infinity : 0, ease: 'easeInOut' }}
              className="w-1.5 h-1.5 rounded-full shrink-0"
              style={{ backgroundColor: color, boxShadow: `0 0 8px ${color}` }}
            />
            <span className="text-[11px] font-console font-semibold tracking-wide uppercase" style={{ color }}>
              {VOICE_STATE_LABEL[voiceState]}
            </span>
          </div>
        </div>

        {/* Setup progress */}
        <OnboardingSteps
          hasSources={hasSources}
          isProcessing={isProcessingSources}
          hasIndexedSources={hasIndexedSources}
          hasConversation={hasConversation}
        />

        {/* Meta + actions */}
        <div className="flex items-center gap-2 w-full lg:w-auto justify-between lg:justify-end">

          <div className="flex items-center gap-2 text-xs font-console text-[var(--text-secondary)] glass px-3.5 py-2 rounded-full">
            <Database className="w-3.5 h-3.5 text-[var(--accent-cyan)]" />
            <span className="text-[var(--text-primary)] font-semibold">{indexedCount}/{sources.length}</span>
            <span className="hidden sm:inline">ready</span>
          </div>

          <div className="flex items-center gap-2 text-xs font-console glass px-3.5 py-2 rounded-full">
            <motion.span
              animate={health.status === 'checking'
                ? { opacity: [1, 0.3, 1] }
                : health.status === 'online'
                ? { scale: [1, 1.25, 1], opacity: [1, 0.7, 1] }
                : { opacity: 1 }
              }
              transition={{ duration: health.status === 'online' ? 2.4 : 1.1, repeat: Infinity, ease: 'easeInOut' }}
              className="w-2 h-2 rounded-full shrink-0"
              style={{ backgroundColor: healthColor, boxShadow: `0 0 6px ${healthColor}` }}
            />
            <span className="font-medium" style={{ color: healthColor }}>
              {health.status === 'online'
                ? `Online · ${health.latencyMs}ms`
                : health.status === 'degraded'
                ? 'Degraded'
                : health.status === 'checking'
                ? 'Checking…'
                : 'Offline'}
            </span>
          </div>

          <button
            onClick={onOpenHistory}
            aria-label={`Open conversation history${historyCount ? `, ${historyCount} turns` : ''}`}
            title="Conversation history"
            className="relative flex items-center gap-2 h-11 px-3.5 rounded-full glass text-[var(--text-secondary)] hover:text-[var(--accent-cyan)] hover:bg-[var(--surface-hover)] transition-smooth cursor-pointer active:scale-[0.97]"
          >
            <History className="w-4 h-4" />
            <span className="text-xs font-medium hidden sm:inline">History</span>
            {historyCount > 0 && (
              <span className="min-w-[18px] h-[18px] px-1 rounded-full bg-[var(--accent-cyan)] text-[#06131a] text-[10px] font-bold flex items-center justify-center">
                {historyCount > 99 ? '99+' : historyCount}
              </span>
            )}
          </button>

          <button
            onClick={onOpenSettings}
            aria-label="Open settings"
            title="Settings"
            className="flex items-center justify-center w-11 h-11 rounded-full glass text-[var(--text-secondary)] hover:text-[var(--accent-cyan)] hover:bg-[var(--surface-hover)] transition-smooth cursor-pointer active:scale-[0.97]"
          >
            <SlidersHorizontal className="w-4 h-4" />
          </button>

        </div>
      </div>
    </header>
  );
};
