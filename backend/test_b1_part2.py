import hashlib
import os
import random

from app.core.fountain import FountainEncoder
from app.core.peeling_decoder import PeelingDecoder
from app.core.chunker import chunk_data, reconstruct_data

def test_round_trip(file_size: int, block_size: int, overhead_factor: float = 3.0, verbose: bool = True):
    original = os.urandom(file_size)
    blocks, file_size_actual = chunk_data(original, block_size)
    k = len(blocks)
    
    if k == 0:
        print("Empty file test passed.")
        return

    encoder = FountainEncoder(blocks)
    decoder = PeelingDecoder(k=k, block_size=block_size)

    # Without Gaussian Elimination, we might need more symbols to decode purely by peeling.
    # Hence a higher overhead factor (e.g. 3.0).
    num_symbols = max(k + 10, int(k * overhead_factor))
    symbols = [encoder.next_symbol() for _ in range(num_symbols)]

    # Simulate a real capture: out of order, plus duplicates
    random.shuffle(symbols)
    symbols = symbols + symbols[: max(1, len(symbols) // 5)]
    random.shuffle(symbols)

    for sym in symbols:
        decoder.add_symbol(sym.seed, sym.data)
        if decoder.is_complete:
            break

    assert decoder.is_complete, (
        f"FAILED: only resolved {decoder.progress}/{k} blocks "
        f"after feeding {len(symbols)} symbols (pure peeling)."
    )

    reconstructed_blocks = decoder.get_reconstructed_blocks()
    reconstructed = reconstruct_data(reconstructed_blocks, file_size_actual)
    
    assert hashlib.sha256(reconstructed).digest() == hashlib.sha256(original).digest(), \
        "FAILED: reconstructed file does not match original (hash mismatch)"

    if verbose:
        print(
            f"OK  file_size={file_size:>7}  block_size={block_size:>4}  k={k:>4}  "
            f"symbols_used={len(symbols):>4}  -> byte-identical reconstruction (pure peeling)"
        )

if __name__ == "__main__":
    print("Running round-trip tests (pure peeling)...\n")
    test_round_trip(file_size=37, block_size=16, overhead_factor=5.0)          # k=3
    test_round_trip(file_size=500, block_size=50, overhead_factor=4.0)         # k=10
    test_round_trip(file_size=2_000, block_size=64, overhead_factor=3.0)       # k=32
    test_round_trip(file_size=10_000, block_size=400, overhead_factor=3.0)     # k=25
    print("\nAll round-trip tests passed.")
