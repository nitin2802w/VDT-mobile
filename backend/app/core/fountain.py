import math
import random
from dataclasses import dataclass
from typing import List, Optional, Tuple


@dataclass
class Symbol:
    seed: int
    degree: int
    block_indices: List[int]
    data: bytes


def robust_soliton_probabilities(k: int, c: float = 0.03, delta: float = 0.05) -> List[float]:
    if k <= 0:
        raise ValueError("k must be a positive integer")
    if k == 1:
        return [1.0]

    rho = [0.0] * (k + 1)
    rho[1] = 1.0 / k
    for d in range(2, k + 1):
        rho[d] = 1.0 / (d * (d - 1))

    R = c * math.log(k / delta) * math.sqrt(k)
    R = max(R, 1.0)
    spike = min(max(1, round(k / R)), k)

    tau = [0.0] * (k + 1)
    for d in range(1, spike):
        tau[d] = R / (k * d)
    tau[spike] = R * math.log(R / delta) / k

    combined = [rho[d] + tau[d] for d in range(1, k + 1)]
    total = sum(combined)
    return [v / total for v in combined]


def degree_and_block_indices(seed: int, k: int, probs: Optional[List[float]] = None) -> Tuple[int, List[int]]:
    if probs is None:
        probs = robust_soliton_probabilities(k)
    rng = random.Random(seed)
    degree = rng.choices(range(1, k + 1), weights=probs, k=1)[0]
    block_indices = sorted(rng.sample(range(k), degree))
    return degree, block_indices


def xor_bytes(chunks: List[bytes]) -> bytes:
    if not chunks:
        return b""
    length = len(chunks[0])
    result = int.from_bytes(chunks[0], "big")
    for c in chunks[1:]:
        if len(c) != length:
            raise ValueError("All byte strings being XORed must be the same length")
        result ^= int.from_bytes(c, "big")
    return result.to_bytes(length, "big")


def generate_symbol(blocks: List[bytes], seed: int, probs: Optional[List[float]] = None) -> Symbol:
    k = len(blocks)
    degree, block_indices = degree_and_block_indices(seed, k, probs)
    payload = xor_bytes([blocks[i] for i in block_indices])
    return Symbol(seed=seed, degree=degree, block_indices=block_indices, data=payload)


class FountainEncoder:
    def __init__(self, blocks: List[bytes], c: float = 0.03, delta: float = 0.05):
        if not blocks:
            raise ValueError("blocks must be non-empty")
        block_len = len(blocks[0])
        if any(len(b) != block_len for b in blocks):
            raise ValueError("all blocks must be the same length")
        self.blocks = blocks
        self.k = len(blocks)
        self.block_size = block_len
        self.probs = robust_soliton_probabilities(self.k, c=c, delta=delta)
        self._next_seed = 0

    def next_symbol(self) -> Symbol:
        symbol = generate_symbol(self.blocks, self._next_seed, self.probs)
        self._next_seed += 1
        return symbol
