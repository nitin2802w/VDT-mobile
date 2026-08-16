/**
 * roundtrip_test.mjs
 *
 * Phase O1 milestone test. Verifiable with plain Node (no bundler, no browser):
 *   node roundtrip_test.mjs
 *
 * Mirrors the rigour the Python backend test suite applied: random data,
 * shuffled symbols, injected duplicates, SHA-256 comparison.
 * Do not move to Phase O2 until this passes reliably across multiple runs.
 */

import { createRng }          from './frontend/src/lib/prng.js'
import { chunkFile, reconstruct } from './frontend/src/lib/chunker.js'
import { FountainEncoder }    from './frontend/src/lib/fountain.js'
import { PeelingDecoder }     from './frontend/src/lib/peelingDecoder.js'
import { createHash }         from 'crypto'  // Node built-in

// ── Helpers ───────────────────────────────────────────────────────────────────

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Fisher-Yates shuffle (in-place) — for simulating random camera frame order. */
function shuffle(arr) {
  const rng = createRng(Date.now() >>> 0)
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
}

function randomBytes(size) {
  const buf = new Uint8Array(size)
  const rng = createRng(12345)
  for (let i = 0; i < size; i++) buf[i] = Math.floor(rng() * 256)
  return buf
}

// ── Single round-trip test ────────────────────────────────────────────────────

function runTest(label, fileSize, blockSize, symbolMultiplier = 1.3) {
  process.stdout.write(`  ${label}: `)

  // 1. Generate deterministic random test data.
  const original = randomBytes(fileSize)
  const originalHash = sha256(original)

  // 2. Chunk.
  const { blocks, k } = chunkFile(original, blockSize)

  // 3. Encode: generate (k * multiplier) symbols — more than strictly needed,
  //    same as the Python test did to ensure reliable decode.
  const encoder = new FountainEncoder(blocks)
  const symbolCount = Math.ceil(k * symbolMultiplier)
  const symbols = []
  for (let i = 0; i < symbolCount; i++) {
    symbols.push(encoder.nextSymbol())
  }

  // 4. Simulate real-world camera: shuffle order + inject 10% duplicates.
  shuffle(symbols)
  const dupeCount = Math.floor(symbols.length * 0.10)
  for (let i = 0; i < dupeCount; i++) {
    symbols.push(symbols[Math.floor(Math.random() * symbols.length)])
  }
  shuffle(symbols)

  // 5. Decode.
  const decoder = new PeelingDecoder(k, blockSize)
  for (const { seed, payload } of symbols) {
    decoder.addSymbol(seed, payload)
    if (decoder.isComplete) break
  }

  // 6. Verify.
  if (!decoder.isComplete) {
    console.log(`FAIL — decoder not complete (${decoder.progress}/${k} blocks)`)
    process.exit(1)
  }

  const reconstructed = reconstruct(decoder.getReconstructedBlocks(), fileSize)
  const reconstructedHash = sha256(reconstructed)

  if (originalHash !== reconstructedHash) {
    console.log(`FAIL — SHA-256 mismatch!`)
    console.log(`  original:      ${originalHash}`)
    console.log(`  reconstructed: ${reconstructedHash}`)
    process.exit(1)
  }

  console.log(`PASS (k=${k}, symbols=${symbolCount})`)
}

// ── Run tests ─────────────────────────────────────────────────────────────────

console.log('\nPhase O1 Round-Trip Test Suite\n')
console.log('Testing...')

// Note on symbolMultiplier for small k:
// The Robust Soliton distribution assigns ~46.7% of symbols to degree=k for k=3.
// With only 1.3x symbols, there's a ~29% chance zero symbols are degree-1,
// making peeling impossible with no Gaussian fallback. Small k needs a larger
// multiplier. Mid/large k work reliably at 1.3x (matches Python test results).

// Edge case: k=1 (single block — degree is always 1, trivially passes)
runTest('k=1  single block          ', 300, 400, 2.0)

// Edge case: last block needs padding — small k needs higher multiplier
runTest('k=3  last block padded     ', 1050, 400, 3.0)

// Mid-size — 1.5x is reliable for k=25+
runTest('k=25 10 KB file            ', 10_000, 400, 1.5)

// Closer to a real file
runTest('k=256 100 KB file          ', 100_000, 400, 1.3)

// Larger file
runTest('k=500 200 KB file          ', 200_000, 400, 1.3)

// Non-divisible blockSize (validates .slice() safety)
runTest('k=40  blockSize=250 non-/4 ', 10_000, 250, 1.5)

console.log('\nAll tests passed. Phase O1 complete.\n')
