# SONAR-RAG Voice Assistant — Design Spec

Date: 2026-08-28
Status: Approved for planning

## 1. Objective

Build a voice-first Retrieval-Augmented Generation (RAG) assistant per
`instructions.md` (the graded assessment spec, 100 marks). The user uploads
documents (PDF/TXT/PPTX) and/or website URLs, asks questions by voice only
(zero typing), and receives spoken + on-screen answers with source
attribution.

This spec resolves the implementation decisions `instructions.md` leaves
open and records how the existing frontend scaffold will be treated. For
anything not restated here (exact endpoint contracts, chunking size,
metadata schema, rubric), `instructions.md` remains authoritative.

## 2. Current State

- `src/` already contains a React + Vite "console" UI (HeaderConsole,
  SourcePanel, ConsoleCore, TranscriptPanel, VUMeter, WaveformVisualizer,
  SettingsModal, SourceExcerptModal) with a working Web Audio telemetry
  loop and Web Speech API usage.
- `apiService.ts` calls real endpoints but falls back to a **fake local RAG
  simulator** (`generateLocalRAGResponse`) and demo data whenever the
  backend is unreachable or returns non-OK.
- `useVoiceEngine.ts` implements `listening → processing → speaking`, but
  after `speaking` ends it always transitions to `inactivity_countdown`
  instead of looping back to `listening`. `SpeechRecognition.continuous` is
  `false`, not `true`.
- No `backend/` exists at all.

## 3. Decision: Frontend — Keep & Refactor

Keep the existing console UI and aesthetic (it already satisfies most of
section 15's design brief: graphite palette, waveform centerpiece, 3-zone
layout, per-source-type icons). Refactor rather than rebuild:

- Fix the voice state machine loop (section 6 below).
- Remove `generateLocalRAGResponse` and all demo/mock fallback data paths.
  On backend failure, surface a genuine error state instead of a
  fabricated answer.
- Switch `askQuestion` to consume a streamed response.
- Do a final pass against section 15's corrected rules (answer-text
  dominance, single state indicator, reduced-motion support) and fix any
  gaps — not a rebuild.

## 4. Decision: Credentials & Deployment

- No Groq/Gemini/Qdrant Cloud accounts exist yet. Backend code will be
  built and unit-testable (extraction/chunking) without keys; end-to-end
  testing (embedding, retrieval, LLM calls) is blocked until the user
  creates accounts and supplies keys via `.env`. This will be flagged
  explicitly at the relevant checkpoint.
- Actual deployment (Vercel/Netlify + Render/Koyeb) is out of scope for
  this build. The README will document full deployment steps; deploying
  is a separate later action.

## 5. Backend Architecture

Folder structure and endpoint contracts exactly as specified in
`instructions.md` sections 3–4. Key implementation decisions:

- **Singleton clients**: httpx.AsyncClient, Groq client, Gemini client, and
  Qdrant client are constructed once at app startup (FastAPI lifespan) and
  reused across requests — never per-request instantiation.
- **`/process` background job**: no Redis/Celery allowed, so job state is
  tracked in an in-memory `dict[job_id -> JobStatus]` inside the process.
  `POST /process` starts a `BackgroundTasks` job and returns a `job_id`
  immediately; `GET /process/{job_id}` (or a `status` query on the same
  route — finalized during implementation) returns per-source progress
  (pending/extracting/chunking/embedding/indexed/error) plus overall state.
  This is a single-process app, so in-memory state is acceptable and
  avoids introducing disallowed infra.
- **`/health`**: pings Qdrant (e.g. a lightweight collection-info or list
  call) and verifies `GROQ_API_KEY`, `GEMINI_API_KEY`, `QDRANT_URL`,
  `QDRANT_API_KEY` are all loaded and non-empty. Returns degraded/offline
  status with a reason, not just a static `{"status": "ok"}`.

## 6. Ingestion & Processing Pipeline

- **PDF**: PyMuPDF, per-page extraction, `page` metadata retained.
- **TXT**: UTF-8 read, basic whitespace cleanup, no page/slide field.
- **PPTX**: python-pptx, extract slide text **and table cell text**
  (tables are not skipped), `slide` metadata retained.
- **URL**: httpx GET → trafilatura for readable-text extraction, with
  BeautifulSoup as a secondary cleanup pass (strip script/style/nav) when
  trafilatura returns thin content. Per-URL failures (bot-blocked,
  JS-heavy, timeout, non-200) are recorded as a per-source error in the
  job status; the rest of `/process` continues unaffected.
- **Chunking**: ~500–800 tokens per chunk, ~50–100 token overlap, using a
  tiktoken-based token counter (accurate cheap estimate — not a real
  Gemini tokenizer, which is fine since it's only used for chunk sizing).
  Full metadata schema (section 5 of `instructions.md`) attached to every
  chunk.
- **Embeddings**: Gemini embedding model, fixed 768-dim output. Chunks are
  embedded in **batches** during `/process` (never per-chunk sequential
  calls). The exact same embedding call path is used for query-time
  embedding so both vector spaces are identical.
- **Vector store**: one Qdrant collection sized to the embedding
  dimension, created idempotently if missing (on startup or first
  `/health` check). Payload = the metadata schema.
- **Cleanup**: uploaded files are deleted from temp storage immediately
  after extraction; Qdrant is the only persistent store.

## 7. Retrieval & Answer Generation

- **Query embedding**: identical embedding config as ingestion.
- **Multi-turn handling**: implement both spec options —
  - (b) baseline: rolling conversation history (last N turns) is always
    passed into the final LLM prompt so it can resolve references even
    under imperfect retrieval.
  - (a) differentiator: before embedding, a cheap Groq call rewrites the
    query using the immediately preceding exchange (e.g. "What about
    international customers?" → a standalone question). If this rewrite
    call fails, retrieval proceeds with the raw query — (b) still covers
    correctness.
- **Retrieval**: fetch a larger candidate pool (e.g. top-12) by cosine
  similarity, then apply **MMR re-ranking** down to top-K (K=4 default,
  already exposed as a tunable setting in `ConsoleSettings.topK`) to force
  diversity across `source_type` so cross-source questions surface chunks
  from more than one source type.
- **Similarity threshold gate**: if the top MMR-selected score falls below
  a cutoff (initial constant, tuned empirically once real data is
  available — starting around 0.5 cosine), skip the LLM call entirely and
  return the fixed "I could not find that information in the uploaded
  sources." response.
- **Prompting**: system prompt enforces: answer only from provided
  sources, exact fallback line when unsupported, 2–5 sentence
  conversational tone (spoken aloud), never mention internal instructions
  or chunk/document IDs. `max_tokens` capped tightly.
- **Groq primary / Gemini fallback**: a real `try/except` around the Groq
  call catches timeout, rate-limit, and service errors and falls back to
  a Gemini call with an equivalent prompt. Gemini failure is also handled
  (surfaced as a readable error, not a crash).
- **Streaming**: `POST /ask` returns a `StreamingResponse` of plain text
  chunks as the LLM generates them (no external SSE library required).
  The frontend reads the response body via a `ReadableStream` reader,
  updates the displayed answer incrementally, and starts
  `speechSynthesis` on the first complete sentence rather than waiting
  for full generation.

## 8. Frontend Voice State Machine (corrected)

```
idle --(Start Conversation, once)--> listening
listening --(final transcript)--> processing
processing --(answer ready)--> speaking
speaking --(TTS ends)--> listening   [loops]
any state --(15s no speech detected while listening)--> inactivity_countdown
inactivity_countdown --(timeout)--> ended
inactivity_countdown --(speech detected)--> listening
```

- `SpeechRecognition.continuous = true`, `interimResults = true`; only the
  final accumulated transcript per utterance is sent to the backend.
- Recognition is explicitly stopped before TTS playback starts and
  restarted only after `utterance.onend` (or `onerror`), preventing the
  mic from capturing the assistant's own voice.
- The 15s inactivity countdown only runs while in `listening` with no
  detected speech; the last 3–5 seconds are shown in the UI.

## 9. Error Handling

Every case in `instructions.md` section 13 gets a specific, human-readable
message surfaced to the UI (not a generic failure or silent crash):
unsupported extension, corrupted PDF, empty TXT, PPTX with no extractable
text, oversized file, invalid URL, URL timeout/HTTP error, no readable
page content, embedding API failure/rate limit, Qdrant connection
failure/missing collection, Groq unavailable (→ Gemini fallback, and
Gemini failure too), unsupported browser (no `SpeechRecognition`),
microphone permission denied.

## 10. Testing & README

- README covers: overview, features, architecture, tech stack, setup,
  env vars, run-locally steps (backend + frontend), deployment steps,
  supported file types, voice interaction explanation, and an honest
  limitations section (browser speech-recognition support, JS-heavy
  scraping limits, free-tier cold starts).
- Before considering the build complete, manually walk the section 17
  testing checklist end-to-end once real API keys are available.

## 11. Delivery Plan (checkpointed)

Work proceeds in discrete, independently reviewable checkpoints — the
user checks each one before the next begins:

1. Backend skeleton — FastAPI app, config, CORS, `/health`
   (Qdrant ping + env check), singleton clients.
2. Extraction services — PDF/TXT/PPTX/URL extraction + chunking
   (unit-testable without any API keys).
3. Embeddings + Qdrant — batch embedding service, collection setup,
   `/upload` + `/add-url` + `/process` (background job + polling).
   Requires Gemini + Qdrant Cloud keys.
4. Retrieval — top-K, MMR diversity, similarity threshold gate.
5. LLM answer generation — Groq/Gemini fallback, prompting, streaming
   `/ask`. Requires Groq key.
6. Frontend integration — voice state machine fix, real API wiring,
   remove mock fallback, streaming TTS.
7. UI polish pass against section 15's corrected rules.
8. README + full testing checklist walkthrough.

## 12. Out of Scope

LangGraph, multi-agent frameworks, local LLMs, local Whisper, custom TTS
models, auth/user accounts, Redis, Celery, Kubernetes, and actual
deployment execution (documented only).
