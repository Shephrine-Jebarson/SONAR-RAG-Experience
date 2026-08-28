"""In-memory job state store for /process background tasks.

A single-process FastAPI app doesn't need Redis/Celery — a module-level
dict is sufficient and avoids introducing disallowed infrastructure.
The store is imported by both the /process route (writes) and the
GET /process/{job_id} polling endpoint (reads).
"""

import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional


class JobStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    DONE = "done"
    ERROR = "error"


class SourceStatus(str, Enum):
    PENDING = "pending"
    EXTRACTING = "extracting"
    CHUNKING = "chunking"
    EMBEDDING = "embedding"
    INDEXED = "indexed"
    ERROR = "error"


@dataclass
class SourceProgress:
    source_id: str
    source_name: str
    status: SourceStatus = SourceStatus.PENDING
    chunk_count: Optional[int] = None
    error: Optional[str] = None


@dataclass
class Job:
    job_id: str
    status: JobStatus = JobStatus.PENDING
    sources: list[SourceProgress] = field(default_factory=list)
    error: Optional[str] = None  # top-level error (e.g. embedding API down)


# Module-level store — lives for the lifetime of the process.
_jobs: dict[str, Job] = {}


def create_job(source_ids: list[str], source_names: dict[str, str]) -> Job:
    job_id = str(uuid.uuid4())
    job = Job(
        job_id=job_id,
        sources=[
            SourceProgress(source_id=sid, source_name=source_names.get(sid, sid))
            for sid in source_ids
        ],
    )
    _jobs[job_id] = job
    return job


def get_job(job_id: str) -> Optional[Job]:
    return _jobs.get(job_id)
