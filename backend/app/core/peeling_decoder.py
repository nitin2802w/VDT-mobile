from collections import deque
from dataclasses import dataclass
from typing import Dict, List, Set

from app.core.fountain import degree_and_block_indices, robust_soliton_probabilities, xor_bytes


@dataclass
class PendingSymbol:
    unknown_indices: Set[int]
    data: bytes


class PeelingDecoder:
    def __init__(self, k: int, block_size: int, c: float = 0.03, delta: float = 0.05):
        self.k = k
        self.block_size = block_size
        self.probs = robust_soliton_probabilities(k, c=c, delta=delta)
        self.known_blocks: Dict[int, bytes] = {}
        self.pending: List[PendingSymbol] = []
        self.seen_seeds: Set[int] = set()

    @property
    def progress(self) -> int:
        return len(self.known_blocks)

    @property
    def is_complete(self) -> bool:
        return len(self.known_blocks) == self.k

    def add_symbol(self, seed: int, data: bytes) -> bool:
        if seed in self.seen_seeds:
            return False
        self.seen_seeds.add(seed)
        if self.is_complete:
            return True

        _, block_indices = degree_and_block_indices(seed, self.k, self.probs)
        unknown = set(block_indices)
        reduced = data
        for idx in block_indices:
            if idx in self.known_blocks:
                reduced = xor_bytes([reduced, self.known_blocks[idx]])
                unknown.discard(idx)

        if not unknown:
            return True
        if len(unknown) == 1:
            self._resolve(next(iter(unknown)), reduced)
        else:
            self.pending.append(PendingSymbol(unknown_indices=unknown, data=reduced))
        return True

    def _resolve(self, idx: int, data: bytes) -> None:
        if idx in self.known_blocks:
            return
        self.known_blocks[idx] = data
        queue = deque([idx])
        while queue:
            known_idx = queue.popleft()
            known_data = self.known_blocks[known_idx]
            still_pending: List[PendingSymbol] = []
            for sym in self.pending:
                if known_idx in sym.unknown_indices:
                    sym.data = xor_bytes([sym.data, known_data])
                    sym.unknown_indices = sym.unknown_indices - {known_idx}
                if len(sym.unknown_indices) == 0:
                    continue
                elif len(sym.unknown_indices) == 1:
                    new_idx = next(iter(sym.unknown_indices))
                    if new_idx not in self.known_blocks:
                        self.known_blocks[new_idx] = sym.data
                        queue.append(new_idx)
                else:
                    still_pending.append(sym)
            self.pending = still_pending

    def get_reconstructed_blocks(self) -> List[bytes]:
        if not self.is_complete:
            raise RuntimeError(f"Cannot reconstruct yet: only {self.progress}/{self.k} blocks known")
        return [self.known_blocks[i] for i in range(self.k)]
