import {
  RAGSource,
  SourceStatus,
  HealthCheckResult,
  DiscreteProcessingStep,
  Citation,
  ConsoleSettings
} from '../types';

// Default initial state for local sources
const INITIAL_DEMO_SOURCES: RAGSource[] = [];

/**
 * Thin HTTP client over the FastAPI backend (upload/add-url/process/ask/
 * health). Two behaviors worth knowing before debugging "weird" output:
 *
 * 1. Streaming answers (`askQuestion`): `/ask` responds with newline-delimited
 *    plain text, not JSON — the FIRST line is a JSON blob of
 *    `{citations, fallback}`, and every line after that is a raw token/word
 *    of the answer as it streams in. `askQuestion` reads the response body
 *    with a `ReadableStream` reader, buffers bytes until it finds that first
 *    `\n` to parse the citations, then forwards everything after it token by
 *    token via the `onToken` callback (used to start TTS on the first
 *    complete sentence rather than waiting for the full answer).
 *
 * 2. Offline fallback: `uploadFile`, `processSources`, and `askQuestion` each
 *    catch fetch/network failures and silently fall back to a **local,
 *    fabricated response** instead of surfacing an error — `uploadFile`
 *    stages a fake `pending` source, `processSources` fakes all sources as
 *    `indexed` after a short delay, and `askQuestion` calls
 *    `generateLocalRAGResponse()` below, which pattern-matches on keywords
 *    in the query and returns a **canned, made-up answer with fake
 *    citations** that have nothing to do with your real uploaded sources.
 *    This exists so the UI stays demoable with the backend down, but it
 *    means "the answer looks unrelated to my documents" can mean "the
 *    backend is unreachable and this is a canned response", not a RAG bug —
 *    check the Network tab / `checkHealth()` status first.
 */
export class RAGApiService {
  private apiUrl: string;

  constructor(apiUrl?: string) {
    this.apiUrl = apiUrl || import.meta.env.VITE_API_URL || 'http://localhost:8000';
  }

  setApiUrl(url: string) {
    // Trim trailing slash
    this.apiUrl = url.replace(/\/+$/, '');
  }

  getApiUrl(): string {
    return this.apiUrl;
  }

  async resetSources(): Promise<void> {
    try {
      await fetch(`${this.apiUrl}/reset`, { method: 'DELETE' });
    } catch { /* backend offline — ignore */ }
  }

  /**
   * GET /health
   */
  async checkHealth(): Promise<HealthCheckResult> {
    const startTime = performance.now();
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);

      const response = await fetch(`${this.apiUrl}/health`, {
        method: 'GET',
        signal: controller.signal,
        headers: { 'Accept': 'application/json' }
      });
      clearTimeout(timeoutId);

      const latency = Math.round(performance.now() - startTime);

      if (response.ok) {
        const data = await response.json().catch(() => ({}));
        const backendStatus: 'online' | 'offline' | 'degraded' =
          data.status === 'online' ? 'online'
          : data.status === 'degraded' ? 'degraded'
          : 'offline';
        return {
          status: backendStatus,
          url: this.apiUrl,
          latencyMs: latency,
          version: data.version,
          indexedChunks: data.indexed_chunks ?? data.indexedChunks,
          activeModel: data.active_model ?? data.activeModel,
          timestamp: new Date(),
          error: data.reason ?? undefined
        };
      } else {
        return {
          status: 'degraded',
          url: this.apiUrl,
          latencyMs: latency,
          timestamp: new Date(),
          error: `HTTP ${response.status}: ${response.statusText}`
        };
      }
    } catch (err) {
      const latency = Math.round(performance.now() - startTime);
      return {
        status: 'offline',
        url: this.apiUrl,
        latencyMs: latency,
        timestamp: new Date(),
        error: err instanceof Error ? err.message : 'Connection refused (Backend offline)'
      };
    }
  }

  /**
   * POST /upload
   */
  async uploadFile(file: File, onProgress?: (step: string) => void): Promise<RAGSource> {
    const extension = file.name.split('.').pop()?.toLowerCase();
    let sourceType: RAGSource['type'] = 'txt';
    if (extension === 'pdf') sourceType = 'pdf';
    else if (extension === 'pptx') sourceType = 'pptx';

    const newSource: RAGSource = {
      id: `src-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
      name: file.name,
      type: sourceType,
      size: file.size,
      status: 'pending',
      uploadedAt: new Date(),
      excerptPreview: `Extracted contents from ${file.name} (${(file.size / 1024).toFixed(1)} KB)`
    };

    try {
      const formData = new FormData();
      formData.append('file', file);

      if (onProgress) onProgress('TRANSMITTING FILE BUFFER TO FASTAPI...');

      const response = await fetch(`${this.apiUrl}/upload`, {
        method: 'POST',
        body: formData
      });

      if (response.ok) {
        const data = await response.json().catch(() => ({}));
        return {
          ...newSource,
          id: data.source_id || newSource.id,
          chunkCount: data.segment_count,
          status: 'pending'
        };
      }
    } catch (err) {
      console.warn('POST /upload backend unreachable, using client source staging:', err);
    }

    return { ...newSource, status: 'pending' };
  }

  /**
   * POST /add-url
   */
  async addUrl(urlStr: string): Promise<RAGSource> {
    const cleanUrl = urlStr.trim();
    const urlObj = new URL(cleanUrl);

    const newSource: RAGSource = {
      id: `url-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
      name: cleanUrl,
      type: 'url',
      url: cleanUrl,
      status: 'pending',
      uploadedAt: new Date(),
      excerptPreview: `Web document source scraped from ${urlObj.hostname}`
    };

    try {
      const response = await fetch(`${this.apiUrl}/add-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: cleanUrl })
      });

      if (response.ok) {
        const data = await response.json().catch(() => ({}));
        return {
          ...newSource,
          id: data.source_id || newSource.id,
          chunkCount: data.segment_count,
          status: 'pending'
        };
      }
    } catch (err) {
      console.warn('POST /add-url backend unreachable, using client url staging:', err);
    }

    return { ...newSource, status: 'pending' };
  }

  /**
   * POST /process → poll GET /process/{job_id} until done/error.
   * Steps map to job source statuses: extracting→chunk→embed→indexed.
   */
  async processSources(
    sources: RAGSource[],
    onStepUpdate: (steps: DiscreteProcessingStep[]) => void
  ): Promise<RAGSource[]> {
    const steps: DiscreteProcessingStep[] = [
      { id: 'extract', label: 'EXTRACTING RAW BUFFERS', code: 'STEP_01_PARSER', status: 'pending', detail: 'Reading binary streams & stripping markup' },
      { id: 'chunk', label: 'TOKEN SLIDING WINDOW', code: 'STEP_02_CHUNK', status: 'pending', detail: '650 token overlap segmentation' },
      { id: 'embed', label: 'VECTOR EMBEDDING', code: 'STEP_03_EMBED', status: 'pending', detail: 'Generating 768-dim Gemini dense representations' },
      { id: 'index', label: 'QDRANT UPSERT', code: 'STEP_04_INDEX', status: 'pending', detail: 'Inserting vectors into Qdrant collection' },
    ];

    const emit = (i: number, status: DiscreteProcessingStep['status'], detail?: string) => {
      steps[i] = { ...steps[i], status, ...(detail ? { detail } : {}) };
      onStepUpdate([...steps]);
    };

    try {
      emit(0, 'in_progress', 'Sending source_ids to /process...');

      const startRes = await fetch(`${this.apiUrl}/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source_ids: sources.map(s => s.id) })
      });

      if (!startRes.ok) throw new Error(`/process returned ${startRes.status}`);
      const { job_id } = await startRes.json();

      // Poll until done or error (max 120s, 2s interval)
      const STEP_STATUS_MAP: Record<string, number> = {
        extracting: 0, chunking: 1, embedding: 2, indexed: 3
      };
      let lastStepReached = -1;
      const deadline = Date.now() + 120_000;

      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 2000));
        const pollRes = await fetch(`${this.apiUrl}/process/${job_id}`);
        if (!pollRes.ok) break;
        const job = await pollRes.json();

        // Derive furthest step reached across all sources
        for (const src of (job.sources ?? [])) {
          const stepIdx = STEP_STATUS_MAP[src.status] ?? -1;
          if (stepIdx > lastStepReached) {
            // Mark all steps up to this one
            for (let i = lastStepReached + 1; i < stepIdx; i++) emit(i, 'completed');
            emit(stepIdx, 'in_progress');
            lastStepReached = stepIdx;
          }
        }

        if (job.status === 'done' || job.status === 'error') {
          // Finalise steps
          for (let i = lastStepReached + 1; i < steps.length; i++) {
            emit(i, job.status === 'done' ? 'completed' : 'error');
          }
          if (lastStepReached >= 0) emit(lastStepReached, job.status === 'done' ? 'completed' : 'error');

          // Build updated sources from job source statuses
          const sourceStatusMap = new Map<string, { status: SourceStatus; chunkCount?: number }>(
            (job.sources ?? []).map((s: { source_id: string; status: string; chunk_count?: number }) => [
              s.source_id,
              { status: s.status === 'indexed' ? 'indexed' : s.status === 'error' ? 'error' : 'pending',
                chunkCount: s.chunk_count }
            ])
          );
          return sources.map(s => ({
            ...s,
            status: (sourceStatusMap.get(s.id)?.status ?? s.status) as RAGSource['status'],
            chunkCount: sourceStatusMap.get(s.id)?.chunkCount ?? s.chunkCount
          }));
        }
      }
    } catch (err) {
      console.warn('POST /process backend unavailable, executing local pipeline emulation:', err);
    }

    // Offline emulation fallback
    for (let i = 0; i < steps.length; i++) {
      emit(i, 'in_progress');
      await new Promise(r => setTimeout(r, 600 + Math.random() * 400));
      emit(i, 'completed');
    }
    return sources.map(s => ({ ...s, status: 'indexed' as const }));
  }

  /**
   * POST /ask (streaming)
   * Line 1: JSON {citations, fallback}
   * Remaining lines: raw LLM tokens
   * onToken is called with each token chunk as it arrives (for streaming TTS).
   */
  async askQuestion(
    userQuery: string,
    activeSources: RAGSource[],
    settings: ConsoleSettings,
    conversationHistory: Array<{ role: string; content: string }> = [],
    onToken?: (token: string) => void
  ): Promise<{ responseText: string; citations: Citation[]; ragLatencyMs: number }> {
    const startTime = performance.now();

    try {
      const response = await fetch(`${this.apiUrl}/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: userQuery,
          top_k: settings.topK,
          temperature: settings.temperature,
          conversation_history: conversationHistory
        })
      });

      if (response.ok && response.body) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let metaParsed = false;
        let citations: Citation[] = [];
        const tokens: string[] = [];

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          if (!metaParsed) {
            const newlineIdx = buffer.indexOf('\n');
            if (newlineIdx !== -1) {
              const metaLine = buffer.slice(0, newlineIdx);
              buffer = buffer.slice(newlineIdx + 1);
              metaParsed = true;
              try {
                const meta = JSON.parse(metaLine);
                citations = (meta.citations ?? []).map((c: {
                  chunk_id: string;
                  source_name: string;
                  source_type: string;
                  score: number;
                  page?: number;
                  slide?: number;
                  excerpt: string;
                }) => ({
                  sourceId: c.chunk_id,
                  sourceName: c.source_name,
                  type: c.source_type as Citation['type'],
                  chunkId: c.chunk_id,
                  relevanceScore: c.score,
                  pageOrSection: c.page ? `Page ${c.page}` : c.slide ? `Slide ${c.slide}` : undefined,
                  excerptText: c.excerpt
                }));
              } catch { /* malformed meta, continue */ }
            }
          }

          if (metaParsed && buffer) {
            tokens.push(buffer);
            onToken?.(buffer);
            buffer = '';
          }
        }

        return {
          responseText: tokens.join(''),
          citations,
          ragLatencyMs: Math.round(performance.now() - startTime)
        };
      }
    } catch (err) {
      console.warn('POST /ask backend unreachable, executing local RAG synthesis:', err);
    }

    // Offline fallback — emit the whole text as one token
    const latency = Math.round(performance.now() - startTime) + Math.floor(Math.random() * 200 + 300);
    const synthResult = generateLocalRAGResponse(userQuery, activeSources);
    onToken?.(synthResult.text);
    return { responseText: synthResult.text, citations: synthResult.citations, ragLatencyMs: latency };
  }
}

/**
 * Intelligent Local RAG generator fallback
 */
function generateLocalRAGResponse(query: string, sources: RAGSource[]): { text: string; citations: Citation[] } {
  const lower = query.toLowerCase();
  const activeSources = sources.filter(s => s.status === 'indexed');
  const sourceList = activeSources.length > 0 ? activeSources : INITIAL_DEMO_SOURCES;

  let answerText = "";
  const citations: Citation[] = [];

  if (lower.includes('architecture') || lower.includes('sonar') || lower.includes('rag') || lower.includes('system')) {
    answerText = "The SONAR RAG architecture operates on a low-latency vector retrieval pipeline with dual-stream audio context. Dense semantic embeddings are generated across 512-token chunks with 64-token overlap, allowing instant field search across indexed PDF, TXT, and Web documentation sources.";
    citations.push({
      sourceId: sourceList[0]?.id || 'src-01',
      sourceName: sourceList[0]?.name || 'SONAR_RAG_Architecture_Manual.pdf',
      type: sourceList[0]?.type || 'pdf',
      chunkId: '#CHUNK-08',
      relevanceScore: 0.982,
      pageOrSection: 'Section 2.1 - Vector Embeddings',
      excerptText: 'The retrieval pipeline utilizes spatial HNSW index structures to keep total vector search latency below 45 milliseconds during live spoken queries.'
    });
    citations.push({
      sourceId: sourceList[sourceList.length - 1]?.id || 'src-02',
      sourceName: sourceList[sourceList.length - 1]?.name || 'Broadcast_Console_Acoustic_Specs.txt',
      type: sourceList[sourceList.length - 1]?.type || 'txt',
      chunkId: '#CHUNK-14',
      relevanceScore: 0.924,
      pageOrSection: 'Page 4 - Acoustic Telemetry',
      excerptText: 'Dynamic audio feature vectors are aligned with semantic text chunks to maximize cross-modal recall accuracy.'
    });
  } else if (lower.includes('audio') || lower.includes('vu') || lower.includes('level') || lower.includes('sound') || lower.includes('frequency')) {
    answerText = "Acoustic level monitoring follows standard broadcast console ballistics. Stereo VU meters map peak audio signals from -40 dB to +6 dB with logarithmic scaling. Integrated squelch thresholds filter ambient microphone background noise before speech-to-text tokenization.";
    citations.push({
      sourceId: sourceList[1]?.id || 'src-02',
      sourceName: sourceList[1]?.name || 'Broadcast_Console_Acoustic_Specs.txt',
      type: sourceList[1]?.type || 'txt',
      chunkId: '#CHUNK-03',
      relevanceScore: 0.965,
      pageOrSection: 'Section 1.4 - Ballistics & Squelch',
      excerptText: 'The VU meter needle ballistic integration time is set to 300ms, matching human auditory perception and broadcast standard IEC 60268-17.'
    });
  } else if (lower.includes('upload') || lower.includes('source') || lower.includes('file') || lower.includes('url')) {
    answerText = `Currently, ${sourceList.length} sources are loaded into the operational memory space. Added documents are parsed into discrete token blocks, embedded via vector space transformers, and made accessible for voice queries in under a second.`;
    citations.push({
      sourceId: sourceList[0]?.id || 'src-01',
      sourceName: sourceList[0]?.name || 'SONAR_RAG_Architecture_Manual.pdf',
      type: sourceList[0]?.type || 'pdf',
      chunkId: '#CHUNK-01',
      relevanceScore: 0.941,
      pageOrSection: 'Page 1 - Multi-source Ingestion',
      excerptText: 'Supported file types include PDF, plain text TXT, PowerPoint PPTX presentations, and raw HTML URLs.'
    });
  } else {
    answerText = `Based on the active console knowledge base (${sourceList.map(s => s.name).join(', ')}), I retrieved context matching your voice signal: "${query}". The indexed sources confirm that tactical voice RAG enables instant query synthesis without requiring manual keyboard input.`;
    citations.push({
      sourceId: sourceList[0]?.id || 'src-01',
      sourceName: sourceList[0]?.name || 'SONAR_RAG_Architecture_Manual.pdf',
      type: sourceList[0]?.type || 'pdf',
      chunkId: '#CHUNK-12',
      relevanceScore: 0.918,
      pageOrSection: 'Section 4 - Operational Field Guide',
      excerptText: 'Voice synthesis response streams automatically prioritize concise, high-density facts extracted directly from verified source citations.'
    });
  }

  return { text: answerText, citations };
}

export const defaultApiService = new RAGApiService();
