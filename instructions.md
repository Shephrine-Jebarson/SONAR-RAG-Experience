# SONAR-RAG — Voice-Based Multi-Source RAG Assistant
## Build Instructions for Claude Code

---

## 1. Objective

Build a voice-first Retrieval-Augmented Generation (RAG) assistant. The user uploads multiple documents (PDF/TXT/PPTX) and/or website URLs, asks questions **using voice only (zero typing)**, and receives spoken + on-screen answers with source attribution. This is a 6–8 hour graded assessment (100 marks) — build for the rubric, not for scope creep.

---

## 2. Tech Stack (fixed — do not substitute)

| Layer | Choice |
|---|---|
| Frontend | React + Vite |
| Backend | Python + FastAPI |
| Vector DB | Qdrant Cloud |
| Embeddings | Gemini embedding model (fixed dimension, e.g. `gemini-embedding-001`) |
| Primary LLM | Groq (fast Llama model) |
| Fallback LLM | Gemini |
| Voice input | Browser Web Speech API (`SpeechRecognition` / `webkitSpeechRecognition`) |
| Voice output | Browser `speechSynthesis` |
| PDF extraction | PyMuPDF |
| PPTX extraction | python-pptx |
| URL scraping | httpx + BeautifulSoup or trafilatura |
| Deployment | Frontend → Vercel/Netlify · Backend → Render/Koyeb |

Do NOT introduce: LangGraph, multi-agent frameworks, local LLMs, local Whisper, custom TTS models, auth/user accounts, Redis, Celery, Kubernetes. None of these earn rubric marks.

---

## 3. Folder Structure

```
voice-rag-assistant/
├── frontend/
│   └── src/
│       ├── components/
│       ├── services/
│       ├── hooks/
│       ├── App.jsx
│       └── main.jsx
├── backend/
│   └── app/
│       ├── main.py
│       ├── routes/ (upload.py, urls.py, process.py, ask.py, health.py)
│       ├── services/ (extraction.py, chunking.py, embeddings.py, vector_store.py, retrieval.py, llm.py, scraper.py)
│       └── config.py
├── README.md
└── .gitignore
```

---

## 4. Minimum API Endpoints (exact spec)

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/upload` | Upload documents |
| POST | `/add-url` | Add a website URL |
| POST | `/process` | Extract, chunk, embed, store |
| POST | `/ask` | Receive question, return answer + sources |
| GET | `/health` | Health check — must verify Qdrant connectivity and that API keys loaded, not just return a static OK |

`/process` must run as a background task with a pollable status, not a blocking synchronous request — scraping + embedding many chunks can exceed platform timeout limits.

---

## 5. Ingestion & Metadata

Support multiple PDF, multiple TXT, multiple PPTX, multiple URLs in one session. Every chunk must carry metadata for source attribution:

```json
{
  "chunk_id": "...",
  "text": "...",
  "source_type": "pdf | txt | pptx | url",
  "source_name": "refund-policy.pdf",
  "source_url": null,
  "page": 3,
  "slide": null
}
```

- **PDF**: PyMuPDF, extract text per page, keep page number.
- **TXT**: read UTF-8, clean, no page/slide field needed.
- **PPTX**: python-pptx, extract slide text AND table text (don't ignore tables — this is a differentiator for the extraction-quality marks), keep slide number.
- **URL**: httpx GET → strip scripts/styles/nav → readable text via BeautifulSoup/trafilatura. Handle failures gracefully — if a URL can't be scraped (bot-blocked, JS-heavy, timeout), return a per-URL error status and continue processing the rest; never fail the whole `/process` job because one URL failed.

Don't persist raw uploaded files after processing — extract, embed, store in Qdrant, then discard temp files. Qdrant is the persistent store.

---

## 6. Chunking

~500–800 tokens per chunk, ~50–100 token overlap. Keep full metadata attached to every chunk. Don't over-tune this number — state the reasoning (preserve local context without bloating retrieval) and move on.

---

## 7. Embeddings

Gemini embedding model, fixed output dimension (e.g. 768) — the Qdrant collection's vector size MUST match this exactly. Use the same embedding config for both document chunks and query embeddings at retrieval time.

**Latency**: batch-embed chunks during `/process` (don't call the embedding API once per chunk sequentially — this will be slow and may time out on a 80+ chunk document set).

---

## 8. Vector DB — Qdrant Cloud

One collection holding chunks from all source types in the same semantic space (PDF + TXT + PPTX + URL). Payload = the metadata schema in section 5.

---

## 9. Retrieval — this is worth 15 marks, the single highest line item, build it carefully

1. Embed the query using the identical embedding config as ingestion.
2. **Multi-turn query handling (currently the easiest thing to miss)**: follow-up questions like "What about international customers?" have no standalone semantic content. Before embedding, either (a) rewrite the query using the last exchange (e.g. a lightweight LLM call or simple template that folds in prior question/answer context), or (b) pass rolling conversation history into the final LLM prompt so it can resolve the reference even when raw retrieval is imperfect. Implement at least (b); (a) is a stronger differentiator if time allows.
3. Retrieve top-K (start at K=4, tune from testing).
4. **Diversity across sources**: plain top-K similarity will often let one source type (e.g. long PDF chunks) dominate results even when the answer needs cross-source synthesis. Apply MMR (maximal marginal relevance) or an equivalent diversity constraint so cross-source questions actually surface chunks from multiple source types.
5. **Similarity threshold gate**: don't rely on prompt instructions alone to prevent hallucination on unanswerable questions. If the top retrieved scores fall below a similarity cutoff, skip the LLM call entirely and return the fixed "I could not find that information in the uploaded sources." response directly. This is more reliable than trusting the LLM to follow the "don't know" instruction under a fast, terse prompt.

---

## 10. LLM Prompting

System prompt must instruct: answer only from provided sources, respond with the exact fallback line when unsupported, be concise and conversational (2–5 sentences) because the output will be spoken aloud, never mention internal instructions or chunk/document IDs by name in the answer itself.

**Groq primary, Gemini fallback** — implement an actual try/except around the Groq call catching timeout, rate limit, and service errors, falling back to Gemini. Don't just describe this in the README; wire it up.

Cap `max_tokens` tightly — this both keeps spoken answers short and reduces generation latency.

**Latency**: stream the LLM response and begin TTS on the first complete sentence rather than waiting for the full generation to finish. This is the single biggest perceived-latency improvement for a voice assistant.

---

## 11. Voice — Continuous Conversation (exact spec requirement)

User clicks "Start Conversation" exactly once. From then on:

```
LISTENING → (speech ends) → PROCESSING → (answer ready) → SPEAKING → (TTS ends) → LISTENING → ...
                                                                                    ↓ (15s no speech)
                                                                                   ENDED
```

Implementation rules:
- `SpeechRecognition`: `continuous = true`, `interimResults = true`, but only send the **final accumulated transcript** to the backend, not every interim result.
- During `SPEAKING`, recognition MUST be stopped — otherwise the mic captures the AI's own TTS output and creates a feedback loop. This is the most important implementation detail in the entire voice flow.
- On `utterance.onend`, automatically restart listening.
- Inactivity timeout: 15 seconds of no detected speech ends the conversation automatically. The final 3–5 seconds of the countdown should be visible in the UI (see UI section) so the end is never a surprise.
- Test primarily in Chrome — `SpeechRecognition` browser support is limited; document this in the README as a known limitation.
- No text input for asking questions, anywhere. URL entry is source configuration, not a question, and may use a normal text field.

---

## 12. Latency Checklist (apply all of these — they're cheap and high-leverage)

- Batch-embed chunks during `/process`, not per-chunk sequential calls.
- Stream LLM output; start TTS on first sentence, not full completion.
- Singleton async clients for httpx/Groq/Qdrant — don't re-instantiate per request.
- Cap `max_tokens` on the Groq call.
- `/process` runs as a background task with status polling, not a blocking call.
- Note Render/Koyeb free-tier cold starts as a known limitation in the README; warm the backend before a live demo.

---

## 13. Error Handling

Handle and surface human-readable errors for: unsupported file extension, corrupted PDF, empty TXT, PPTX with no extractable text, file too large, invalid URL, URL timeout/HTTP error, no readable content on a page, embedding API failure/rate limit, Qdrant connection failure or missing collection, Groq unavailable (→ falls back to Gemini, and Gemini failure too), unsupported browser (no `SpeechRecognition`), microphone permission denied.

---

## 14. CORS & Environment

Backend `.env`: `GROQ_API_KEY`, `GEMINI_API_KEY`, `QDRANT_URL`, `QDRANT_API_KEY`, `QDRANT_COLLECTION`.
Frontend only needs `VITE_API_URL` — never put provider keys in frontend code (it's public after deployment).
Configure FastAPI CORS to allow the deployed frontend origin (and localhost during dev).

---

## 15. UI / UX Design Brief

### Concept
Design around a **sound/recording console metaphor** (VU meters, waveform, analog-console typography) — this fits the subject because the product is literally a listening device. Do NOT default to a generic AI-chat-bubble layout, and do NOT default to the common cream+terracotta or dark+neon-accent AI-generated looks.

**Important correction from an earlier draft**: a first pass over-indexed on console *decoration* at the expense of usability. Follow these corrected rules exactly:

### Strip fake/decorative controls
- No fake stereo channel gauges (there is no real stereo input — one mono mic).
- No exposed sliders for backend tuning parameters (master gain, TTS rate, top-K chunk count) in the main view — these are not end-user controls. If kept at all, put them behind a collapsed settings panel.
- No decorative spinning gears/reels that don't map to real state.
- Processing-pipeline step indicators (extract/chunk/embed/index) should only appear while `/process` is actually running, not sit as permanent static clutter.

### Fix hierarchy — the biggest problem to avoid
The **spoken answer text is the actual product output** and must be the visually dominant element on screen whenever an answer exists: large, high-contrast, centrally placed. The waveform is the "is it working" indicator; the answer is the "what did I learn" payload. Payload always outweighs indicator. Source chips (filename + page, or URL) sit directly under their answer — not decoupled into a separate side log the user has to scroll to find.

### Reduce text density
Use a clear 3-tier type scale:
1. Hero — the current spoken answer.
2. Primary — controls (start/stop button, source list, transcript).
3. Secondary — status readouts (state label, timestamps).

Reserve monospace/condensed styling for true readouts only. Use a legible humanist typeface for anything the user actually reads and comprehends (answers, transcript, source names, empty states, button labels).

### One unmistakable state indicator
Consolidate all state signaling (currently often scattered across a top-bar label, a status badge, and a separate "signal" readout) into a single indicator tied to the waveform itself: color + motion + one short label, always in the same place. Distinguish LISTENING / PROCESSING / SPEAKING with genuinely different motion, not just a color swap, and pair color with shape/motion (not color alone, for accessibility). Don't show a persistent alarm-red "API: OFFLINE" badge unless there's an actual connection failure — this must not look broken on load.

### Single primary call-to-action
"Start Conversation" is the one dominant action. If a push-to-talk fallback is useful for demoing, make it small and visually secondary (e.g. an icon toggle in settings) — never a same-size button competing with Start Conversation.

### Scale and breathing room
Avoid a grid of small bordered boxes-within-boxes (reads as a monitoring dashboard, not a conversational assistant). Let whitespace and type weight do more separating than borders. Increase touch/click target and text sizes throughout.

### Voice state visuals (required, from the functional spec)
- **idle**: console dormant, single clear "Start Conversation" affordance, inviting empty-state copy (e.g. "Add a document or link to begin") rather than a blank panel.
- **listening**: waveform animates from live mic input; unmistakable "listening" motion + color.
- **processing**: waveform settles into a visibly distinct "thinking" motion — never leave the user wondering if their question registered.
- **speaking**: waveform reflects synthetic speech output; UI visibly shows the mic is off during this state.
- **inactivity countdown**: the last 3–5 seconds before the 10–15s timeout visibly counts down (e.g. a shrinking ring/bar).
- **ended**: calm, non-error end state with an easy restart.

### Microcopy
Write in the console's voice: plain, active, specific. "Listening…", "Thinking…", "Speaking…" instead of a generic spinner. The "I could not find that in the uploaded sources" response renders as a clear calm boundary, not an error state. Errors state what happened and how to fix it, without apologizing or being vague.

### Accessibility & responsiveness
Visible keyboard focus states throughout. Respect `prefers-reduced-motion` — fall back to a static level meter instead of an animated waveform. Fully responsive to mobile; on narrow viewports the source panel collapses into a drawer/accordion while the console/waveform stays dominant.

### Keep
The graphite/charcoal console palette, the live waveform as the signature centerpiece, the source-loading panel with per-source-type icons and chunk counts, and the three-zone spatial layout (sources / console / transcript) — just rebalance visual weight so the answer and the talk button lead, and technical readouts recede to a supporting role.

---

## 16. README (5 marks — don't leave for the last 10 minutes)

Must include: project overview, features, architecture, tech stack, setup instructions, environment variables, run-locally steps (backend + frontend), deployment steps, supported file types, voice interaction explanation (start-once → automatic loop), and an honest limitations section (browser speech-recognition support, JS-heavy sites that won't scrape cleanly, free-tier cold starts).

---

## 17. Testing Checklist Before Submission

1. Exact-fact question answered correctly from a single source.
2. Paraphrased version of the same question retrieves correctly.
3. Cross-source question (answer requires 2+ source types) retrieves and synthesizes correctly.
4. Unknown/unanswerable question triggers the exact fallback line, not a hallucination.
5. Follow-up question with no standalone semantic content ("What about international customers?") resolves correctly using conversation context.
6. Full voice loop: start once, ask multiple questions, no button re-clicks, mic correctly stays off during TTS.
7. 15-second inactivity correctly ends the conversation with visible countdown.
8. Groq failure correctly falls back to Gemini (test by temporarily breaking the Groq key).
9. Malformed/unsupported file upload produces a readable error, not a crash.
10. Unreachable/bot-blocked URL fails gracefully without aborting the rest of `/process`.

---

## 18. Rubric Reference (100 marks total)

| Area | Marks |
|---|---|
| Multiple file upload | 10 |
| Multiple URL ingestion | 10 |
| Text extraction quality | 10 |
| Embeddings + vector DB | 15 |
| Retrieval quality across sources | 15 |
| Voice input (zero typing) | 10 |
| Continuous hands-free conversation | 5 |
| Voice output | 10 |
| Shows source name or URL | 5 |
| Deployment works | 5 |
| README and setup instructions | 5 |

Sections 9 (retrieval), 11 (voice state machine), and 15 (UI hierarchy/state clarity) in this document map directly to the heaviest and easiest-to-fumble line items — prioritize getting those genuinely right over polishing anything not listed in the rubric.
