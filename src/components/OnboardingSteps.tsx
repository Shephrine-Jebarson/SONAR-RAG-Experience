import React from 'react';
import { motion } from 'framer-motion';
import { Check } from 'lucide-react';

interface OnboardingStepsProps {
  hasSources: boolean;
  isProcessing: boolean;
  hasIndexedSources: boolean;
  hasConversation: boolean;
}

export const OnboardingSteps: React.FC<OnboardingStepsProps> = ({
  hasSources,
  isProcessing,
  hasIndexedSources,
  hasConversation
}) => {
  const steps = [
    { key: 'upload', label: 'Upload', done: hasSources, current: !hasSources },
    { key: 'process', label: 'Process', done: hasIndexedSources, current: hasSources && !hasIndexedSources },
    { key: 'ask', label: 'Ask', done: hasConversation, current: hasIndexedSources && !hasConversation }
  ];

  return (
    <div className="flex items-center gap-2.5" aria-label="Setup progress">
      {steps.map((step, idx) => {
        const active = step.done || step.current;
        return (
          <React.Fragment key={step.key}>
            <div className="flex items-center gap-2">
              <motion.div
                initial={false}
                animate={{
                  backgroundColor: active ? 'rgba(34,211,238,0.14)' : 'rgba(255,255,255,0.03)',
                  borderColor: active ? 'rgba(34,211,238,0.55)' : 'rgba(255,255,255,0.09)',
                  scale: step.current ? 1.06 : 1
                }}
                transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
                className="w-7 h-7 rounded-full border flex items-center justify-center shrink-0 text-[11px] font-bold"
              >
                {step.done && !step.current ? (
                  <Check className="w-3.5 h-3.5 text-[var(--accent-cyan)]" strokeWidth={3} />
                ) : (
                  <span className={step.current ? 'text-[var(--accent-cyan)]' : 'text-[var(--text-muted)]'}>
                    {idx + 1}
                  </span>
                )}
              </motion.div>
              <span
                className={`text-[13px] font-medium hidden sm:inline transition-smooth ${
                  step.current ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'
                }`}
              >
                {step.label}
                {step.key === 'process' && isProcessing && !hasIndexedSources && (
                  <span className="text-[var(--accent-violet)] ml-1 animate-dot">…</span>
                )}
              </span>
            </div>
            {idx < steps.length - 1 && (
              <span className="w-6 h-px bg-[var(--border-strong)] hidden sm:block" aria-hidden="true" />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
};
