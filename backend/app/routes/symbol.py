"""
backend/app/routes/symbol.py

POST /api/symbol

Accepts one decoded QR packet from the receiver, verifies it, and feeds
it into the peeling decoder. Returns the current decode progress.

The generation-counter double-check (snapshot before lock, verify after)
is the guard against stale symbols from a previous transfer contaminating
the new decoder after a re-upload.

After a successful decode, the progress update is broadcast to all
connected Receive-page WebSocket clients via receiver_socket.manager.
"""

import base64
import struct
import zlib

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.state.transfer_state import (
    BLOCK_SIZE,
    get_generation,
    get_state,
    is_ready,
    lock,
)

router = APIRouter()


class SymbolRequest(BaseModel):
    seed: int     # symbol_seed from the decoded packet header (uint32)
    payload: str  # Base64-encoded XOR'd block payload
    crc: int      # CRC32 from the packet trailer, for re-verification here


class SymbolResponse(BaseModel):
    progress: int
    k: int
    complete: bool
    dropped: bool = False


def _verify_crc(seed: int, payload_bytes: bytes, expected_crc: int) -> bool:
    """
    Re-derive the CRC32 the sender would have computed.
    Mirrors packet.py's serialize() layout: header (>IH) + payload, no CRC.
    """
    header = struct.pack(">IH", seed, len(payload_bytes))
    data = header + payload_bytes
    actual_crc = zlib.crc32(data) & 0xFFFFFFFF
    return actual_crc == expected_crc


@router.post("/symbol", response_model=SymbolResponse)
async def receive_symbol(body: SymbolRequest):
    if not is_ready():
        raise HTTPException(status_code=400, detail="No active transfer. Upload a file first.")

    # Snapshot the generation BEFORE acquiring the lock.
    # If a re-upload happens between here and the lock acquisition,
    # we'll catch it below and drop the symbol cleanly.
    gen_at_start = get_generation()

    # --- Decode and validate the payload ---
    try:
        payload_bytes = base64.b64decode(body.payload)
    except Exception:
        raise HTTPException(status_code=422, detail="payload is not valid Base64.")

    # Payload must be exactly one block — catches garbled decodes that beat CRC
    if len(payload_bytes) != BLOCK_SIZE:
        raise HTTPException(
            status_code=422,
            detail=f"Payload length {len(payload_bytes)} != expected block size {BLOCK_SIZE}.",
        )

    # Re-verify CRC before touching the decoder
    if not _verify_crc(body.seed, payload_bytes, body.crc):
        raise HTTPException(status_code=422, detail="CRC mismatch — symbol rejected.")

    # Acquire the module-level lock (the same object upload.py uses)
    async with lock:
        # Re-check generation after acquiring the lock.
        # If it changed, a re-upload happened while we were waiting — drop.
        if get_generation() != gen_at_start:
            return SymbolResponse(
                progress=0, k=0, complete=False, dropped=True
            )

        # Re-fetch state inside the lock — the object was replaced by reset()
        state = get_state()

        if state.decoder.is_complete:
            return SymbolResponse(
                progress=state.decoder.progress,
                k=state.k,
                complete=True,
                dropped=False,
            )

        state.decoder.add_symbol(body.seed, payload_bytes)

        progress  = state.decoder.progress
        k         = state.k
        complete  = state.decoder.is_complete

    # ── Broadcast to Receive-page WebSocket clients ─────────────────────────
    # Imported here (not at module level) to avoid a circular import:
    # main.py imports symbol.py before receiver_socket.py, so a top-level
    # import of receiver_socket inside symbol.py would fail on startup.
    from app.ws.receiver_socket import manager
    await manager.broadcast(progress, k, complete)

    return SymbolResponse(
        progress=progress,
        k=k,
        complete=complete,
        dropped=False,
    )
