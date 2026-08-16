/**
 * chunker.js
 *
 * Splits a file's raw bytes into fixed-size blocks for Fountain encoding,
 * and reassembles them afterward.
 *
 * Port of backend/app/core/chunker.py — but note that chunker.py was only
 * ever *planned*, never stress-tested. Treat this with the same rigour as
 * new code, not as a quick transliteration check.
 *
 * IMPORTANT — why .slice() and never .subarray():
 *   .subarray() returns a *view* into the shared source buffer. Block N's
 *   byteOffset into that buffer is N * blockSize. If blockSize is ever not a
 *   multiple of 4 (e.g. 250), casting such a view to Uint32Array in
 *   fountain.js throws RangeError: start offset must be a multiple of 4.
 *   .slice() returns a *copy* with byteOffset always 0, eliminating this
 *   entire failure class regardless of blockSize. Never change .slice() to
 *   .subarray() here without understanding this constraint.
 */

/**
 * chunkFile(bytes, blockSize) → { blocks, k, fileSize }
 *
 * @param {Uint8Array} bytes     - Raw file bytes.
 * @param {number}     blockSize - Block size in bytes (default 400).
 * @returns {{ blocks: Uint8Array[], k: number, fileSize: number }}
 */
export function chunkFile(bytes, blockSize = 400) {
  const fileSize = bytes.length
  if (fileSize === 0) return { blocks: [], k: 0, fileSize: 0 }

  const blocks = []
  for (let i = 0; i < fileSize; i += blockSize) {
    // .slice() creates an independent copy — byteOffset is always 0.
    // This is safe to cast to Uint32Array regardless of blockSize. See note above.
    const raw = bytes.slice(i, i + blockSize)

    if (raw.length < blockSize) {
      // Last block: zero-pad to blockSize so all blocks are uniform length.
      const padded = new Uint8Array(blockSize)
      padded.set(raw)
      blocks.push(padded)
    } else {
      blocks.push(raw)
    }
  }

  return { blocks, k: blocks.length, fileSize }
}

/**
 * reconstruct(blocks, fileSize) → Uint8Array
 *
 * Concatenates decoded blocks and trims the zero-padding from the last block.
 *
 * @param {Uint8Array[]} blocks   - Ordered array of reconstructed blocks.
 * @param {number}       fileSize - Original unpadded file size in bytes.
 * @returns {Uint8Array}
 */
export function reconstruct(blocks, fileSize) {
  if (!blocks || blocks.length === 0) return new Uint8Array(0)

  const blockSize = blocks[0].length
  const out = new Uint8Array(blocks.length * blockSize)
  for (let i = 0; i < blocks.length; i++) {
    out.set(blocks[i], i * blockSize)
  }

  // Trim padding back to original file size.
  return out.slice(0, fileSize)
}
