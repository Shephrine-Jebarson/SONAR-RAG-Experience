export type VoiceState = 
  | 'idle' 
  | 'listening' 
  | 'processing' 
  | 'speaking' 
  | 'inactivity_countdown' 
  | 'ended';

export type SourceType = 'pdf' | 'txt' | 'pptx' | 'url';

export type SourceStatus = 'pending' | 'extracting' | 'chunking' | 'embedding' | 'indexed' | 'error';

export interface RAGSource {
  id: string;
  name: string;
  type: SourceType;
  url?: string;
  size?: number; // in bytes
  chunkCount?: number;
  status: SourceStatus;
  uploadedAt: Date;
  excerptPreview?: string;
}

export interface Citation {
  sourceId: string;
  sourceName: string;
  type: SourceType;
  chunkId: string;
  relevanceScore: number; // 0.0 to 1.0 (e.g., 0.94)
  pageOrSection?: string;
  excerptText: string;
}

export interface TranscriptTurn {
  id: string;
  timestamp: Date;
  userSpeechText: string;
  aiResponseText: string;
  citations: Citation[];
  audioDurationSeconds?: number;
  tokensUsed?: number;
  ragLatencyMs?: number;
}

export interface DiscreteProcessingStep {
  id: 'extract' | 'chunk' | 'embed' | 'index';
  label: string;
  code: string;
  status: 'pending' | 'in_progress' | 'completed' | 'error';
  detail?: string;
}

export interface HealthCheckResult {
  status: 'online' | 'offline' | 'degraded' | 'checking';
  url: string;
  latencyMs: number;
  version?: string;
  indexedChunks?: number;
  activeModel?: string;
  timestamp: Date;
  error?: string;
}

export interface ConsoleSettings {
  apiUrl: string;
  topK: number;
  temperature: number;
  micSensitivity: number; // 0 to 100
  masterVolume: number;   // 0 to 100
  squelchThreshold: number; // 0 to 100
  autoStandbySec: number; // default 15
  selectedVoiceId: string;
  speechPitch: number;
  speechRate: number;
  useLocalFallback: boolean;
}
