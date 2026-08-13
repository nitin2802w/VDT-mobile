"""
backend/app/routes/download.py

GET /api/metadata   — lightweight status endpoint for receiver page rejoin
GET /api/download   — streams the reconstructed file after integrity verification

Locking contract: reset_decoder() is called while already holding
transfer_state.lock. reset_decoder() must NOT acquire the lock itself —
asyncio.Lock is not reentrant and doing so would deadlock permanently.

SHA-256 field discipline:
  - Step 3a (staleness check) reads state.upload_sha256 — the identity field,
    set once by reset() and never mutated.
  - Step 3f (integrity check) reads state.sha256_hash — the integrity field,
    same value in production but separately patchable in tests so the two
    branches can be exercised independently.
"""

import hashlib

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse, JSONResponse
from pydantic import BaseModel
from typing import Optional

from app.core.chunker import reconstruct_data
from app.state import transfer_state
from app.state.transfer_state import (
    BLOCK_SIZE,
    get_state,
    is_ready,
    lock,
    reset_decoder,
)

router = APIRouter()


class MetadataResponse(BaseModel):
    k: int
    file_size: int
    filename: str
    block_size: int
    sha256: str    # == upload_sha256, the identity field; pass back as expected_sha256
    progress: int
    complete: bool


@router.get("/metadata", response_model=MetadataResponse)
async def get_metadata():
    if not is_ready():
        raise HTTPException(status_code=404, detail="No active transfer.")
    state = get_state()
    return MetadataResponse(
        k=state.k,
        file_size=state.file_size,
        filename=state.filename,
        block_size=BLOCK_SIZE,
        sha256=state.upload_sha256,
        progress=state.decoder.progress,
        complete=state.decoder.is_complete,
    )


@router.get("/download")
async def download_file(expected_sha256: Optional[str] = Query(default=None)):
    # 1. Require the expected_sha256 param
    if expected_sha256 is None:
        raise HTTPException(
            status_code=400,
            detail="Missing required query parameter: expected_sha256. "
                   "Read sha256 from /api/upload or /api/metadata and pass it back.",
        )

    # 2. Check a transfer exists
    if not is_ready():
        raise HTTPException(status_code=404, detail="No active transfer.")

    # 3. Acquire lock for the entire read + integrity check sequence.
    #    We hold it through hashing to prevent concurrent /api/symbol POSTs
    #    from mutating known_blocks mid-reconstruction (data race).
    #    TODO: asyncio.to_thread() if file sizes grow beyond ~10 MB —
    #    the synchronous reconstruct + sha256 blocks the event loop for their
    #    duration (sub-100ms now, could matter for large files or B3 WS streams).
    async with lock:
        state = get_state()

        # 3a. Staleness check — compare against the immutable identity field.
        #     If upload_sha256 changed, a re-upload happened since the client
        #     last fetched metadata.
        if state.upload_sha256 != expected_sha256:
            return JSONResponse(
                status_code=409,
                content={
                    "error": "stale_transfer",
                    "message": "The transfer you requested is no longer active. Re-fetch /api/metadata.",
                },
            )

        # 3b. Completeness check
        if not state.decoder.is_complete:
            return JSONResponse(
                status_code=409,
                content={
                    "error": "not_complete",
                    "message": "Transfer not complete yet.",
                },
            )

        # 3c-d. Reconstruct
        blocks = state.decoder.get_reconstructed_blocks()
        reconstructed = reconstruct_data(blocks, state.file_size)

        # 3e. Recompute hash
        computed_hash = hashlib.sha256(reconstructed).hexdigest()

        # 3f. Integrity check — compare against the integrity field (sha256_hash).
        #     In production sha256_hash == upload_sha256 always. They are kept
        #     as separate fields so tests can patch sha256_hash to simulate
        #     corruption without accidentally tripping the staleness check above.
        if computed_hash != state.sha256_hash:
            # Reset decoder so the receiver can keep feeding symbols
            # without requiring a re-upload. Caller (us) holds the lock —
            # reset_decoder() must NOT acquire it internally.
            reset_decoder()
            return JSONResponse(
                status_code=409,
                content={
                    "error": "hash_mismatch",
                    "message": "Reconstruction failed integrity check. Keep receiving.",
                },
            )

        # 3g. Hash matches — capture what we need before releasing the lock
        filename = state.filename
        file_bytes = reconstructed

    # 4. Stream the verified file
    def byte_generator():
        yield file_bytes

    return StreamingResponse(
        byte_generator(),
        media_type="application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
