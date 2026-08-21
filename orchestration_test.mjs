/**
 * orchestration_test.mjs
 *
 * Phase O3 milestone test. Run with:
 *   node orchestration_test.mjs
 *
 * Tests the full local pipeline — SenderSession driving ReceiverSession —
 * without any timers, React, or network. Uses nextFrameBytes() to drive
 * the sender synchronously so the test doesn't need setTimeout delays.
 *
 * Test cases:
 *   1. Basic end-to-end: file arrives intact, SHA-256 verified.
 *   2. Noisy channel: ~10% frame drops, ~5% duplicates — still completes.
 *   3. Cross-transfer reset: sender switches file mid-transfer; receiver
 *      detects the new SHA-256, resets, and completes on the new file.
 *   4. setFps smoke-test: fps changes on the session object take effect.
 *   5. getResult() returns null and resets state on an artificially injected
 *      hash mismatch (verifies recovery path without waiting for bit-flips).
 */

// Node < 19 polyfill: expose webcrypto as globalThis.crypto so the session
// modules can use globalThis.crypto.subtle without browser-specific imports.
import { webcrypto } from 'node:crypto'
if (!globalThis.crypto) globalThis.crypto = webcrypto

import { SenderSession }   from './frontend/src/lib/senderSession.js'
import { ReceiverSession }  from './frontend/src/lib/receiverSession.js'

// ── Test harness ──────────────────────────────────────────────────────────────

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

function randomBytes(size) {
  const buf = new Uint8Array(size)
  const view = new DataView(buf.buffer)
  for (let i = 0; i < Math.floor(size / 4); i++)
    view.setUint32(i * 4, (Math.random() * 0x100000000) >>> 0)
  return buf
}

/**
 * Simulates feeding frames from a sender to a receiver until the receiver
 * is complete (or we run out of frames). Supports drop/dupe simulation.
 *
 * @param {SenderSession}  sender
 * @param {ReceiverSession} receiver
 * @param {number}  maxFrames   - Safety cap to avoid infinite loops.
 * @param {number}  dropRate    - Fraction of frames to drop (0–1).
 * @param {number}  dupeRate    - Fraction of frames to duplicate (0–1).
 * @returns {boolean} Whether the receiver completed within maxFrames.
 */
function runTransfer(sender, receiver, maxFrames = 5000, dropRate = 0, dupeRate = 0) {
  const buffer = []  // small lookahead for duplication

  for (let i = 0; i < maxFrames; i++) {
    const frame = sender.nextFrameBytes()

    // Duplicate: push this frame again before the current one occasionally.
    if (dupeRate > 0 && Math.random() < dupeRate) {
      buffer.push(frame)
    }

    // Drop: skip feeding this frame to receiver.
    if (dropRate > 0 && Math.random() < dropRate) {
      continue
    }

    receiver.handleDecodedFrame(frame)

    // Feed any buffered duplicates.
    for (const dup of buffer) {
      receiver.handleDecodedFrame(dup)
    }
    buffer.length = 0

    if (receiver.isComplete) return true
  }
  return false
}

// ── Test 1: Basic end-to-end ──────────────────────────────────────────────────

console.log('\nPhase O3 Orchestration Test Suite\n')
console.log('[1] Basic end-to-end transfer (10 KB, no noise)')
{
  const original  = randomBytes(10_000)
  const sender    = await SenderSession.create('test.bin', original, 400)
  const receiver  = new ReceiverSession()

  assert('state starts at WAITING', receiver.state === 'WAITING')

  const completed = runTransfer(sender, receiver, 3000)
  assert('transfer completes within 3000 frames', completed)
  assert('state is COMPLETE', receiver.state === 'COMPLETE')
  assert('isComplete getter is true', receiver.isComplete === true)

  const result = await receiver.getResult()
  assert('getResult() returns non-null', result !== null)
  assert('filename preserved', result?.filename === 'test.bin')
  assert('byte count matches', result?.bytes.length === original.length)
  assert('bytes are identical', result?.bytes.every((b, i) => b === original[i]))
}

// ── Test 2: Noisy channel (drops + dupes) ────────────────────────────────────

console.log('\n[2] Noisy channel: 10% drops, 5% duplicates (50 KB)')
{
  const original = randomBytes(50_000)
  const sender   = await SenderSession.create('noisy.bin', original, 400)
  const receiver = new ReceiverSession()

  const completed = runTransfer(sender, receiver, 10_000, 0.10, 0.05)
  assert('completes despite noise', completed)

  const result = await receiver.getResult()
  assert('result is non-null after noisy transfer', result !== null)
  assert('bytes are identical after noisy transfer',
    result?.bytes.every((b, i) => b === original[i]))
}

// ── Test 3: Cross-transfer detection and reset ────────────────────────────────

console.log('\n[3] Cross-transfer: sender switches file mid-transfer')
{
  // file_a must be large enough (k=250) that 80 frames cannot complete it.
  // file_a=5KB (k=13) finished in ~80 frames — state was COMPLETE, not RECEIVING.
  const file_a    = randomBytes(100_000)
  const file_b    = randomBytes(8_000)
  const sender_a  = await SenderSession.create('file_a.bin', file_a, 400)
  const sender_b  = await SenderSession.create('file_b.bin', file_b, 400)
  const receiver  = new ReceiverSession()

  // Feed ~80 frames from sender_a (enough to move to RECEIVING but not complete).
  for (let i = 0; i < 80; i++) {
    receiver.handleDecodedFrame(sender_a.nextFrameBytes())
  }
  assert('receiver is RECEIVING after partial transfer', receiver.state === 'RECEIVING')
  const progressAfterA = receiver.progress
  assert('some blocks resolved from file_a', progressAfterA > 0)

  // Switch to sender_b — receiver should detect the new SHA-256 and reset.
  // We need to emit a metadata frame from sender_b. nextFrameBytes() emits
  // data frames most of the time — force a metadata frame by feeding enough
  // frames until the interleave position hits (every 15 frames).
  for (let i = 0; i < 15; i++) {
    receiver.handleDecodedFrame(sender_b.nextFrameBytes())
  }
  // After seeing the metadata frame from sender_b, receiver should have reset.
  assert('receiver reset to RECEIVING after new metadata',
    receiver.state === 'RECEIVING')
  assert('progress reset to 0 after cross-transfer reset', receiver.progress === 0)

  // Now complete the transfer for file_b.
  const completed = runTransfer(sender_b, receiver, 5000)
  assert('completes on file_b after reset', completed)

  const result = await receiver.getResult()
  assert('result filename is file_b.bin', result?.filename === 'file_b.bin')
  assert('bytes match file_b',
    result?.bytes.every((b, i) => b === file_b[i]))
}

// ── Test 4: setFps smoke test ─────────────────────────────────────────────────

console.log('\n[4] setFps: live rate adjustment')
{
  const sender = await SenderSession.create('fps_test.bin', randomBytes(1000), 400)
  sender.start(() => {}, 5)
  assert('session is running at 5fps', sender._running === true)
  assert('fps is 5', sender._fps === 5)

  sender.setFps(20)
  assert('fps updated to 20 without stop/restart', sender._fps === 20)
  assert('session is still running after setFps', sender._running === true)

  sender.pause()
  assert('session paused', sender._running === false)

  sender.start(() => {}, 10)
  assert('session resumed', sender._running === true)
  sender.stop()
}

// ── Test 5: getResult() recovery on hash mismatch ────────────────────────────

console.log('\n[5] getResult() resets to RECEIVING on hash mismatch')
{
  const original = randomBytes(2_000)
  const sender   = await SenderSession.create('mismatch.bin', original, 400)
  const receiver = new ReceiverSession()

  // Complete the transfer normally.
  runTransfer(sender, receiver, 3000)
  assert('transfer complete before tamper test', receiver.isComplete)

  // Tamper: override the stored hash so getResult() gets a mismatch.
  receiver._activeHash = '00'.repeat(32)

  const result = await receiver.getResult()
  assert('getResult() returns null on hash mismatch', result === null)
  assert('state resets to RECEIVING after mismatch', receiver.state === 'RECEIVING')
  assert('progress resets to 0 after mismatch', receiver.progress === 0)
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`)
if (failed === 0) {
  console.log(`All ${passed} tests passed. Phase O3 complete.\n`)
} else {
  console.error(`${failed} test(s) FAILED.\n`)
  process.exit(1)
}
