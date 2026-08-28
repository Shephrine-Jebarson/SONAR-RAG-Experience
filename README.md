# SONAR-RAG — Voice-Based Multi-Source RAG Assistant

A voice-first Retrieval-Augmented Generation assistant. Upload documents (PDF, TXT, PPTX) and/or website URLs, ask questions **by voice only**, and receive spoken + on-screen answers with source attribution.

---

## Tech Stack

| Layer | Choice |
|---|---|
| Frontend | React 18 + TypeScript + Vite |
| Backend | Python 3.11 + FastAPI |
| Vector DB | Qdrant Cloud |
| Embeddings | `gemini-embedding-001` (768-dim) |
| Primary LLM | Groq `openai/gpt-oss-120b` |
| Fallback LLM | Gemini `gemini-2.0-flash` |
| Voice input | Browser Web Speech API (`SpeechRecognition`) |
| Voice output | Browser `speechSynthesis` |
| PDF extraction | PyMuPDF |
| PPTX extraction | python-pptx (text + tables) |
| URL scraping | httpx + BeautifulSoup / trafilatura |

---

## Project Structure

```
voice-rag-assistant/
├── frontend/          # React + Vite (this repo root)
│   └── src/
│       ├── components/
│       ├── hooks/useVoiceEngine.ts
│       ├── services/apiService.ts
│       └── App.tsx
├── backend/
│   └── app/
│       ├── routes/    upload.py · urls.py · process.py · ask.py · health.py
│       ├── services/  extraction.py · chunking.py · embeddings.py
│       │              vector_store.py · retrieval.py · llm.py · scraper.py
│       └── config.py
└── README.md
```

---

## Setup

### Backend

```bash
cd backend
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env   # fill in keys — see backend/.env.example for the full, authoritative list
uvicorn app.main:app --reload
```

`backend/.env.example` (kept in sync with `app/config.py`'s `Settings` class):

```
GROQ_API_KEY=
GEMINI_API_KEY=
QDRANT_URL=
QDRANT_API_KEY=
QDRANT_COLLECTION=sonar_rag_chunks
CORS_ORIGINS=http://localhost:5174,http://localhost:5173,http://localhost:3000
```

### Frontend

```bash
npm install
cp .env.example .env.local   # sets VITE_API_URL — defaults to http://localhost:8000 if skipped
npm run dev
```

---

## API Endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/upload` | Upload a PDF, TXT, or PPTX file |
| `POST` | `/add-url` | Register a website URL |
| `POST` | `/process` | Extract → chunk → embed → store (background job) |
| `GET` | `/process/{job_id}` | Poll processing status |
| `POST` | `/ask` | Voice query → streaming answer + citations |
| `GET` | `/health` | Verify Qdrant connectivity + API key presence |

---

## Key Design Decisions

### Chunking
~650 tokens per chunk, ~75 token overlap. Preserves local context without bloating retrieval payloads.

### Retrieval (15-mark item)
1. Query is rewritten via a lightweight Groq call before embedding to resolve follow-up references ("What about international customers?" → standalone query).
2. Rolling 6-turn conversation history is also passed to the LLM prompt as a second safety net.
3. Candidate pool = `top_k × 3`, then MMR re-ranking (λ=0.6) forces cross-source diversity.
4. Similarity threshold gate (0.52): if the best MMR score is below the cutoff, the LLM is never called and the fixed fallback line is returned directly. This value was empirically tuned against a real Qdrant collection — see the comment above `SIMILARITY_THRESHOLD` in `app/services/retrieval.py` for the measurements behind it (genuinely irrelevant queries scored ≤0.50, legitimate but weakly-worded queries scored as low as 0.548).

### Streaming TTS
The `/ask` endpoint streams raw tokens. The frontend accumulates tokens and fires `speechSynthesis` on the **first complete sentence** (`.`, `!`, `?` boundary) rather than waiting for full generation — the single biggest perceived-latency improvement for a voice assistant.

### Voice Loop

The state machine lives in `src/hooks/useVoiceEngine.ts` (`voiceState`, type `VoiceState` in `src/types/index.ts`). Six states, and one of them is a naming trap worth calling out explicitly:

| State | Entered when | Exits to |
|---|---|---|
| `idle` | App start, or "Start again" after `ended` | `listening` (user clicks Start) |
| `listening` | Start clicked, or after TTS finishes speaking | `processing` (final speech recognized), or `ended` (silence timer — see below) |
| `processing` | Final query text is ready | `speaking` (answer received), or `inactivity_countdown` (RAG/LLM call threw — see below) |
| `speaking` | Answer + TTS ready | `listening`, automatically, on `utterance.onend` |
| `inactivity_countdown` | **A `processing` request errored** (not literally mic inactivity, despite the name) | `ended` (countdown reaches 0), or `listening` (user clicks "Stay active") |
| `ended` | Countdown hits 0, or the separate silent no-speech timer (`resetInactivityTimer`, `autoStandbySec`) fires directly from `listening` | `idle` (user clicks "Start again" / `resetSession()`) |

```
        Start clicked                    final speech
  IDLE ────────────────► LISTENING ─────────────────────► PROCESSING
   ▲                        │  ▲                             │  │
   │                        │  └────────── utterance.onend ──┘  │
   │ "Start again"          │                (loops back)  answer   RAG/LLM
   │                        │ no speech for      ready      error
   │                        │ autoStandbySec        │          │
   │                        ▼                       ▼          ▼
   └──────────────────── ENDED ◄── countdown=0 ── INACTIVITY_COUNTDOWN
                            ▲                       │
                            └── "Stay active" ───────┘ (back to LISTENING)
```

Recognition is **stopped before TTS starts** to prevent the mic capturing the AI's own voice output; it restarts automatically once TTS ends. Note that `inactivity_countdown` is entered only from a failed `processing` call, not from silence — the silent, no-warning path to `ended` is a *separate* timer (`resetInactivityTimer`) reset on every recognized utterance while `listening`.

### Groq → Gemini Fallback
A `try/except` wraps the Groq streaming call. Any exception (timeout, rate limit, service error) falls through to Gemini. If Gemini also fails, the fixed fallback line is yielded.

---

## Running Tests

```bash
cd backend
pytest -v   # 93 tests
```

There are currently **no automated frontend tests** (no Vitest/Jest/RTL setup) — frontend changes are verified manually and, during development, via headless-browser Playwright smoke checks that aren't part of the committed test suite. Backend coverage is comprehensive; frontend is not. Worth knowing before relying on `npm run build`/`tsc` alone as a correctness signal for UI logic.

---

## Deployment

- **Frontend** → Vercel or Netlify. Set `VITE_API_URL` to your backend URL.
- **Backend** → Render or Koyeb (free tier). Set all env vars in the dashboard.

**Known limitation — cold starts**: Render/Koyeb free-tier instances spin down after inactivity. The first request after a cold start can take 30–60 seconds. Warm the backend by hitting `/health` before a live demo.

**Known limitation — browser support**: `SpeechRecognition` is only supported in Chromium-based browsers (Chrome, Edge). Firefox and Safari do not support it. Test in Chrome.

---

## Supported File Types

| Type | Extraction | Metadata |
|---|---|---|
| PDF | PyMuPDF, per-page text | `page` number |
| TXT | UTF-8 read | — |
| PPTX | python-pptx, slide text + table cells | `slide` number |
| URL | httpx GET + BeautifulSoup/trafilatura | `source_url` |

URL scraping failures (bot-blocked, JS-heavy, timeout) are reported per-URL and never abort the whole `/process` job.
