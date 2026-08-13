"""
backend/app/state/transfer_state.py

Single global state object for the entire server process.
Only one transfer is active at a time — a new upload via POST /api/upload
replaces whatever was previously active by calling reset().

Locking contract (must be honoured by every caller):
  reset() and reset_decoder() NEVER acquire the lock themselves.
  The caller always holds `transfer_state.lock` before calling either.
  asyncio.Lock is not reentrant — a task that tries to acquire a lock
  it already holds blocks forever.

The generation counter is the guard against stale-symbol contamination:
when a re-upload happens mid-transfer, any in-flight /api/symbol POSTs
from the old receiver will see a changed generation and be dropped silently.

Two SHA-256 fields with distinct responsibilities:
  upload_sha256  — identity field, set once by reset(), read by /api/download
                   step 3a (staleness check). Never mutated after reset().
  sha256_hash    — integrity field, set once by reset(), read by /api/download
                   step 3f (reconstruction check). Same value as upload_sha256
                   in production; kept separate so tests can patch sha256_hash
                   to simulate a corruption without accidentally tripping the
                   staleness check in the same request.
"""

import asyncio
from dataclasses import dataclass
from typing import Optional

from app.core.fountain import FountainEncoder
from app.core.peeling_decoder import PeelingDecoder

# ── Named constants ────────────────────────────────────────────────────────────
# Change these to tune performance. Both FountainEncoder and PeelingDecoder
# are always initialised from these values so they can never drift apart.

BLOCK_SIZE: int = 400           # bytes per source block
FOUNTAIN_C: float = 0.03        # Robust Soliton c parameter
FOUNTAIN_DELTA: float = 0.05    # Robust Soliton delta parameter
MAX_UPLOAD_BYTES: int = 10 * 1024 * 1024  # 10 MB hard cap


@dataclass
class TransferState:
    # Sender side
    filename: str
    file_size: int
    blocks: list

    # Identity field — set once at upload, read by /api/download staleness check.
    # ONLY reset() writes this. Nothing else ever should.
    upload_sha256: str

    # Integrity field — same value as upload_sha256 at upload time.
    # Read by /api/download reconstruction check. Tests may patch this field
    # to simulate corruption without triggering the staleness check.
    sha256_hash: str

    encoder: FountainEncoder
    decoder: PeelingDecoder

    # Internal generation counter — never exposed in the API or packet format.
    # Bumped by reset() so /api/symbol can detect mid-request re-uploads.
    generation: int = 0

    @property
    def k(self) -> int:
        return len(self.blocks)


# ── Module-level singletons ────────────────────────────────────────────────────

# None until the first upload.
_state: Optional[TransferState] = None

# NEVER replaced — upload.py and symbol.py always acquire this same object
# regardless of how many resets have happened. This is what makes the
# generation-counter double-check in symbol.py meaningful.
lock: asyncio.Lock = asyncio.Lock()


# ── Public API ─────────────────────────────────────────────────────────────────

def reset(filename: str, file_size: int, blocks: list, sha256_hash: str) -> None:
    """
    Replace the active transfer with a new one.

    Caller MUST hold `transfer_state.lock` before calling this.
    This function does NOT acquire the lock itself.

    Bumps generation so in-flight /api/symbol POSTs from the old receiver
    see a changed counter and drop their symbols cleanly.
    """
    global _state
    new_generation = (_state.generation + 1) if _state is not None else 0
    encoder = FountainEncoder(blocks, c=FOUNTAIN_C, delta=FOUNTAIN_DELTA)
    decoder = PeelingDecoder(
        k=len(blocks),
        block_size=BLOCK_SIZE,
        c=FOUNTAIN_C,
        delta=FOUNTAIN_DELTA,
    )
    _state = TransferState(
        filename=filename,
        file_size=file_size,
        blocks=blocks,
        upload_sha256=sha256_hash,   # identity — immutable after this point
        sha256_hash=sha256_hash,     # integrity — same value, separately patchable
        encoder=encoder,
        decoder=decoder,
        generation=new_generation,
    )


def reset_decoder() -> None:
    """
    Replace only the decoder with a fresh PeelingDecoder (same k/c/delta).
    Called by /api/download after a hash mismatch so the receiver can keep
    feeding symbols without requiring a re-upload.

    Caller MUST hold `transfer_state.lock` before calling this.
    This function does NOT acquire the lock itself.
    """
    global _state
    if _state is None:
        return
    _state.decoder = PeelingDecoder(
        k=_state.k,
        block_size=BLOCK_SIZE,
        c=FOUNTAIN_C,
        delta=FOUNTAIN_DELTA,
    )


def get_state() -> Optional[TransferState]:
    """Return the active TransferState, or None if no upload has happened yet."""
    return _state


def is_ready() -> bool:
    """True if a file has been uploaded and the transfer is initialised."""
    return _state is not None


def get_generation() -> int:
    """
    Return the current generation counter.
    Routes snapshot this before acquiring the lock and re-check after — if it
    changed, a re-upload happened mid-request and the symbol should be dropped.
    Returns -1 if no state exists (will never match a valid snapshot).
    """
    return _state.generation if _state is not None else -1
