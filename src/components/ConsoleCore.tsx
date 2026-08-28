import React from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { VoiceState } from '../types';
import { AudioTelemetry } from '../hooks/useVoiceEngine';
import { WaveformVisualizer } from './WaveformVisualizer';
import { VOICE_STATE_COLOR, isLiveState } from './voiceStateStyles';
import {
  Mic,
  Square,
  Sparkles,
  Volume2,
  Clock,
  RotateCcw,
  SlidersHorizontal,
  UploadCloud,
  Zap
} from 'lucide-react';

interface ConsoleCoreProps {
  voiceState: VoiceState;
  telemetry: AudioTelemetry;
  interimTranscript: string;
  systemMessage: string;
  hasSources: boolean;
  hasIndexedSources: boolean;
  isProcessingSources: boolean;
  onStartConversation: () => void;
  onStopConversation: () => void;
  onTriggerManualQuery: (query?: string) => void;
  onResetSession: () => void;
  onOpenSettings: () => void;
}

const StateIcon: React.FC<{ voiceState: VoiceState; className?: string; style?: React.CSSProperties }> = ({ voiceState, className, style }) => {
  if (voiceState === 'processing') return <Sparkles className={className} style={style} />;
  if (voiceState === 'speaking') return <Volume2 className={className} style={style} />;
  if (voiceState === 'inactivity_countdown') return <Clock className={className} style={style} />;
  return <Mic className={className} style={style} />;
};

export const ConsoleCore: React.FC<ConsoleCoreProps> = ({
  voiceState,
  telemetry,
  interimTranscript,
  systemMessage,
  hasSources,
  hasIndexedSources,
  isProcessingSources,
  onStartConversation,
  onStopConversation,
  onTriggerManualQuery,
  onResetSession,
  onOpenSettings
}) => {
  const prefersReducedMotion = useReducedMotion();

  const isListening = voiceState === 'listening';
  const isSpeaking = voiceState === 'speaking';
  const isProcessing = voiceState === 'processing';
  const isCountdown = voiceState === 'inactivity_countdown';
  const isEnded = voiceState === 'ended';
  const canConverse = hasIndexedSources;
  const isConversationActive = isListening || isSpeaking || isProcessing;
  const live = !prefersReducedMotion && isLiveState(voiceState);
  const color = VOICE_STATE_COLOR[voiceState];

  // Contextual guidance: tells the user exactly what to do at their current step.
  const guidance = !hasSources
    ? {
        step: 'Step 1 of 3',
        title: 'Add your sources',
        body: 'Upload a PDF, text file, or slide deck — or paste a link — using the panel on the left.',
        icon: <UploadCloud className="w-4 h-4" />
      }
    : isProcessingSources
    ? {
        step: 'Step 2 of 3',
        title: 'Processing your sources',
        body: "Hang tight — we're reading, splitting, and indexing everything you added.",
        icon: <Zap className="w-4 h-4" />
      }
    : !hasIndexedSources
    ? {
        step: 'Step 2 of 3',
        title: 'Process your sources',
        body: 'Select “Process sources” on the left to make them searchable.',
        icon: <Zap className="w-4 h-4" />
      }
    : {
        step: 'Step 3 of 3',
        title: 'Ready when you are',
        body: 'Start the conversation and ask a question out loud. Answers come only from your sources.',
        icon: <Mic className="w-4 h-4" />
      };

  return (
    <div className="glass rounded-3xl p-6 lg:p-8 flex flex-col h-full min-h-0 gap-6">

      {/* Mic indicator + waveform — the waveform box is the single source of
          state feedback (its own dot/label + distinct per-state animation),
          so this stays a plain, quiet icon rather than a second competing
          glow effect. */}
      <div className="relative flex-1 min-h-0 flex flex-col items-center justify-center gap-6">

        <motion.div
          animate={{
            scale: !prefersReducedMotion && isListening
              ? 1 + Math.min(telemetry.rmsVolume, 1) * 0.07
              : 1
          }}
          transition={{ type: 'spring', stiffness: 260, damping: 22 }}
          className="relative w-20 h-20 rounded-full flex items-center justify-center transition-smooth"
          style={{
            background: `radial-gradient(circle at 34% 28%, ${color}1f, rgba(17,20,26,0.9))`,
            border: `1.5px solid ${color}55`,
            boxShadow: live ? `0 0 22px -6px ${color}70` : 'none'
          }}
        >
          <StateIcon voiceState={voiceState} className="w-7 h-7" style={{ color }} />
          <span className="sr-only">{voiceState}</span>
        </motion.div>

        <div className="w-full max-w-lg">
          <WaveformVisualizer voiceState={voiceState} telemetry={telemetry} height={96} />
        </div>

        {/* Interim speech preview */}
        <AnimatePresence>
          {interimTranscript && (
            <motion.div
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.2 }}
              className="w-full max-w-lg glass-inset rounded-2xl px-4 py-3 flex items-center gap-3"
            >
              <Mic className="w-4 h-4 shrink-0" style={{ color }} />
              <span className="text-sm italic text-[var(--text-primary)] truncate">
                “{interimTranscript}”
              </span>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Status / guidance */}
        <div className="text-center max-w-md px-2">
          <AnimatePresence mode="wait">
            {isConversationActive || isCountdown ? (
              <motion.p
                key={systemMessage}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.2 }}
                className="text-base font-medium"
                style={{ color }}
              >
                {systemMessage}
              </motion.p>
            ) : (
              <motion.div
                key={guidance.title}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.22 }}
                className="flex flex-col items-center gap-2"
              >
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full glass-inset text-[11px] font-medium text-[var(--text-secondary)]">
                  <span className={canConverse ? 'text-[var(--accent-cyan)]' : 'text-[var(--text-muted)]'}>
                    {guidance.icon}
                  </span>
                  {guidance.step}
                </span>
                <h2 className="text-lg font-semibold text-[var(--text-primary)]">{guidance.title}</h2>
                <p className="text-sm text-[var(--text-secondary)] leading-relaxed">{guidance.body}</p>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* Primary action */}
      <div className="flex flex-col gap-3 shrink-0">
        {!isConversationActive ? (
          <button
            onClick={onStartConversation}
            disabled={!canConverse}
            title={!canConverse ? 'Upload and process your sources to begin' : undefined}
            className={`w-full h-16 rounded-2xl text-[15px] font-semibold flex items-center justify-center gap-3 transition-smooth ${
              canConverse
                ? 'bg-accent-gradient text-[#06131a] cta-glow cursor-pointer hover:-translate-y-0.5 active:translate-y-0 active:scale-[0.99]'
                : 'glass-inset text-[var(--text-muted)] cursor-not-allowed'
            }`}
          >
            <Mic className="w-5 h-5" />
            <span>Start conversation</span>
          </button>
        ) : (
          <button
            onClick={onStopConversation}
            className="w-full h-16 rounded-2xl bg-[#ff5c5c]/12 hover:bg-[#ff5c5c]/20 border border-[#ff5c5c]/35 text-[#ff5c5c] text-[15px] font-semibold flex items-center justify-center gap-3 transition-smooth cursor-pointer active:scale-[0.99]"
          >
            <Square className="w-4.5 h-4.5 fill-current" />
            <span>Stop</span>
          </button>
        )}

        {!canConverse && !isConversationActive && (
          <p className="text-xs text-center text-[var(--text-muted)]">
            Upload and process your sources to begin.
          </p>
        )}

        <AnimatePresence>
          {isCountdown && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="overflow-hidden"
            >
              <div className="rounded-2xl bg-[#ff5c5c]/10 border border-[#ff5c5c]/30 px-4 py-3 flex items-center justify-between gap-3">
                <span className="text-xs text-[#ff5c5c] flex items-center gap-2">
                  <Clock className="w-4 h-4 shrink-0" />
                  {systemMessage}
                </span>
                <button
                  onClick={onStartConversation}
                  className="px-3 py-1.5 rounded-lg bg-[#ff5c5c] text-[#0a0e1a] text-xs font-semibold hover:brightness-110 transition-smooth cursor-pointer shrink-0"
                >
                  Stay active
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {isEnded && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="overflow-hidden"
            >
              <div className="rounded-2xl glass-inset px-4 py-3 flex items-center justify-between gap-3">
                <span className="text-xs text-[var(--text-secondary)]">{systemMessage}</span>
                <button
                  onClick={onResetSession}
                  className="px-3 py-1.5 rounded-lg bg-accent-gradient text-[#06131a] text-xs font-semibold hover:brightness-110 transition-smooth cursor-pointer flex items-center gap-1.5 shrink-0"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>Start again</span>
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="flex items-center justify-between text-xs text-[var(--text-secondary)] pt-0.5">
          <button
            onClick={() => onTriggerManualQuery()}
            disabled={isProcessing || !canConverse}
            title={!canConverse ? 'Upload and process your sources to begin' : 'Try a sample question'}
            className="flex items-center gap-1.5 px-2 py-1.5 -ml-2 rounded-lg hover:text-[var(--accent-cyan)] hover:bg-[var(--surface-hover)] transition-smooth cursor-pointer disabled:opacity-35 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-[var(--text-secondary)]"
          >
            <Sparkles className="w-3.5 h-3.5 text-[#ffb020]" />
            <span>Try sample question</span>
          </button>

          <button
            onClick={onOpenSettings}
            className="flex items-center gap-1.5 px-2 py-1.5 -mr-2 rounded-lg hover:text-[var(--accent-cyan)] hover:bg-[var(--surface-hover)] transition-smooth cursor-pointer"
          >
            <SlidersHorizontal className="w-3.5 h-3.5" />
            <span>Audio settings</span>
          </button>
        </div>
      </div>
    </div>
  );
};
