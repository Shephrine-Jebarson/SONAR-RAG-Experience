# SONAR-RAG Delivery Roadmap

> **For the next person/session:** read this file first. It tracks which
> checkpoint we're on. Each checkpoint has its own fully-detailed plan file
> (written just before that checkpoint starts, not all up front) under
> `docs/superpowers/plans/`. Execute one checkpoint at a time via
> `superpowers:subagent-driven-development` or `superpowers:executing-plans`,
> stop, let Shephrine review, then come back here, mark it done, and write
> the next checkpoint's plan.

**Spec:** `docs/superpowers/specs/2026-08-28-sonar-rag-voice-assistant-design.md`
**Original requirements:** `instructions.md` (repo root)

## Working agreement (from Shephrine, 2026-08-28)

- One checkpoint at a time. Implement it, then stop and wait for explicit
  sign-off before starting the next.
- This file is the handoff — keep the status table and "Where we left off"
  section current after every checkpoint.
- Address Shephrine by name at the start of each response.

## Status

| # | Checkpoint | Plan file | Status |
|---|---|---|---|
| 1 | Backend skeleton (FastAPI app, config, CORS, `/health`, singleton clients) | `2026-08-28-sonar-rag-01-backend-skeleton.md` | **Done** |
| 2 | Extraction services (PDF/TXT/PPTX/URL + chunking) | `2026-08-28-sonar-rag-02-extraction.md` | **Done** |
| 3 | Embeddings + Qdrant (`/upload`, `/add-url`, `/process`) | `2026-08-28-sonar-rag-03-embeddings-qdrant.md` | **Done** |
| 4 | Retrieval (top-K, MMR diversity, similarity gate) | `2026-08-28-sonar-rag-04-retrieval.md` | **Done** |
| 5 | LLM answer generation (Groq/Gemini fallback, streaming `/ask`) | `2026-08-28-sonar-rag-05-llm.md` | **Done** |
| 6 | Frontend integration (voice state machine fix, real API wiring, remove mock fallback, streaming TTS) | *not written yet* | **Done** |
| 7 | UI polish pass (design brief §15 corrected rules) | *not written yet* | Not started |
| 8 | README + full testing checklist walkthrough | *not written yet* | Not started |

## Where we left off

Checkpoint 6 is done.

Modified files:
- `src/services/apiService.ts`
  - `checkHealth()`: now reads `data.status`/`data.reason` from the JSON body instead of treating any HTTP 200 as `'online'`. Hardcoded demo telemetry (`'v1.4.2-FASTAPI'`, `235`, `'tactical-rag-v2'`) removed.
  - `uploadFile()` / `addUrl()`: now reads `data.source_id` and `data.segment_count` (the actual field names the backend returns). Local fallback simplified.
  - `processSources()`: now fires `POST /process`, receives `job_id`, then polls `GET /process/{job_id}` every 2 s (120 s deadline). Maps backend source statuses (`extracting/chunking/embedding/indexed`) to the 4 UI step indicators in real time. Returns real `chunkCount` from job response. Offline emulation fallback retained.
  - `askQuestion()`: now consumes the streaming `/ask` response correctly — reads line 1 as JSON `{citations, fallback}`, accumulates remaining chunks as answer tokens. Accepts `conversationHistory` parameter and forwards it as `conversation_history` in the request body.
- `src/hooks/useVoiceEngine.ts`
  - Added `conversationHistoryRef` (rolling 12-message / 6-turn buffer).
  - `processQuery()` passes `conversationHistoryRef.current` to `askQuestion()` and appends the new user+assistant turn after each response.
  - `resetSession()` clears the history ref.

Next action: get sign-off, then implement checkpoint 7 — UI polish pass.

### Decisions carried forward from checkpoint 1's review (read before writing checkpoint 2 or 6)

- **Gemini SDK:** checkpoint 1 only called the legacy `google-generativeai`
  package's module-global `genai.configure(...)`, with no singleton client
  object on `app.state` (unlike httpx/Qdrant/Groq) and no
  `get_gemini_client` DI getter. Checkpoint 2 (embeddings) should switch to
  the modern `google-genai` package instead and build `app.state.gemini_client
  = genai.Client(api_key=...)` as a real singleton with a matching getter,
  consistent with the other three clients — don't retrofit the old SDK.
- **`/health` HTTP status contract:** `/health` always returns HTTP 200, even
  for `degraded`/`offline` (the real state is in the JSON body's `status`
  field) — this is the intended, kept contract. But
  `src/services/apiService.ts`'s `checkHealth()` currently treats *any* 200
  as `'online'` and never reads `data.status`, so it will show ONLINE even
  when the backend reports all keys missing. Checkpoint 6 (frontend
  integration) must fix `checkHealth()` to read `data.status`/`data.reason`/
  `data.missing_env_vars` and stop substituting the hardcoded demo telemetry
  (`'v1.4.2-FASTAPI'`, `235`, `'tactical-rag-v2'`) it falls back to today.
- **Minor items deferred, not yet fixed** (low priority, revisit if they
  start to bite): no lifespan-not-run guard in `dependencies.py`'s getters;
  no `conftest.py` autouse fixture to scope `app.dependency_overrides`
  clearing (fine while only 3 test files exist, worth adding once more
  pile up); `/health` echoes raw Qdrant exception text (fine, no auth by
  design for this assessment); `/health` doesn't verify the *configured*
  `QDRANT_COLLECTION` exists, only that Qdrant is reachable at all; no
  timeout on the Qdrant ping while the frontend's `checkHealth()` aborts at
  3000ms.

## Known blockers

- No Groq / Gemini / Qdrant Cloud accounts exist yet. Backend code through
  checkpoint 2 is unit-testable without real keys. Checkpoint 3 onward needs
  real keys for end-to-end verification — flagged again when we get there.
- Deployment (Vercel/Netlify + Render/Koyeb) is out of scope for the build
  itself; checkpoint 8's README documents the steps only.
