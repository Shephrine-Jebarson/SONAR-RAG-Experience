import React, { useState, useEffect, useCallback } from 'react';
import { 
  RAGSource, 
  TranscriptTurn, 
  HealthCheckResult, 
  ConsoleSettings, 
  DiscreteProcessingStep, 
  Citation 
} from './types';
import { defaultApiService } from './services/apiService';
import { useVoiceEngine } from './hooks/useVoiceEngine';

import { HeaderConsole } from './components/HeaderConsole';
import { SourcePanel } from './components/SourcePanel';
import { ConsoleCore } from './components/ConsoleCore';
import { AnswerPanel } from './components/AnswerPanel';
import { HistoryDrawer } from './components/HistoryDrawer';
import { SettingsModal } from './components/SettingsModal';
import { SourceExcerptModal } from './components/SourceExcerptModal';

export default function App() {
  const [settings, setSettings] = useState<ConsoleSettings>(() => {
    const saved = localStorage.getItem('sonar_rag_settings');
    if (saved) {
      try { return JSON.parse(saved); } catch { /* corrupted localStorage value, fall back to defaults */ }
    }
    return {
      apiUrl: import.meta.env.VITE_API_URL || 'http://localhost:8000',
      topK: 4,
      temperature: 0.2,
      micSensitivity: 70,
      masterVolume: 85,
      squelchThreshold: 20,
      autoStandbySec: 15,
      selectedVoiceId: '',
      speechPitch: 1.0,
      speechRate: 1.0,
      useLocalFallback: true
    };
  });

  useEffect(() => {
    defaultApiService.setApiUrl(settings.apiUrl);
  }, [settings.apiUrl]);

  const [sources, setSources] = useState<RAGSource[]>([]);
  const [isProcessingSources, setIsProcessingSources] = useState<boolean>(false);

  const [processingSteps, setProcessingSteps] = useState<DiscreteProcessingStep[]>([
    { id: 'extract', label: 'Reading text', code: 'PARSER', status: 'pending' },
    { id: 'chunk', label: 'Splitting into sections', code: 'SEGMENT', status: 'pending' },
    { id: 'embed', label: 'Generating embeddings', code: 'TRANSFORM', status: 'pending' },
    { id: 'index', label: 'Indexing', code: 'FAISS', status: 'pending' }
  ]);

  const [transcript, setTranscript] = useState<TranscriptTurn[]>([]);
  const [activeCitation, setActiveCitation] = useState<Citation | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false);
  const [isHistoryOpen, setIsHistoryOpen] = useState<boolean>(false);

  const [health, setHealth] = useState<HealthCheckResult>({
    status: 'checking',
    url: settings.apiUrl,
    latencyMs: 0,
    timestamp: new Date()
  });

  const refreshHealth = useCallback(async () => {
    setHealth(prev => ({ ...prev, status: 'checking' }));
    const res = await defaultApiService.checkHealth();
    setHealth(res);
  }, []);

  useEffect(() => {
    // On every page load, wait for backend then wipe stale vectors
    const resetOnLoad = async () => {
      for (let i = 0; i < 10; i++) {
        setHealth(prev => ({ ...prev, status: 'checking' }));
        const res = await defaultApiService.checkHealth();
        setHealth(res);
        if (res.status === 'online' || res.status === 'degraded') {
          await defaultApiService.resetSources();
          return;
        }
        await new Promise(r => setTimeout(r, 1000));
      }
    };
    resetOnLoad();
  }, []);

  useEffect(() => {
    // Inlined rather than calling refreshHealth() directly so the effect's setState
    // calls happen after this function's own await, not synchronously at the top
    // of the effect body (mirrors the resetOnLoad pattern above).
    const poll = async () => {
      setHealth(prev => ({ ...prev, status: 'checking' }));
      const res = await defaultApiService.checkHealth();
      setHealth(res);
    };
    poll();
    const interval = setInterval(poll, 15000);
    return () => clearInterval(interval);
  }, []);

  const handleNewTurnAdded = useCallback((newTurn: TranscriptTurn) => {
    setTranscript(prev => [...prev, newTurn]);
  }, []);

  const voiceEngine = useVoiceEngine(sources, settings, handleNewTurnAdded);

  const handleUploadFile = async (file: File) => {
    const newSrc = await defaultApiService.uploadFile(file);
    setSources(prev => [...prev, newSrc]);
  };

  const handleAddUrl = async (urlStr: string) => {
    const newSrc = await defaultApiService.addUrl(urlStr);
    setSources(prev => [...prev, newSrc]);
  };

  const handleRemoveSource = (id: string) => {
    setSources(prev => prev.filter(s => s.id !== id));
  };

  const handleProcessSources = async () => {
    if (sources.length === 0 || isProcessingSources) return;

    setIsProcessingSources(true);
    const updatedSources = await defaultApiService.processSources(sources, (stepUpdates) => {
      setProcessingSteps(stepUpdates);
    });

    setSources(updatedSources);
    setIsProcessingSources(false);
    refreshHealth();
  };

  const handleReplayAudio = (text: string) => {
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = settings.speechRate;
      u.pitch = settings.speechPitch;
      u.volume = settings.masterVolume / 100;
      window.speechSynthesis.speak(u);
    }
  };

  const lastTurn = transcript.length > 0 ? transcript[transcript.length - 1] : null;
  const hasSources = sources.length > 0;
  const hasIndexedSources = sources.some(s => s.status === 'indexed');
  const hasConversation = transcript.length > 0;

  return (
    <div className="app-ambient h-screen overflow-hidden text-[var(--text-primary)] flex flex-col font-sans selection:bg-[var(--accent-cyan)]/25">

      {/* Header */}
      <HeaderConsole
        voiceState={voiceEngine.voiceState}
        health={health}
        sources={sources}
        onOpenSettings={() => setIsSettingsOpen(true)}
        onOpenHistory={() => setIsHistoryOpen(true)}
        historyCount={transcript.length}
        hasSources={hasSources}
        isProcessingSources={isProcessingSources}
        hasIndexedSources={hasIndexedSources}
        hasConversation={hasConversation}
      />

      {/* Main 3-Zone Layout */}
      <main className="relative flex-1 max-w-[1600px] w-full mx-auto px-5 md:px-8 py-6 md:py-7 grid grid-cols-1 lg:grid-cols-12 gap-5 lg:gap-6 min-h-0 overflow-hidden">

        {/* Zone 1: Sources */}
        <section className="lg:col-span-3 flex flex-col min-h-0">
          <SourcePanel
            sources={sources}
            onUploadFile={handleUploadFile}
            onAddUrl={handleAddUrl}
            onRemoveSource={handleRemoveSource}
            onProcessSources={handleProcessSources}
            isProcessing={isProcessingSources}
            processingSteps={processingSteps}
          />
        </section>

        {/* Zone 2: Voice console */}
        <section className="lg:col-span-5 flex flex-col min-h-0">
          <ConsoleCore
            voiceState={voiceEngine.voiceState}
            telemetry={voiceEngine.telemetry}
            interimTranscript={voiceEngine.interimTranscript}
            systemMessage={voiceEngine.systemMessage}
            hasSources={hasSources}
            hasIndexedSources={hasIndexedSources}
            isProcessingSources={isProcessingSources}
            onStartConversation={voiceEngine.startListening}
            onStopConversation={voiceEngine.stopConversation}
            onTriggerManualQuery={voiceEngine.triggerManualQuery}
            onResetSession={voiceEngine.resetSession}
            onOpenSettings={() => setIsSettingsOpen(true)}
          />
        </section>

        {/* Zone 3: Latest answer */}
        <section className="lg:col-span-4 flex flex-col min-h-0">
          <AnswerPanel
            lastTurn={lastTurn}
            voiceState={voiceEngine.voiceState}
            onSelectCitation={(cit) => setActiveCitation(cit)}
            onReplayAudio={handleReplayAudio}
            spokenCharIndex={voiceEngine.spokenCharIndex}
            speakingTurnId={voiceEngine.voiceState === 'speaking' && lastTurn ? lastTurn.id : null}
          />
        </section>

      </main>

      {/* Conversation history drawer */}
      <HistoryDrawer
        open={isHistoryOpen}
        onClose={() => setIsHistoryOpen(false)}
        transcript={transcript}
        onSelectCitation={(cit) => setActiveCitation(cit)}
        onClearTranscript={() => setTranscript([])}
        onReplayAudio={handleReplayAudio}
        spokenCharIndex={voiceEngine.spokenCharIndex}
        speakingTurnId={voiceEngine.voiceState === 'speaking' && lastTurn ? lastTurn.id : null}
      />

      {/* Settings Modal */}
      {isSettingsOpen && (
        <SettingsModal
          settings={settings}
          onSaveSettings={(newSet) => {
            setSettings(newSet);
            localStorage.setItem('sonar_rag_settings', JSON.stringify(newSet));
          }}
          onClose={() => setIsSettingsOpen(false)}
          health={health}
          onRefreshHealth={refreshHealth}
        />
      )}

      {/* Source Excerpt Drawer Modal */}
      {activeCitation && (
        <SourceExcerptModal
          citation={activeCitation}
          onClose={() => setActiveCitation(null)}
        />
      )}

    </div>
  );
}
