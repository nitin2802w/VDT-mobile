def chunk_data(data: bytes, block_size: int = 400) -> tuple[list[bytes], int]:
    file_size = len(data)
    blocks = []
    if file_size == 0:
        return blocks, file_size
    for i in range(0, file_size, block_size):
        block = data[i:i + block_size]
        if len(block) < block_size:
            block = block + b'\x00' * (block_size - len(block))
        blocks.append(block)
    return blocks, file_size


def reconstruct_data(blocks: list[bytes], file_size: int) -> bytes:
    if not blocks:
        return b""
    return b"".join(blocks)[:file_size]
