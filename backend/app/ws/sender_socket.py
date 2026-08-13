"""
backend/app/ws/sender_socket.py

WS /api/ws/sender

The Send page connects here after a successful upload. The server streams
fountain-coded symbols continuously at the client's requested FPS.

Client → Server messages (JSON):
  {"action": "start", "fps": 15}   — begin/resume streaming at the given rate
  {"action": "pause"}              — stop sending until the next "start"
  {"action": "stop"}               — server closes the connection

Server → Client messages (JSON):
  {"type": "symbol",   "seed": int, "payload": "<base64>", "crc": int}
  {"type": "waiting",  "reason": "no_transfer"}   — no file uploaded yet
  {"type": "error",    "detail": str}

Architecture:
  Two concurrent tasks share a single asyncio.Event and float for fps:
    _reader  — awaits messages from the client and updates shared state
    _streamer— generates and sends symbols, sleeping to hit the target fps

  Using separate tasks (via asyncio.gather) is the correct pattern for
  bidirectional WebSocket control: we never want a slow client send to
  block reading the next control message.

Locking note:
  encoder.next_symbol() is called WITHOUT holding transfer_state.lock.
  The encoder reads self.blocks and its PRNG state only — it never writes
  to any shared data. The lock is only needed for mutations (reset/reset_decoder).
"""

import asyncio
import base64
import json
import logging
import struct
import zlib

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

import app.state.transfer_state as ts

router = APIRouter()
logger = logging.getLogger(__name__)

_MIN_FPS: float = 1.0
_MAX_FPS: float = 30.0
_DEFAULT_FPS: float = 10.0


def _pack_symbol(seed: int, payload: bytes):
    """Return (seed, payload_b64, crc) matching packet.py's binary layout."""
    header = struct.pack(">IH", seed, len(payload))
    crc = zlib.crc32(header + payload) & 0xFFFFFFFF
    return seed, base64.b64encode(payload).decode(), crc


@router.websocket("/sender")
async def sender_socket(websocket: WebSocket):
    await websocket.accept()
    logger.info("Sender WebSocket connected")

    # Shared state between the two tasks
    playing = asyncio.Event()         # set = playing, clear = paused
    stop    = asyncio.Event()         # set = tear down
    fps_box = [_DEFAULT_FPS]          # list so both tasks share the same ref

    async def _reader():
        """Read control messages from the client and update shared state."""
        try:
            while not stop.is_set():
                raw = await websocket.receive_text()
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    await websocket.send_text(json.dumps({
                        "type": "error", "detail": "Invalid JSON."
                    }))
                    continue

                action = msg.get("action")
                if action == "start":
                    raw_fps = float(msg.get("fps", _DEFAULT_FPS))
                    fps_box[0] = max(_MIN_FPS, min(_MAX_FPS, raw_fps))
                    playing.set()
                    logger.info(f"Sender: start at {fps_box[0]} fps")
                elif action == "pause":
                    playing.clear()
                    logger.info("Sender: paused")
                elif action == "stop":
                    stop.set()
                    logger.info("Sender: stop")
                    break
        except WebSocketDisconnect:
            stop.set()
        except Exception as e:
            logger.exception(f"Sender reader error: {e}")
            stop.set()

    async def _streamer():
        """Push symbols to the client at fps_box[0] while playing is set."""
        current_generation = -1
        encoder = None

        try:
            while not stop.is_set():
                # If paused, spin with short sleeps until playing or stopped
                if not playing.is_set():
                    await asyncio.sleep(0.05)
                    continue

                if stop.is_set():
                    break

                state = ts.get_state()
                if state is None:
                    await websocket.send_text(json.dumps({
                        "type": "waiting", "reason": "no_transfer"
                    }))
                    await asyncio.sleep(1.0)
                    continue

                # Refresh encoder on re-upload (generation counter changed)
                if state.generation != current_generation:
                    current_generation = state.generation
                    encoder = state.encoder
                    logger.info(
                        f"Sender: new transfer gen={current_generation}, k={state.k}"
                    )

                sym = encoder.next_symbol()
                seed, payload_b64, crc = _pack_symbol(sym.seed, sym.data)

                await websocket.send_text(json.dumps({
                    "type": "symbol",
                    "seed": seed,
                    "payload": payload_b64,
                    "crc": crc,
                }))

                await asyncio.sleep(1.0 / fps_box[0])

        except WebSocketDisconnect:
            stop.set()
        except Exception as e:
            logger.exception(f"Sender streamer error: {e}")
            try:
                await websocket.send_text(json.dumps({
                    "type": "error", "detail": str(e)
                }))
            except Exception:
                pass
            stop.set()

    # Run both tasks concurrently; cancel the other when either finishes
    reader_task   = asyncio.create_task(_reader())
    streamer_task = asyncio.create_task(_streamer())
    try:
        done, pending = await asyncio.wait(
            {reader_task, streamer_task},
            return_when=asyncio.FIRST_COMPLETED,
        )
        for task in pending:
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass
    finally:
        logger.info("Sender WebSocket closed")
