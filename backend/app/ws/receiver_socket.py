"""
backend/app/ws/receiver_socket.py

WS /api/ws/receiver

The Receive page connects here. The server pushes a progress event whenever
routes/symbol.py successfully processes a decoded symbol — so the UI updates
in real time without polling.

Server → Client messages (JSON):
  {"type": "progress", "progress": int, "k": int, "complete": bool}
  {"type": "connected"}

Architecture: module-level ReceiverConnectionManager singleton.
  symbol.py imports `manager` and calls manager.broadcast(...) after every
  successful decoder update. This means a single decoded symbol results in:
    1. The /api/symbol HTTP response (for the receiver's logic)
    2. An instant push to every connected Receive page WebSocket

Concurrency:
  broadcast() is async and runs in the same event loop as all FastAPI handlers.
  WebSocket sends are I/O-bound, so broadcasting to N connected clients is
  fine without threading — it's just N awaited coroutines.
  
  If a send fails (client disconnected mid-broadcast), we catch and remove
  that client silently rather than letting one bad client break the others.
"""

import asyncio
import json
import logging
from typing import Set

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

router = APIRouter()
logger = logging.getLogger(__name__)


class ReceiverConnectionManager:
    """Tracks all active Receive-page WebSocket connections."""

    def __init__(self):
        self._connections: Set[WebSocket] = set()
        self._lock = asyncio.Lock()

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        async with self._lock:
            self._connections.add(websocket)
        logger.info(
            f"Receiver connected — total={len(self._connections)}"
        )

    async def disconnect(self, websocket: WebSocket) -> None:
        async with self._lock:
            self._connections.discard(websocket)
        logger.info(
            f"Receiver disconnected — total={len(self._connections)}"
        )

    async def broadcast(self, progress: int, k: int, complete: bool) -> None:
        """
        Push a progress event to every connected Receive-page client.
        Removes any client whose send fails (disconnected mid-broadcast).
        Caller does NOT need to hold transfer_state.lock — this is a
        read-only broadcast of already-computed values.
        """
        if not self._connections:
            return

        message = json.dumps({
            "type": "progress",
            "progress": progress,
            "k": k,
            "complete": complete,
        })

        dead: Set[WebSocket] = set()
        async with self._lock:
            for ws in self._connections:
                try:
                    await ws.send_text(message)
                except Exception:
                    dead.add(ws)
            self._connections -= dead

        if dead:
            logger.info(f"Removed {len(dead)} dead receiver connection(s)")


# Module-level singleton — imported by routes/symbol.py
manager = ReceiverConnectionManager()


@router.websocket("/receiver")
async def receiver_socket(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        # Immediately confirm connection so the frontend knows it's live
        await websocket.send_text(json.dumps({"type": "connected"}))

        # Keep the connection alive. We don't expect data from the client,
        # but we do need to detect a disconnect.
        while True:
            # receive_text() blocks until a message arrives or the client disconnects.
            # Clients may send a heartbeat ping — we just discard it.
            await websocket.receive_text()

    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.exception(f"Receiver WebSocket error: {e}")
    finally:
        await manager.disconnect(websocket)
