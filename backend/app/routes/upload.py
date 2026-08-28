"""POST /upload — accept a file, extract text, return a staged source record.

The file is extracted immediately on upload and the temp file is deleted
afterwards (per instructions.md §5: don't persist raw files). The returned
source_id is what the frontend passes to POST /process.
"""

import tempfile
import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException, UploadFile
from pydantic import BaseModel

from app.models import ExtractedSegment, SourceType
from app.services.extraction import ExtractionError, extract_pdf, extract_pptx, extract_txt

router = APIRouter()

_ALLOWED_EXTENSIONS: dict[str, SourceType] = {
    "pdf": "pdf",
    "txt": "txt",
    "pptx": "pptx",
}

# In-process staging store: source_id -> list of extracted segments.
# Checkpoint 3 only; checkpoint 4's /process route reads from here.
_staged: dict[str, list[ExtractedSegment]] = {}


class UploadResponse(BaseModel):
    source_id: str
    source_name: str
    source_type: SourceType
    segment_count: int


@router.post("/upload", response_model=UploadResponse)
async def upload_file(file: UploadFile) -> UploadResponse:
    filename = file.filename or "upload"
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""

    if ext not in _ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=422,
            detail=f"Unsupported file type '.{ext}'. Allowed: pdf, txt, pptx.",
        )

    source_type = _ALLOWED_EXTENSIONS[ext]
    source_id = str(uuid.uuid4())

    # Write to a temp file, extract, then delete immediately.
    with tempfile.NamedTemporaryFile(suffix=f".{ext}", delete=False) as tmp:
        tmp_path = Path(tmp.name)
        content = await file.read()
        tmp.write(content)

    try:
        if source_type == "pdf":
            segments = extract_pdf(tmp_path, source_name=filename)
        elif source_type == "pptx":
            segments = extract_pptx(tmp_path, source_name=filename)
        else:
            segments = extract_txt(tmp_path, source_name=filename)
    except ExtractionError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    finally:
        tmp_path.unlink(missing_ok=True)

    _staged[source_id] = segments

    return UploadResponse(
        source_id=source_id,
        source_name=filename,
        source_type=source_type,
        segment_count=len(segments),
    )


def get_staged() -> dict[str, list[ExtractedSegment]]:
    """Expose the staging store for /process to consume."""
    return _staged
