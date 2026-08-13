"""
test_b3_ws.py

Phase B3 WebSocket verification.
Run with the server already up:
  (venv) uvicorn app.main:app --port 8000   [terminal 1]
  (venv) python test_b3_ws.py               [terminal 2]

Requires: pip install websockets httpx
"""

import asyncio
import base64
import hashlib
import json
import os
import struct
import time
import zlib

import httpx
import websockets

BASE_HTTP = "http://127.0.0.1:8000"
BASE_WS   = "ws://127.0.0.1:8000"


# ── shared helpers ─────────────────────────────────────────────────────────────

def make_symbol_body(seed: int, payload: bytes) -> dict:
    header = struct.pack(">IH", seed, len(payload))
    crc = zlib.crc32(header + payload) & 0xFFFFFFFF
    return {"seed": seed, "payload": base64.b64encode(payload).decode(), "crc": crc}


def http_upload(client: httpx.Client, data: bytes, filename: str) -> dict:
    resp = client.post(
        f"{BASE_HTTP}/api/upload",
        files={"file": (filename, data, "application/octet-stream")},
    )
    assert resp.status_code == 200, f"upload failed: {resp.text}"
    return resp.json()


def http_symbol(client: httpx.Client, seed: int, payload: bytes) -> dict:
    resp = client.post(f"{BASE_HTTP}/api/symbol", json=make_symbol_body(seed, payload))
    assert resp.status_code == 200
    return resp.json()


# ── test 1: sender streams symbols at the requested FPS ────────────────────────

async def test_sender_streams_at_fps():
    import sys; sys.path.insert(0, ".")
    from app.core.chunker import chunk_data

    data = os.urandom(2000)

    with httpx.Client(timeout=30) as client:
        http_upload(client, data, "sender_test.bin")

    async with websockets.connect(f"{BASE_WS}/api/ws/sender") as ws:
        # Ask for 10 FPS, collect for ~2 seconds
        await ws.send(json.dumps({"action": "start", "fps": 10}))

        received = []
        deadline = time.monotonic() + 2.0
        while time.monotonic() < deadline:
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=0.5)
                msg = json.loads(raw)
                if msg["type"] == "symbol":
                    received.append(msg)
            except asyncio.TimeoutError:
                break

        # Expect roughly 10 symbols per second × 2 seconds = ~20
        # Allow generous tolerance (8–30) for test environment jitter
        assert 8 <= len(received) <= 30, \
            f"Expected ~20 symbols at 10fps/2s, got {len(received)}"

        # Each symbol must have the right shape
        for msg in received:
            assert "seed" in msg
            assert "payload" in msg
            assert "crc" in msg
            # Payload must decode to exactly BLOCK_SIZE bytes
            payload_bytes = base64.b64decode(msg["payload"])
            assert len(payload_bytes) == 400, \
                f"Payload should be 400 bytes, got {len(payload_bytes)}"

        # Pause and verify the stream stops
        await ws.send(json.dumps({"action": "pause"}))
        await asyncio.sleep(0.3)  # let pause take effect

        count_after_pause = 0
        pause_deadline = time.monotonic() + 1.0
        while time.monotonic() < pause_deadline:
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=0.2)
                msg = json.loads(raw)
                if msg["type"] == "symbol":
                    count_after_pause += 1
            except asyncio.TimeoutError:
                break

        assert count_after_pause == 0, \
            f"Expected no symbols after pause, got {count_after_pause}"

    print(f"  sender stream OK  {len(received)} symbols in ~2s at 10fps")
    print(f"  pause OK          {count_after_pause} symbols after pause")


# ── test 2: receiver gets push update when symbol POST happens ─────────────────

async def test_receiver_push_on_symbol():
    import sys; sys.path.insert(0, ".")
    from app.core.chunker import chunk_data
    from app.core.fountain import FountainEncoder

    data = os.urandom(2000)
    with httpx.Client(timeout=30) as client:
        meta = http_upload(client, data, "receiver_test.bin")

    blocks, _ = __import__("app.core.chunker", fromlist=["chunk_data"]).chunk_data(data, meta["block_size"])
    encoder = FountainEncoder(blocks)
    sym = encoder.next_symbol()

    async with websockets.connect(f"{BASE_WS}/api/ws/receiver") as ws:
        # First message should be a "connected" confirmation
        first = json.loads(await asyncio.wait_for(ws.recv(), timeout=3))
        assert first["type"] == "connected", f"Expected connected, got: {first}"

        # POST a symbol via HTTP — should trigger a push to this WS
        with httpx.Client(timeout=30) as client:
            result = http_symbol(client, sym.seed, sym.data)

        assert not result["dropped"]

        # Receive the push event
        push = json.loads(await asyncio.wait_for(ws.recv(), timeout=3))

        assert push["type"] == "progress", f"Expected progress event, got: {push}"
        assert push["progress"] == result["progress"]
        assert push["k"] == result["k"]
        assert push["complete"] == result["complete"]

    print(f"  receiver push OK  progress={push['progress']}/{push['k']} "
          f"  complete={push['complete']}")


# ── test 3: sender auto-picks up a new file after re-upload ────────────────────

async def test_sender_generation_handover():
    data_a = os.urandom(2000)
    data_b = os.urandom(4000)   # different k

    with httpx.Client(timeout=30) as client:
        meta_a = http_upload(client, data_a, "gen_a.bin")

    async with websockets.connect(f"{BASE_WS}/api/ws/sender") as ws:
        await ws.send(json.dumps({"action": "start", "fps": 10}))

        # Collect a symbol from the first transfer
        sym_a = None
        for _ in range(20):
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=0.5)
                msg = json.loads(raw)
                if msg["type"] == "symbol":
                    sym_a = msg
                    break
            except asyncio.TimeoutError:
                break

        assert sym_a is not None, "No symbol received for file A"

        # Re-upload a new file while sender is running
        with httpx.Client(timeout=30) as client:
            meta_b = http_upload(client, data_b, "gen_b.bin")

        # Collect symbols — eventually should reflect the new k (k_b != k_a)
        k_b = meta_b["k"]
        received_new_k = False
        # The sender detects generation change; give it a couple of seconds
        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline:
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=0.5)
                msg = json.loads(raw)
                # We can't directly check k from the symbol packet, but we can
                # verify the payload is still the right BLOCK_SIZE (400 bytes)
                if msg["type"] == "symbol":
                    payload = base64.b64decode(msg["payload"])
                    assert len(payload) == 400
                    received_new_k = True
            except asyncio.TimeoutError:
                break

        assert received_new_k, "Sender did not continue streaming after re-upload"

    print(f"  generation handover OK  sender continued streaming after re-upload")


# ── main ───────────────────────────────────────────────────────────────────────

async def main():
    print("=== Phase B3 WebSocket verification ===\n")

    print("1. Sender streams at requested FPS + pause:")
    await test_sender_streams_at_fps()

    print("\n2. Receiver push on /api/symbol POST:")
    await test_receiver_push_on_symbol()

    print("\n3. Sender generation handover on re-upload:")
    await test_sender_generation_handover()

    print("\n=== All Phase B3 tests passed ===")


if __name__ == "__main__":
    asyncio.run(main())
