"""POST /process — start background embed+index pipeline.
GET  /process/{job_id} — poll job status.

The pipeline runs as a FastAPI BackgroundTask (no Redis/Celery needed for a
single-process app). Each source is processed independently so one bad
source never aborts the rest.
"""

from concurrent.futures import ThreadPoolExecutor

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from google import genai
from pydantic import BaseModel
from qdrant_client import QdrantClient

from app.config import Settings
from app.dependencies import get_app_settings, get_gemini_client, get_qdrant_client
from app.job_store import Job, JobStatus, SourceProgress, SourceStatus, create_job, get_job
from app.models import ExtractedSegment
from app.routes.upload import get_staged as get_upload_staged
from app.routes.urls import get_staged as get_url_staged
from app.services.chunking import chunk_segments
from app.services.embeddings import EmbeddingError, embed_chunks
from app.services.vector_store import VectorStoreError, ensure_collection, upsert_chunks

router = APIRouter()

# Each source's pipeline (chunk -> embed -> upsert) is independent of every
# other source, so multi-document ingestion runs them concurrently on a
# small bounded pool instead of one at a time.
_MAX_CONCURRENT_SOURCES = 4


class ProcessRequest(BaseModel):
    source_ids: list[str]


class ProcessResponse(BaseModel):
    job_id: str
    status: str


class JobStatusResponse(BaseModel):
    job_id: str
    status: str
    sources: list[dict]
    error: str | None = None


@router.post("/process", response_model=ProcessResponse)
async def start_process(
    body: ProcessRequest,
    background_tasks: BackgroundTasks,
    settings: Settings = Depends(get_app_settings),
    gemini: genai.Client = Depends(get_gemini_client),
    qdrant: QdrantClient = Depends(get_qdrant_client),
) -> ProcessResponse:
    if not body.source_ids:
        raise HTTPException(status_code=422, detail="source_ids must not be empty")

    # Merge both staging stores to resolve source_ids
    all_staged: dict[str, list[ExtractedSegment]] = {
        **get_upload_staged(),
        **get_url_staged(),
    }

    unknown = [sid for sid in body.source_ids if sid not in all_staged]
    if unknown:
        raise HTTPException(
            status_code=422,
            detail=f"Unknown source_ids (not yet uploaded/added): {unknown}",
        )

    source_names = {
        sid: (all_staged[sid][0].source_name if all_staged[sid] else sid)
        for sid in body.source_ids
    }

    job = create_job(body.source_ids, source_names)

    background_tasks.add_task(
        _run_pipeline,
        job=job,
        source_ids=body.source_ids,
        all_staged=all_staged,
        gemini=gemini,
        qdrant=qdrant,
        collection_name=settings.qdrant_collection,
    )

    return ProcessResponse(job_id=job.job_id, status=job.status)


@router.get("/process/{job_id}", response_model=JobStatusResponse)
def poll_process(job_id: str) -> JobStatusResponse:
    job = get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail=f"Job not found: {job_id}")

    return JobStatusResponse(
        job_id=job.job_id,
        status=job.status,
        sources=[
            {
                "source_id": sp.source_id,
                "source_name": sp.source_name,
                "status": sp.status,
                "chunk_count": sp.chunk_count,
                "error": sp.error,
            }
            for sp in job.sources
        ],
        error=job.error,
    )


def _process_one_source(
    source_progress: SourceProgress,
    segments: list[ExtractedSegment],
    gemini: genai.Client,
    qdrant: QdrantClient,
    collection_name: str,
) -> None:
    """Chunk → embed (batch) → upsert for a single source.

    Mutates source_progress in place. Each source only ever writes to its
    own SourceProgress instance, so this is safe to run concurrently across
    sources from a thread pool — no shared mutable state between sources.
    """
    sid = source_progress.source_id

    # --- EXTRACT (already done at upload/add-url time) ---
    source_progress.status = SourceStatus.EXTRACTING
    if not segments:
        source_progress.status = SourceStatus.ERROR
        source_progress.error = "No extracted segments found for this source."
        return

    # --- CHUNK ---
    source_progress.status = SourceStatus.CHUNKING
    try:
        chunks = chunk_segments(segments, source_id=sid)
    except Exception as exc:
        source_progress.status = SourceStatus.ERROR
        source_progress.error = f"Chunking failed: {exc}"
        return

    source_progress.chunk_count = len(chunks)

    # --- EMBED (batch) ---
    source_progress.status = SourceStatus.EMBEDDING
    try:
        vectors = embed_chunks(chunks, gemini)
    except EmbeddingError as exc:
        source_progress.status = SourceStatus.ERROR
        source_progress.error = str(exc)
        return

    # --- UPSERT into Qdrant ---
    try:
        upsert_chunks(chunks, vectors, qdrant, collection_name)
    except VectorStoreError as exc:
        source_progress.status = SourceStatus.ERROR
        source_progress.error = str(exc)
        return

    source_progress.status = SourceStatus.INDEXED


def _run_pipeline(
    job: Job,
    source_ids: list[str],
    all_staged: dict[str, list[ExtractedSegment]],
    gemini: genai.Client,
    qdrant: QdrantClient,
    collection_name: str,
) -> None:
    """Background task: chunk → embed (batch) → upsert for each source.

    Sources are processed concurrently (bounded) since each source's
    pipeline is fully independent of the others — this is what keeps
    multi-document ingestion latency from scaling linearly with the number
    of uploaded documents.
    """
    job.status = JobStatus.RUNNING

    # Ensure the Qdrant collection exists before processing any source.
    try:
        ensure_collection(qdrant, collection_name)
    except VectorStoreError as exc:
        job.status = JobStatus.ERROR
        job.error = str(exc)
        return

    max_workers = min(_MAX_CONCURRENT_SOURCES, len(job.sources)) or 1
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        list(executor.map(
            lambda sp: _process_one_source(sp, all_staged.get(sp.source_id, []), gemini, qdrant, collection_name),
            job.sources,
        ))

    # Mark job done — even if some sources errored, the job itself completed.
    all_errored = all(sp.status == SourceStatus.ERROR for sp in job.sources)
    job.status = JobStatus.ERROR if all_errored else JobStatus.DONE
