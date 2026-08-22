/**
 * peelingDecoder.js
 *
 * JavaScript port of backend/app/core/peeling_decoder.py.
 *
 * Implements belief-propagation graph peeling to reconstruct a file from
 * a random, unordered, lossy stream of fountain symbols.
 *
 * Imports degreeAndBlockIndices from fountain.js — the same single source of
 * truth used by FountainEncoder. This is the critical link that makes the
 * decoder and encoder agree on which blocks each seed represents.
 */

import { degreeAndBlockIndices, robustSolitonProbabilities, xorBytes } from './fountain.js'

// ── Internal type: a symbol that's still awaiting resolution ──────────────────
//
// unknownIndices: Set<number> — block indices not yet resolved
// data:           Uint8Array  — XOR residue after known blocks are stripped out

// ── PeelingDecoder ────────────────────────────────────────────────────────────

/**
 * PeelingDecoder
 *
 * Port of peeling_decoder.py's PeelingDecoder class.
 *
 * Usage:
 *   const decoder = new PeelingDecoder(k, blockSize, 0.03, 0.05)
 *   decoder.addSymbol(seed, payload)  // call for each scanned QR frame
 *   decoder.isComplete                // true when all k blocks recovered
 *   decoder.getReconstructedBlocks()  // returns ordered Uint8Array[]
 */
export class PeelingDecoder {
  /**
   * @param {number} k         - Total number of source blocks (from metadata frame).
   * @param {number} blockSize - Size of each block in bytes (from metadata frame).
   * @param {number} c         - Robust Soliton c (default 0.03).
   * @param {number} delta     - Robust Soliton delta (default 0.05).
   */
  constructor(k, blockSize, c = 0.03, delta = 0.05) {
    this.k = k
    this.blockSize = blockSize
    this.probs = robustSolitonProbabilities(k, c, delta)

    /** @type {Map<number, Uint8Array>} index → reconstructed block bytes */
    this.knownBlocks = new Map()

    /** @type {Array<{ unknownIndices: Set<number>, data: Uint8Array }>} */
    this.pending = []

    /** @type {Set<number>} seeds already processed — deduplication */
    this.seenSeeds = new Set()
  }

  /** Number of blocks resolved so far. */
  get progress() {
    return this.knownBlocks.size
  }

  /** True once all k blocks have been recovered. */
  get isComplete() {
    return this.knownBlocks.size === this.k
  }

  /**
   * addSymbol(seed, data) → boolean
   *
   * Ingests one decoded QR payload. Returns false if the seed was a duplicate
   * (already seen), true otherwise.
   *
   * @param {number}     seed - Symbol seed from the packet header.
   * @param {Uint8Array} data - XOR payload bytes from the QR frame.
   * @returns {boolean}
   */
  addSymbol(seed, data) {
    if (this.seenSeeds.has(seed)) return false
    this.seenSeeds.add(seed)
    if (this.isComplete) return true

    const { blockIndices } = degreeAndBlockIndices(seed, this.k, this.probs)
    const unknownIndices = new Set(blockIndices)
    let reduced = data.slice()  // work on a copy; never mutate the caller's buffer

    // Strip out any blocks we already know.
    for (const idx of blockIndices) {
      if (this.knownBlocks.has(idx)) {
        reduced = xorBytes([reduced, this.knownBlocks.get(idx)])
        unknownIndices.delete(idx)
      }
    }

    if (unknownIndices.size === 0) {
      // All blocks in this symbol were already known — nothing new.
      return true
    }

    if (unknownIndices.size === 1) {
      // Degree-1: we can immediately resolve this block.
      this._resolve(next(unknownIndices), reduced)
    } else {
      // Still ambiguous — buffer for later.
      this.pending.push({ unknownIndices, data: reduced })
    }

    return true
  }

  /**
   * _resolve(idx, data) → void
   *
   * Records a newly discovered block and cascades: XORs it out of every
   * pending symbol that referenced it, potentially triggering further
   * resolutions in a BFS queue (the "peeling cascade").
   *
   * @param {number}     idx  - Block index being resolved.
   * @param {Uint8Array} data - The block's actual byte content.
   */
  _resolve(idx, data) {
    if (this.knownBlocks.has(idx)) return
    this.knownBlocks.set(idx, data)

    // BFS queue of newly resolved block indices to cascade through pending.
    const queue = [idx]

    while (queue.length > 0) {
      const knownIdx = queue.shift()
      const knownData = this.knownBlocks.get(knownIdx)
      const stillPending = []

      for (const sym of this.pending) {
        if (sym.unknownIndices.has(knownIdx)) {
          sym.data = xorBytes([sym.data, knownData])
          sym.unknownIndices.delete(knownIdx)
        }

        if (sym.unknownIndices.size === 0) {
          // All blocks resolved — symbol fully consumed.
          continue
        } else if (sym.unknownIndices.size === 1) {
          // Cascade: this symbol just became degree-1.
          const newIdx = next(sym.unknownIndices)
          if (!this.knownBlocks.has(newIdx)) {
            this.knownBlocks.set(newIdx, sym.data)
            queue.push(newIdx)
          }
        } else {
          stillPending.push(sym)
        }
      }

      this.pending = stillPending
    }
  }

  /**
   * getReconstructedBlocks() → Uint8Array[]
   *
   * Returns the ordered array of reconstructed blocks once isComplete is true.
   * Pass the result directly to chunker.js reconstruct().
   *
   * @throws {Error} If called before isComplete.
   * @returns {Uint8Array[]}
   */
  getReconstructedBlocks() {
    if (!this.isComplete) {
      throw new Error(
        `Cannot reconstruct yet: only ${this.progress}/${this.k} blocks known`
      )
    }
    return Array.from({ length: this.k }, (_, i) => this.knownBlocks.get(i))
  }
}

// ── Internal helper ───────────────────────────────────────────────────────────

/** Returns the single element of a size-1 Set. */
function next(set) {
  return set.values().next().value
}
