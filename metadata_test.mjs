/**
 * metadata_test.mjs
 *
 * Phase O2 milestone test. Run with:
 *   node metadata_test.mjs
 *
 * Tests:
 *   1. CRC round-trip for data frames (packetCodec)
 *   2. TAMPER TEST: flip the last payload byte — must return null
 *      (A symmetric wrong formula passes round-trips but fails this.)
 *   3. Data frame rejects wrong type byte (0x01)
 *   4. Metadata round-trip: ASCII filename
 *   5. Metadata round-trip: non-ASCII filename (emoji — TextEncoder edge case)
 *   6. Metadata CRC tamper: flip a middle byte, must return null
 *   7. Metadata decode: truncated buffer (Stage 1 bounds check)
 *   8. Metadata decode: filename_length lies about size (Stage 2 bounds check)
 */

import { encodePacket, decodePacket, FRAME_DATA }         from './frontend/src/lib/packetCodec.js'
import { encodeMetadata, decodeMetadata, FRAME_METADATA }  from './frontend/src/lib/metadataPacket.js'
import { crc32 }                                           from './frontend/src/lib/crc32.js'
import { createHash }                                      from 'crypto'

// ── Helpers ───────────────────────────────────────────────────────────────────

let passed = 0
let failed = 0

function assert(label, condition) {
  if (condition) {
    console.log(`  PASS: ${label}`)
    passed++
  } else {
    console.error(`  FAIL: ${label}`)
    failed++
  }
}

function randomBytes(n) {
  const b = new Uint8Array(n)
  for (let i = 0; i < n; i++) b[i] = Math.floor(Math.random() * 256)
  return b
}

function makeSha256(data) {
  return new Uint8Array(createHash('sha256').update(data).digest())
}

// ── 1. Data frame round-trip ──────────────────────────────────────────────────

console.log('\nPhase O2 Wire Format Test Suite\n')
console.log('[1] Data frame round-trips')
{
  const payload = randomBytes(400)
  const seed    = 12345
  const encoded = encodePacket(seed, payload)
  const decoded = decodePacket(encoded)

  assert('decodePacket returns non-null',              decoded !== null)
  assert('seed matches',                               decoded?.seed === seed)
  assert('payload length matches',                     decoded?.payload.length === payload.length)
  assert('payload bytes match',
    decoded?.payload.every((b, i) => b === payload[i]))
}

// ── 2. TAMPER TEST — the critical one ────────────────────────────────────────

console.log('\n[2] Tamper test — flip last payload byte (proves CRC boundary is correct)')
{
  // A symmetric wrong formula (e.g. both sides skip the last byte) would round-trip
  // fine but fail this test, because the tampered byte is outside the covered range.
  const payload  = randomBytes(400)
  const encoded  = encodePacket(42, payload)
  const tampered = encoded.slice()
  // Last payload byte is at index HEADER_SIZE + payload.length - 1 = 7 + 399 = 406
  const lastPayloadIdx = encoded.length - 1 - 4  // subtract CRC_SIZE
  tampered[lastPayloadIdx] ^= 0xFF               // flip all bits
  assert('tampered last payload byte returns null', decodePacket(tampered) === null)
}

// ── 3. Wrong type byte ───────────────────────────────────────────────────────

console.log('\n[3] Data frame rejects wrong type byte')
{
  const encoded  = encodePacket(1, randomBytes(10))
  const tampered = encoded.slice()
  tampered[0] = FRAME_METADATA  // 0x01
  assert('type 0x01 returns null from decodePacket', decodePacket(tampered) === null)
  assert('empty Uint8Array returns null',             decodePacket(new Uint8Array(0)) === null)
  assert('null input returns null',                   decodePacket(null) === null)
}

// ── 4. Metadata round-trip: ASCII ────────────────────────────────────────────

console.log('\n[4] Metadata frame round-trip (ASCII filename)')
{
  const sha256Bytes = makeSha256(randomBytes(1000))
  const meta = { filename: 'hello_world.txt', fileSize: 102400, k: 256, blockSize: 400, sha256Bytes }
  const encoded = encodeMetadata(meta)
  const decoded = decodeMetadata(encoded)

  assert('decodeMetadata returns non-null',          decoded !== null)
  assert('filename matches',                         decoded?.filename === meta.filename)
  assert('fileSize matches',                         decoded?.fileSize === meta.fileSize)
  assert('k matches',                                decoded?.k === meta.k)
  assert('blockSize matches',                        decoded?.blockSize === meta.blockSize)
  assert('sha256Bytes matches',
    decoded?.sha256Bytes.every((b, i) => b === sha256Bytes[i]))
}

// ── 5. Metadata round-trip: non-ASCII (emoji) ────────────────────────────────

console.log('\n[5] Metadata frame round-trip (emoji filename — TextEncoder edge case)')
{
  // "📁" is 4 bytes in UTF-8 but 2 chars in JS — filename_length is in BYTES.
  const filename    = '📁 résumé nitin.pdf'
  const sha256Bytes = makeSha256(randomBytes(500))
  const meta        = { filename, fileSize: 50000, k: 125, blockSize: 400, sha256Bytes }
  const encoded     = encodeMetadata(meta)
  const decoded     = decodeMetadata(encoded)

  assert('non-ASCII round-trip returns non-null', decoded !== null)
  assert('non-ASCII filename matches',            decoded?.filename === filename)
}

// ── 6. Metadata CRC tamper ───────────────────────────────────────────────────

console.log('\n[6] Metadata CRC tamper')
{
  const encoded  = encodeMetadata({
    filename: 'file.bin', fileSize: 1024, k: 3, blockSize: 400,
    sha256Bytes: makeSha256(randomBytes(100))
  })
  const tampered = encoded.slice()
  tampered[5] ^= 0xFF  // flip a byte in the middle
  assert('tampered metadata returns null', decodeMetadata(tampered) === null)
}

// ── 7. Truncated buffer (Stage 1 bounds check) ───────────────────────────────

console.log('\n[7] Truncated metadata buffer (Stage 1: cannot read filename_length)')
{
  const truncated = new Uint8Array([FRAME_METADATA, 0x00])  // only 2 bytes, need 3
  assert('2-byte buffer returns null', decodeMetadata(truncated) === null)
}

// ── 8. filename_length lies (Stage 2 bounds check) ───────────────────────────

console.log('\n[8] filename_length claims 65000 bytes (Stage 2: total length mismatch)')
{
  const lying = new Uint8Array(50)
  lying[0] = FRAME_METADATA
  const view = new DataView(lying.buffer)
  view.setUint16(1, 65000, false)  // claims 65000-byte filename
  // Buffer is only 50 bytes — Stage 2 check must reject before any reads.
  assert('oversized filename_length returns null', decodeMetadata(lying) === null)
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`)
if (failed === 0) {
  console.log(`All ${passed} tests passed. Phase O2 complete.\n`)
} else {
  console.error(`${failed} test(s) FAILED. Fix before moving to Phase O3.\n`)
  process.exit(1)
}
