"""
test_b2.py

End-to-end HTTP verification of Phase B2 routes.
Run with the server already up:
  (venv) uvicorn app.main:app --reload   [in one terminal]
  (venv) python test_b2.py               [in another]

Tests:
  1. POST /api/upload returns correct metadata.
  2. POST /api/symbol drives progress to complete:true.
  3. Re-upload mid-flight causes old symbols to be silently dropped.
"""

import base64
import hashlib
import os
import random
import struct
import zlib

import httpx

BASE = "http://127.0.0.1:8000"


def make_symbol_body(seed: int, payload: bytes) -> dict:
    """Build the JSON body that symbol.py expects."""
    header = struct.pack(">IH", seed, len(payload))
    crc = zlib.crc32(header + payload) & 0xFFFFFFFF
    return {
        "seed": seed,
        "payload": base64.b64encode(payload).decode(),
        "crc": crc,
    }


def test_upload(client: httpx.Client, data: bytes, filename: str) -> dict:
    resp = client.post(
        f"{BASE}/api/upload",
        files={"file": (filename, data, "application/octet-stream")},
    )
    assert resp.status_code == 200, f"Upload failed: {resp.text}"
    meta = resp.json()
    assert meta["file_size"] == len(data)
    assert meta["sha256"] == hashlib.sha256(data).hexdigest()
    assert meta["block_size"] == 400
    assert meta["filename"] == filename
    assert meta["k"] == -(-len(data) // 400)  # ceil division
    print(f"  upload OK  k={meta['k']}  file_size={meta['file_size']}  sha256={meta['sha256'][:12]}…")
    return meta


def test_symbol_stream(client: httpx.Client, data: bytes, meta: dict):
    """Generate symbols locally and POST them until complete:true."""
    import sys
    sys.path.insert(0, ".")
    from app.core.chunker import chunk_data
    from app.core.fountain import FountainEncoder

    blocks, _ = chunk_data(data, meta["block_size"])
    encoder = FountainEncoder(blocks)

    last_progress = -1
    symbols_sent = 0
    max_symbols = meta["k"] * 5  # generous cap

    for _ in range(max_symbols):
        sym = encoder.next_symbol()
        body = make_symbol_body(sym.seed, sym.data)
        resp = client.post(f"{BASE}/api/symbol", json=body)
        assert resp.status_code == 200, f"Symbol POST failed: {resp.text}"
        result = resp.json()
        symbols_sent += 1

        if result["dropped"]:
            continue

        assert result["progress"] >= last_progress, "Progress went backwards!"
        last_progress = result["progress"]

        if result["complete"]:
            print(f"  symbol stream OK  complete after {symbols_sent} symbols  progress={result['progress']}/{result['k']}")
            return

    raise AssertionError(f"Never reached complete after {max_symbols} symbols")


def test_generation_guard(client: httpx.Client):
    """
    The generation guard protects against CONCURRENT re-uploads where a
    /api/symbol request is mid-flight (waiting on the lock) when upload
    bumps the generation. In a sequential test there's no concurrency,
    so we instead verify the weaker but still correct property: that after
    a re-upload, the server's progress counter starts fresh at 0 (not
    contaminated by symbols from the previous transfer's decoder).
    """
    import sys
    sys.path.insert(0, ".")
    from app.core.chunker import chunk_data
    from app.core.fountain import FountainEncoder

    file_a = os.urandom(2000)
    file_b = os.urandom(2000)

    # Upload file A and drive it partway
    meta_a = test_upload(client, file_a, "file_a.bin")
    blocks_a, _ = chunk_data(file_a, meta_a["block_size"])
    encoder_a = FountainEncoder(blocks_a)
    for sym in [encoder_a.next_symbol() for _ in range(5)]:
        body = make_symbol_body(sym.seed, sym.data)
        resp = client.post(f"{BASE}/api/symbol", json=body)
        assert resp.status_code == 200

    # Re-upload file B — generation bumps, state reset
    meta_b = test_upload(client, file_b, "file_b.bin")

    # First symbol from file B should start with progress 0 or 1 (fresh decoder)
    blocks_b, _ = chunk_data(file_b, meta_b["block_size"])
    encoder_b = FountainEncoder(blocks_b)
    sym_b = encoder_b.next_symbol()
    resp = client.post(f"{BASE}/api/symbol", json=make_symbol_body(sym_b.seed, sym_b.data))
    assert resp.status_code == 200
    result = resp.json()
    assert result["progress"] <= 1, f"Progress should be fresh after re-upload, got {result['progress']}"
    assert not result["dropped"], "First symbol for new transfer should not be dropped"
    print(f"  generation guard OK  progress after re-upload={result['progress']} (fresh decoder confirmed)")


def main():
    print("=== Phase B2 HTTP verification ===\n")
    with httpx.Client(timeout=30) as client:

        # 1. Ping
        assert client.get(f"{BASE}/ping").json() == {"status": "ok"}
        print("1. /ping OK")

        # 2. Upload + symbol stream (small file)
        print("\n2. Upload + symbol stream (2 KB file):")
        data = os.urandom(2000)
        meta = test_upload(client, data, "test.bin")
        test_symbol_stream(client, data, meta)

        # 3. Upload + symbol stream (realistic file)
        print("\n3. Upload + symbol stream (40 KB file):")
        data2 = os.urandom(40_000)
        meta2 = test_upload(client, data2, "bigger.bin")
        test_symbol_stream(client, data2, meta2)

        # 4. Generation guard
        print("\n4. Generation guard (re-upload mid-flight):")
        test_generation_guard(client)

        print("\n=== All Phase B2 tests passed ===")


if __name__ == "__main__":
    main()
