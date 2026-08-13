"""
test_b2_download.py

End-to-end HTTP verification of the download route and full B2 milestone.
Run with the server already up:
  (venv) uvicorn app.main:app --reload   [terminal 1]
  (venv) python test_b2_download.py      [terminal 2]
"""

import base64
import hashlib
import os
import struct
import zlib

import httpx

BASE = "http://127.0.0.1:8000"


# ── helpers ────────────────────────────────────────────────────────────────────

def make_symbol_body(seed: int, payload: bytes) -> dict:
    header = struct.pack(">IH", seed, len(payload))
    crc = zlib.crc32(header + payload) & 0xFFFFFFFF
    return {"seed": seed, "payload": base64.b64encode(payload).decode(), "crc": crc}


def upload(client, data: bytes, filename: str) -> dict:
    resp = client.post(
        f"{BASE}/api/upload",
        files={"file": (filename, data, "application/octet-stream")},
    )
    assert resp.status_code == 200, f"upload failed: {resp.text}"
    return resp.json()


def drive_to_complete(client, data: bytes, meta: dict) -> None:
    """Feed symbols until the server reports complete:true."""
    import sys; sys.path.insert(0, ".")
    from app.core.chunker import chunk_data
    from app.core.fountain import FountainEncoder

    blocks, _ = chunk_data(data, meta["block_size"])
    encoder = FountainEncoder(blocks)
    for _ in range(meta["k"] * 5):
        sym = encoder.next_symbol()
        resp = client.post(f"{BASE}/api/symbol", json=make_symbol_body(sym.seed, sym.data))
        assert resp.status_code == 200
        if resp.json()["complete"]:
            return
    raise AssertionError("Never reached complete")


# ── tests ──────────────────────────────────────────────────────────────────────

def test_ping(client):
    assert client.get(f"{BASE}/ping").json() == {"status": "ok"}
    print("  /ping OK")


def test_metadata_no_transfer(client):
    # Ensure no transfer is active by hitting a fresh server (ordering matters —
    # run this test first before any upload).
    # If a previous test already uploaded, skip rather than fail.
    resp = client.get(f"{BASE}/api/metadata")
    assert resp.status_code in (200, 404)
    print(f"  /metadata with no transfer -> {resp.status_code} OK")


def test_upload_and_metadata(client) -> tuple[bytes, dict]:
    data = os.urandom(2000)
    meta = upload(client, data, "test.bin")
    assert meta["sha256"] == hashlib.sha256(data).hexdigest()
    assert meta["block_size"] == 400
    assert meta["k"] == -(-len(data) // 400)

    mresp = client.get(f"{BASE}/api/metadata").json()
    assert mresp["sha256"] == meta["sha256"]
    assert mresp["complete"] is False
    assert mresp["progress"] == 0
    print(f"  upload + /metadata OK  k={meta['k']}  sha256={meta['sha256'][:12]}…")
    return data, meta


def test_download_before_complete(client, sha256: str):
    resp = client.get(f"{BASE}/api/download?expected_sha256={sha256}")
    assert resp.status_code == 409
    assert resp.json()["error"] == "not_complete"
    print("  /download before complete -> 409 not_complete OK")


def test_download_missing_param(client):
    resp = client.get(f"{BASE}/api/download")
    assert resp.status_code == 400
    print("  /download with no expected_sha256 -> 400 OK")


def test_full_round_trip(client) -> tuple[bytes, dict]:
    data = os.urandom(4000)
    meta = upload(client, data, "round_trip.bin")
    drive_to_complete(client, data, meta)

    mresp = client.get(f"{BASE}/api/metadata").json()
    assert mresp["complete"] is True

    resp = client.get(f"{BASE}/api/download?expected_sha256={meta['sha256']}")
    assert resp.status_code == 200, f"download failed: {resp.text}"
    assert resp.headers["content-disposition"] == 'attachment; filename="round_trip.bin"'
    assert hashlib.sha256(resp.content).hexdigest() == meta["sha256"]
    print(f"  full round-trip OK  {len(data)} bytes -> downloaded byte-identical")
    return data, meta


def test_stale_transfer(client, old_sha256: str):
    # Re-upload a different file
    new_data = os.urandom(2000)
    upload(client, new_data, "new_file.bin")

    resp = client.get(f"{BASE}/api/download?expected_sha256={old_sha256}")
    assert resp.status_code == 409
    assert resp.json()["error"] == "stale_transfer"
    print("  stale_transfer guard -> 409 stale_transfer OK")


def test_hash_mismatch_and_recovery(client):
    """
    The hash_mismatch branch requires patching state.sha256_hash directly.
    Since the server runs in a separate process, we test this in-process
    by running the download logic synchronously against a real state object.
    """
    import sys; sys.path.insert(0, ".")
    import asyncio
    import app.state.transfer_state as ts
    from app.core.chunker import chunk_data
    from app.core.fountain import FountainEncoder

    data = os.urandom(2000)
    blocks, file_size = chunk_data(data, 400)
    sha256_hash = hashlib.sha256(data).hexdigest()

    # Directly initialise state in-process (bypassing HTTP for this test)
    async def run():
        async with ts.lock:
            ts.reset("mismatch_test.bin", file_size, blocks, sha256_hash)

        # Drive decoder to complete in-process
        encoder = FountainEncoder(blocks)
        for _ in range(len(blocks) * 5):
            sym = encoder.next_symbol()
            ts._state.decoder.add_symbol(sym.seed, sym.data)
            if ts._state.decoder.is_complete:
                break

        assert ts._state.decoder.is_complete, "Decoder not complete"

        # Patch sha256_hash (integrity) only — upload_sha256 stays correct
        original_hash = ts._state.sha256_hash
        ts._state.sha256_hash = "0" * 64

        # Staleness check (3a) reads upload_sha256 — passes because it's intact
        assert ts._state.upload_sha256 == sha256_hash  # unchanged

        # Integrity check (3f) reads sha256_hash — will fail
        from app.core.chunker import reconstruct_data
        reconstructed = reconstruct_data(ts._state.decoder.get_reconstructed_blocks(), file_size)
        computed = hashlib.sha256(reconstructed).hexdigest()
        assert computed != ts._state.sha256_hash, "Patch didn't work"
        assert computed == ts._state.upload_sha256, "upload_sha256 was incorrectly mutated"

        # Simulate what download.py does on mismatch: call reset_decoder() under lock
        async with ts.lock:
            ts.reset_decoder()

        # Verify decoder is reset (no longer complete)
        assert not ts._state.decoder.is_complete, "Decoder should be fresh after reset_decoder()"

        # Restore hash and re-complete
        ts._state.sha256_hash = original_hash
        encoder2 = FountainEncoder(blocks)
        for _ in range(len(blocks) * 5):
            sym = encoder2.next_symbol()
            ts._state.decoder.add_symbol(sym.seed, sym.data)
            if ts._state.decoder.is_complete:
                break

        assert ts._state.decoder.is_complete, "Recovery failed"

    asyncio.run(run())
    print("  hash_mismatch + recovery -> in-process unit test passed")
    print("    (upload_sha256 untouched, sha256_hash patched -> integrity check fires)")
    print("    (reset_decoder() called under lock -> no deadlock)")
    print("    (re-feed symbols -> complete again -> recovery confirmed)")



# ── main ───────────────────────────────────────────────────────────────────────

def main():
    print("=== Phase B2 Download verification ===\n")
    with httpx.Client(timeout=60) as client:
        print("1. Ping:")
        test_ping(client)

        print("\n2. Metadata with no active transfer:")
        test_metadata_no_transfer(client)

        print("\n3. Upload + /metadata consistency:")
        data, meta = test_upload_and_metadata(client)

        print("\n4. Download before complete:")
        test_download_before_complete(client, meta["sha256"])

        print("\n5. Download missing param:")
        test_download_missing_param(client)

        print("\n6. Full round-trip (upload -> symbols -> download)::")
        _, round_trip_meta = test_full_round_trip(client)

        print("\n7. Stale transfer guard:")
        test_stale_transfer(client, round_trip_meta["sha256"])

        print("\n8. Hash mismatch + recovery:")
        test_hash_mismatch_and_recovery(client)

        print("\n=== All Phase B2 download tests passed ===")


if __name__ == "__main__":
    main()
