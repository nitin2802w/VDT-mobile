"""
backend/app/routes/upload.py

POST /api/upload

Accepts a file upload, chunks it, hashes it, and initialises the global
transfer state. A new upload atomically replaces whatever was previously
active — the generation counter in transfer_state.py handles any
in-flight /api/symbol POSTs from the old receiver.
"""

import hashlib

from fastapi import APIRouter, HTTPException, UploadFile, File
from pydantic import BaseModel

from app.core.chunker import chunk_data
from app.state.transfer_state import (
    BLOCK_SIZE,
    MAX_UPLOAD_BYTES,
    get_state,
    lock,
    reset,
)

router = APIRouter()


class UploadResponse(BaseModel):
    k: int
    file_size: int
    filename: str
    block_size: int
    sha256: str


@router.post("/upload", response_model=UploadResponse)
async def upload_file(file: UploadFile = File(...)):
    raw = await file.read()

    if len(raw) == 0:
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")

    if len(raw) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"File too large. Maximum allowed size is {MAX_UPLOAD_BYTES // (1024*1024)} MB.",
        )

    sha256_hash = hashlib.sha256(raw).hexdigest()
    blocks, file_size = chunk_data(raw, BLOCK_SIZE)

    # Always acquire the module-level lock (never replaced on reset)
    # before calling reset() so concurrent symbol POSTs are blocked
    # during the swap and see the updated generation counter.
    async with lock:
        reset(
            filename=file.filename or "unknown",
            file_size=file_size,
            blocks=blocks,
            sha256_hash=sha256_hash,
        )
        new_state = get_state()

    return UploadResponse(
        k=new_state.k,
        file_size=new_state.file_size,
        filename=new_state.filename,
        block_size=BLOCK_SIZE,
        sha256=new_state.upload_sha256,
    )
