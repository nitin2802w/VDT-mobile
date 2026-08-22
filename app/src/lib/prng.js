/**
 * prng.js
 *
 * Mulberry32 — a fast, deterministic, 32-bit seedable pseudo-random number
 * generator. JavaScript has no built-in seedable RNG (Math.random() cannot
 * be seeded), so this is the foundation everything else in the Fountain
 * Code stack depends on.
 *
 * Both FountainEncoder and PeelingDecoder import createRng from here.
 * As long as they seed it with the same symbol_seed, they will produce
 * the exact same sequence of numbers — which is what makes the block
 * indices deterministic without needing any out-of-band communication.
 *
 * Usage:
 *   const rng = createRng(42)
 *   rng() // → float in [0, 1)
 *   rng() // → next float in the sequence
 *
 * Verification:
 *   createRng(42)() === createRng(42)()  // always true
 *   Two rng instances from different seeds produce different sequences.
 */

/**
 * createRng(seed) → () => float
 *
 * @param {number} seed - A 32-bit unsigned integer seed.
 * @returns {() => number} A function that returns a pseudo-random float
 *                         in [0, 1) on each call.
 */
export function createRng(seed) {
  // Ensure seed is treated as an unsigned 32-bit integer.
  let s = seed >>> 0

  return function () {
    // Mulberry32 algorithm.
    s = (s + 0x6D2B79F5) >>> 0
    let z = s
    z = Math.imul(z ^ (z >>> 15), z | 1)
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61)
    z = ((z ^ (z >>> 14)) >>> 0)
    return z / 0x100000000  // divide by 2^32 → [0, 1)
  }
}
