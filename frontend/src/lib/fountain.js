/**
 * fountain.js
 *
 * JavaScript port of backend/app/core/fountain.py.
 *
 * Implements the Robust Soliton degree distribution, seeded block index
 * selection, fast XOR via Uint32Array, and the FountainEncoder class.
 *
 * degreeAndBlockIndices() is also exported so peelingDecoder.js can import
 * it directly — single source of truth for the block selection math, exactly
 * mirroring the Python pair's import relationship.
 *
 * JS has no equivalents of random.choices(weights=...) or random.sample().
 * Both are hand-rolled here and unit-tested via roundtrip_test.js.
 */

import { createRng } from './prng.js'

// ── Robust Soliton Distribution ───────────────────────────────────────────────

/**
 * robustSolitonProbabilities(k, c, delta) → number[]
 *
 * Mirrors robust_soliton_probabilities() in fountain.py exactly.
 * Returns a normalized probability array of length k, where index i
 * (0-based) represents the probability of degree i+1.
 *
 * @param {number} k     - Total number of source blocks.
 * @param {number} c     - Robust Soliton c parameter (default 0.03).
 * @param {number} delta - Robust Soliton delta parameter (default 0.05).
 * @returns {number[]}
 */
export function robustSolitonProbabilities(k, c = 0.03, delta = 0.05) {
  if (k <= 0) throw new Error('k must be a positive integer')
  if (k === 1) return [1.0]

  // Ideal Soliton (rho), 1-indexed internally, sliced to 0-indexed output.
  const rho = new Array(k + 1).fill(0.0)
  rho[1] = 1.0 / k
  for (let d = 2; d <= k; d++) {
    rho[d] = 1.0 / (d * (d - 1))
  }

  const R = Math.max(c * Math.log(k / delta) * Math.sqrt(k), 1.0)
  const spike = Math.min(Math.max(1, Math.round(k / R)), k)

  // Correction term (tau), same indexing.
  const tau = new Array(k + 1).fill(0.0)
  for (let d = 1; d < spike; d++) {
    tau[d] = R / (k * d)
  }
  tau[spike] = (R * Math.log(R / delta)) / k

  // Combine and normalise.
  const combined = []
  for (let d = 1; d <= k; d++) {
    combined.push(rho[d] + tau[d])
  }
  const total = combined.reduce((s, v) => s + v, 0)
  return combined.map(v => v / total)
}

// ── Weighted degree selection (mirrors random.choices with weights) ───────────

/**
 * @param {() => number} rng   - A seeded RNG function from prng.js.
 * @param {number[]}     probs - Normalized probability array (sums to ~1).
 * @returns {number} Degree in [1, k].
 */
function weightedDegree(rng, probs) {
  const r = rng()
  let cumulative = 0.0
  for (let i = 0; i < probs.length; i++) {
    cumulative += probs[i]
    if (r < cumulative) return i + 1  // degree is 1-indexed
  }
  return probs.length  // fallback for floating-point rounding at the tail
}

// ── Distinct block index selection (mirrors random.sample) ───────────────────

/**
 * Partial Fisher-Yates shuffle to pick `degree` distinct indices from [0, k).
 * This is the JS equivalent of random.sample(range(k), degree).
 *
 * @param {() => number} rng    - A seeded RNG function from prng.js.
 * @param {number}       k      - Total block count.
 * @param {number}       degree - How many distinct indices to pick.
 * @returns {number[]} Sorted array of `degree` distinct indices.
 */
function sampleIndices(rng, k, degree) {
  // Build a virtual array [0, 1, ..., k-1] and partially shuffle it.
  const pool = Array.from({ length: k }, (_, i) => i)
  for (let i = 0; i < degree; i++) {
    const j = i + Math.floor(rng() * (k - i))
    ;[pool[i], pool[j]] = [pool[j], pool[i]]
  }
  return pool.slice(0, degree).sort((a, b) => a - b)
}

// ── Core: degree and indices from a seed ─────────────────────────────────────

/**
 * degreeAndBlockIndices(seed, k, probs) → { degree, blockIndices }
 *
 * Exported so PeelingDecoder can import and use the exact same logic,
 * mirroring the single-source-of-truth relationship in the Python pair.
 *
 * @param {number}   seed        - Symbol seed (uint32).
 * @param {number}   k           - Total block count.
 * @param {number[]} probs       - Probability array from robustSolitonProbabilities().
 * @returns {{ degree: number, blockIndices: number[] }}
 */
export function degreeAndBlockIndices(seed, k, probs) {
  const rng = createRng(seed)
  const degree = weightedDegree(rng, probs)
  const blockIndices = sampleIndices(rng, k, degree)
  return { degree, blockIndices }
}

// ── XOR ───────────────────────────────────────────────────────────────────────

/**
 * xorBytes(blocks) → Uint8Array
 *
 * XORs an array of same-length Uint8Array blocks together.
 *
 * Uses Uint32Array views for 4-byte-at-a-time throughput (same trick as
 * Python's int.from_bytes big-integer XOR). Safe because chunker.js
 * guarantees every block is an independent .slice() copy with byteOffset=0.
 * The remainder loop handles any block sizes not divisible by 4.
 *
 * @param {Uint8Array[]} blocks - All must be the same length.
 * @returns {Uint8Array}
 */
export function xorBytes(blocks) {
  if (!blocks || blocks.length === 0) return new Uint8Array(0)

  const len = blocks[0].length
  // Output is a fresh copy of blocks[0] — we XOR in-place from blocks[1] onward.
  const result = blocks[0].slice()

  const u32len = Math.floor(len / 4)
  const rem = len % 4

  const resultU32 = new Uint32Array(result.buffer, 0, u32len)

  for (let b = 1; b < blocks.length; b++) {
    if (blocks[b].length !== len) {
      throw new Error('xorBytes: all blocks must be the same length')
    }
    const srcU32 = new Uint32Array(blocks[b].buffer, blocks[b].byteOffset, u32len)
    for (let i = 0; i < u32len; i++) {
      resultU32[i] ^= srcU32[i]
    }
    // Remainder bytes (for block sizes not divisible by 4).
    const base = u32len * 4
    for (let i = 0; i < rem; i++) {
      result[base + i] ^= blocks[b][base + i]
    }
  }

  return result
}

// ── FountainEncoder ───────────────────────────────────────────────────────────

/**
 * FountainEncoder
 *
 * Port of fountain.py's FountainEncoder class.
 * Generates an infinite, non-repeating stream of fountain symbols.
 *
 * Usage:
 *   const encoder = new FountainEncoder(blocks, 0.03, 0.05)
 *   const { seed, payload, degree, blockIndices } = encoder.nextSymbol()
 */
export class FountainEncoder {
  /**
   * @param {Uint8Array[]} blocks - Source blocks from chunker.js.
   * @param {number}       c      - Robust Soliton c (default 0.03).
   * @param {number}       delta  - Robust Soliton delta (default 0.05).
   */
  constructor(blocks, c = 0.03, delta = 0.05) {
    if (!blocks || blocks.length === 0) throw new Error('blocks must be non-empty')
    this.blocks = blocks
    this.k = blocks.length
    this.probs = robustSolitonProbabilities(this.k, c, delta)
    this._nextSeed = 0
  }

  /**
   * nextSymbol() → { seed, payload, degree, blockIndices }
   *
   * Generates the next fountain symbol. The seed auto-increments, so
   * calling nextSymbol() in a loop produces an infinite non-repeating stream.
   *
   * @returns {{ seed: number, payload: Uint8Array, degree: number, blockIndices: number[] }}
   */
  nextSymbol() {
    const seed = this._nextSeed++
    const { degree, blockIndices } = degreeAndBlockIndices(seed, this.k, this.probs)
    const payload = xorBytes(blockIndices.map(i => this.blocks[i]))
    return { seed, payload, degree, blockIndices }
  }
}
