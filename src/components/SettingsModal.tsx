import React, { useState, useEffect } from 'react';
import { ConsoleSettings, HealthCheckResult } from '../types';
import { RAGApiService } from '../services/apiService';
import {
  SlidersHorizontal,
  X,
  Activity,
  RefreshCw,
  Volume2,
  Database,
  Save,
  Server
} from 'lucide-react';

interface SettingsModalProps {
  settings: ConsoleSettings;
  onSaveSettings: (newSettings: ConsoleSettings) => void;
  onClose: () => void;
  health: HealthCheckResult;
  onRefreshHealth: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  settings,
  onSaveSettings,
  onClose,
  health,
  onRefreshHealth
}) => {
  const [formState, setFormState] = useState<ConsoleSettings>({ ...settings });
  const [availableVoices, setAvailableVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [testingEndpoint, setTestingEndpoint] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  useEffect(() => {
    if ('speechSynthesis' in window) {
      const updateVoices = () => {
        setAvailableVoices(window.speechSynthesis.getVoices());
      };
      updateVoices();
      window.speechSynthesis.onvoiceschanged = updateVoices;
    }
  }, []);

  const handleTestEndpoint = async () => {
    setTestingEndpoint(true);
    setTestResult(null);

    const testService = new RAGApiService(formState.apiUrl);
    const res = await testService.checkHealth();
    setTestingEndpoint(false);

    if (res.status === 'online') {
      setTestResult(`ONLINE - Latency ${res.latencyMs}ms (${res.version})`);
    } else {
      setTestResult(`OFFLINE - ${res.error || 'Connection refused'}`);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSaveSettings(formState);
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-fade-in">
      <div className="glass border border-[var(--border)] rounded-xl max-w-2xl w-full p-5 sm:p-6 shadow-2xl relative max-h-[90vh] overflow-y-auto">

        {/* Modal Header */}
        <div className="flex items-center justify-between border-b border-[var(--border)] pb-3 mb-4">
          <div className="flex items-center gap-2">
            <SlidersHorizontal className="w-5 h-5 text-[var(--accent-cyan)]" />
            <h2 className="font-sans text-sm font-semibold text-[var(--text-primary)]">
              Settings
            </h2>
          </div>

          <button
            onClick={onClose}
            className="flex items-center justify-center w-11 h-11 text-[var(--text-secondary)] hover:text-white rounded hover:bg-[var(--surface-hover)] cursor-pointer"
            aria-label="Close settings"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">

          {/* Section 1: Backend Endpoint */}
          <div className="bg-[rgba(0,0,0,0.22)] border border-[var(--border)] rounded-lg p-3.5 space-y-3">
            <div className="flex items-center justify-between">
              <label className="text-xs font-sans font-medium text-[var(--text-primary)] flex items-center gap-1.5">
                <Server className="w-4 h-4 text-[var(--accent-cyan)]" />
                <span>Backend URL</span>
              </label>

              <div className="flex items-center gap-2 text-[10px] font-console">
                <span className={health.status === 'online' ? 'text-[var(--accent-cyan)]' : 'text-[#ff5c5c]'}>
                  {health.status === 'online' ? 'Connected' : health.status === 'degraded' ? 'Degraded' : 'Offline'}
                </span>
                <button
                  type="button"
                  onClick={onRefreshHealth}
                  className="p-1 text-[var(--accent-cyan)] hover:bg-[var(--accent-cyan)]/10 rounded cursor-pointer"
                  title="Check connection"
                >
                  <RefreshCw className="w-3 h-3" />
                </button>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <input
                type="text"
                value={formState.apiUrl}
                onChange={(e) => setFormState({ ...formState, apiUrl: e.target.value })}
                placeholder="http://localhost:8000"
                className="flex-1 bg-[rgba(0,0,0,0.3)] border border-[var(--border)] focus:border-[var(--accent-cyan)] rounded px-3 py-2 text-xs font-console text-[var(--accent-cyan)] focus:outline-none"
              />
              <button
                type="button"
                onClick={handleTestEndpoint}
                disabled={testingEndpoint}
                className="px-3 py-2 bg-[var(--surface-hover)] hover:bg-[var(--border)] text-[var(--accent-cyan)] border border-[var(--border)] rounded text-xs font-sans font-medium cursor-pointer shrink-0"
              >
                {testingEndpoint ? 'Testing…' : 'Test connection'}
              </button>
            </div>

            {testResult && (
              <div className={`p-2 rounded text-xs font-console border ${
                testResult.startsWith('ONLINE') ? 'bg-[var(--accent-cyan)]/10 border-[var(--accent-cyan)]/30 text-[var(--accent-cyan)]' : 'bg-[#ff5c5c]/10 border-[#ff5c5c]/30 text-[#ff5c5c]'
              }`}>
                {testResult}
              </div>
            )}
          </div>

          {/* Section 2: Audio Speech Parameters */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">

            <div className="bg-[rgba(0,0,0,0.22)] border border-[var(--border)] rounded-lg p-3.5 space-y-2">
              <label className="text-xs font-sans font-medium text-[var(--text-primary)] flex items-center gap-1.5">
                <Volume2 className="w-4 h-4 text-[#ffb020]" />
                <span>Voice</span>
              </label>

              <select
                value={formState.selectedVoiceId}
                onChange={(e) => setFormState({ ...formState, selectedVoiceId: e.target.value })}
                className="w-full bg-[rgba(0,0,0,0.3)] border border-[var(--border)] text-xs font-console text-[var(--text-primary)] rounded p-2 focus:border-[#ffb020] focus:outline-none"
              >
                <option value="">System default</option>
                {availableVoices.map((v, i) => (
                  <option key={i} value={v.name}>
                    {v.name} ({v.lang})
                  </option>
                ))}
              </select>
            </div>

            <div className="bg-[rgba(0,0,0,0.22)] border border-[var(--border)] rounded-lg p-3.5 space-y-2">
              <label className="text-xs font-sans font-medium text-[var(--text-primary)] flex items-center gap-1.5">
                <Activity className="w-4 h-4 text-[var(--accent-cyan)]" />
                <span>End session after</span>
              </label>

              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min="5"
                  max="60"
                  step="5"
                  value={formState.autoStandbySec}
                  onChange={(e) => setFormState({ ...formState, autoStandbySec: Number(e.target.value) })}
                  className="flex-1 accent-[var(--accent-cyan)] cursor-pointer"
                />
                <span className="text-xs font-console text-[var(--accent-cyan)] font-bold w-12 text-right">
                  {formState.autoStandbySec}s
                </span>
              </div>
            </div>

          </div>

          {/* Section 3: Retrieval Parameters */}
          <div className="bg-[rgba(0,0,0,0.22)] border border-[var(--border)] rounded-lg p-3.5 space-y-3">
            <label className="text-xs font-sans font-medium text-[var(--text-primary)] flex items-center gap-1.5">
              <Database className="w-4 h-4 text-[var(--accent-cyan)]" />
              <span>Answer quality</span>
            </label>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">

              <div>
                <div className="flex justify-between text-xs font-sans text-[var(--text-secondary)] mb-1">
                  <span>Sources per answer</span>
                  <span className="text-[var(--accent-cyan)] font-medium">{formState.topK}</span>
                </div>
                <input
                  type="range"
                  min="1"
                  max="10"
                  value={formState.topK}
                  onChange={(e) => setFormState({ ...formState, topK: Number(e.target.value) })}
                  className="w-full accent-[var(--accent-cyan)] cursor-pointer"
                />
              </div>

              <div>
                <div className="flex justify-between text-xs font-sans text-[var(--text-secondary)] mb-1">
                  <span>Creativity</span>
                  <span className="text-[#ffb020] font-medium">{formState.temperature}</span>
                </div>
                <input
                  type="range"
                  min="0.0"
                  max="1.0"
                  step="0.1"
                  value={formState.temperature}
                  onChange={(e) => setFormState({ ...formState, temperature: Number(e.target.value) })}
                  className="w-full accent-[#ffb020] cursor-pointer"
                />
              </div>

            </div>
          </div>

          {/* Submit / Save */}
          <div className="flex items-center justify-end gap-3 pt-3 border-t border-[var(--border)]">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded bg-[var(--surface-hover)] hover:bg-[var(--border)] text-[var(--text-secondary)] font-sans text-xs font-medium cursor-pointer"
            >
              Cancel
            </button>

            <button
              type="submit"
              className="px-5 py-2 rounded bg-brand-gradient text-[#0a0e1a] font-sans text-xs font-semibold flex items-center gap-1.5 cursor-pointer glow-teal hover:opacity-90"
            >
              <Save className="w-4 h-4" />
              <span>Save settings</span>
            </button>
          </div>

        </form>

      </div>
    </div>
  );
};
