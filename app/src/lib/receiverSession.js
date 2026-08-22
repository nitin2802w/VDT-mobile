/**
 * receiverSession.js
 *
 * The WAITING → RECEIVING → COMPLETE state machine for the offline receiver.
 * Routes raw bytes from the jsQR camera loop to the appropriate decoder.
 *
 * KEY DESIGN DECISIONS:
 *
 * 1. Frame routing lives here, not in packetCodec:
 *    This function reads bytes[0] and dispatches to decodeMetadata() or
 *    decodePacket() directly. Each returns an unambiguous, typed result.
 *    packetCodec.decodePacket() is scoped to data frames only.
 *
 * 2. Cross-transfer contamination prevention:
 *    The sender continuously re-emits metadata frames. A receiver in RECEIVING
 *    state compares each incoming metadata frame's SHA-256 against the active
 *    transfer hash. A match is a no-op; a mismatch means the sender restarted
 *    with a different file — the session resets automatically.
 *
 * 3. Hash-mismatch recovery in getResult():
 *    If all k blocks resolve but the SHA-256 of the reconstruction doesn't
 *    match, the bytes are silently corrupted. The decoder resets to RECEIVING
 *    and fresh symbols from the still-running sender will re-resolve the
 *    affected blocks. getResult() returns null to signal the caller to keep
 *    scanning rather than presenting corrupt data.
 *
 * 4. isComplete is a getter, never a method call:
 *    Use session.isComplete, never session.isComplete().
 */

import { decodePacket,   FRAME_DATA }      from './packetCodec.js'
import { decodeMetadata, FRAME_METADATA }  from './metadataPacket.js'
import { PeelingDecoder }                  from './peelingDecoder.js'
import { reconstruct }                     from './chunker.js'

// ── Internal state enum ───────────────────────────────────────────────────────

const STATE = Object.freeze({
  WAITING:   'WAITING',    // No metadata seen yet; decoder uninitialized.
  RECEIVING: 'RECEIVING',  // Metadata received; PeelingDecoder active.
  COMPLETE:  'COMPLETE',   // All k blocks resolved; awaiting getResult() call.
})

// ── Helper ────────────────────────────────────────────────────────────────────

/** Convert a Uint8Array to a lowercase hex string for SHA-256 comparison. */
function toHex(bytes) {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

// ── ReceiverSession ───────────────────────────────────────────────────────────

export class ReceiverSession {
  constructor() {
    this._state      = STATE.WAITING
    this._meta       = null   // full metadata object from last valid METADATA frame
    this._activeHash = null   // hex SHA-256 of the active transfer
    this._decoder    = null   // PeelingDecoder — null until RECEIVING
  }

  // ── Entry point ──────────────────────────────────────────────────────────────

  /**
   * handleDecodedFrame(bytes)
   *
   * Call this for every raw Uint8Array jsQR returns. Routes by frame type.
   * Never throws — any error silently drops the frame.
   *
   * @param {Uint8Array} bytes
   */
  handleDecodedFrame(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length === 0) return

    const type = bytes[0]

    if      (type === FRAME_METADATA) this._handleMetadata(bytes)
    else if (type === FRAME_DATA)     this._handleData(bytes)
    // Unknown type: drop silently.
  }

  // ── METADATA frame handler ───────────────────────────────────────────────────

  /** @private */
  _handleMetadata(bytes) {
    const meta = decodeMetadata(bytes)
    if (!meta) return  // corrupted / CRC fail — drop

    const incomingHash = toHex(meta.sha256Bytes)

    if (this._state === STATE.WAITING) {
      // First valid metadata ever seen — initialize.
      this._initTransfer(meta, incomingHash)
      return
    }

    if (incomingHash === this._activeHash) {
      // Same file, same transfer — no-op. (Most common case during a transfer.)
      return
    }

    // SHA-256 mismatch: the sender restarted with a different file.
    // Reset everything and begin tracking the new transfer immediately.
    this._initTransfer(meta, incomingHash)
  }

  /** @private — shared by _handleMetadata for both first-init and reset paths. */
  _initTransfer(meta, hashHex) {
    this._meta       = meta
    this._activeHash = hashHex
    this._decoder    = new PeelingDecoder(meta.k, meta.blockSize)
    this._state      = STATE.RECEIVING
  }

  // ── DATA frame handler ───────────────────────────────────────────────────────

  /** @private */
  _handleData(bytes) {
    if (this._state !== STATE.RECEIVING) return  // WAITING or COMPLETE: ignore

    const packet = decodePacket(bytes)
    if (!packet) return  // corrupted frame — drop

    this._decoder.addSymbol(packet.seed, packet.payload)

    if (this._decoder.isComplete) {
      this._state = STATE.COMPLETE
    }
  }

  // ── Public getters ───────────────────────────────────────────────────────────

  /** Number of blocks resolved so far (0 until RECEIVING). */
  get progress() {
    return this._decoder?.progress ?? 0
  }

  /** True once all k blocks have been recovered. */
  get isComplete() {
    return this._decoder?.isComplete ?? false
  }

  /** Total blocks expected — available once metadata has been received. */
  get totalBlocks() {
    return this._meta?.k ?? 0
  }

  /** Current state string — useful for UI debugging. */
  get state() {
    return this._state
  }

  // ── Result retrieval ─────────────────────────────────────────────────────────

  /**
   * async getResult() → { bytes: Uint8Array, filename: string } | null
   *
   * Must be called after isComplete is true. Reconstructs the file and
   * verifies its SHA-256 against the stored metadata hash.
   *
   * Returns null (and resets decoder to RECEIVING) if the hash doesn't match —
   * this allows the caller to keep scanning while fresh symbols resolve any
   * corrupted blocks. Never returns silently-corrupt data.
   *
   * @returns {Promise<{ bytes: Uint8Array, filename: string } | null>}
   */
  async getResult() {
    if (!this.isComplete) return null

    const blocks       = this._decoder.getReconstructedBlocks()
    const reconstructed = reconstruct(blocks, this._meta.fileSize)

    const hashBuffer  = await globalThis.crypto.subtle.digest('SHA-256', reconstructed)
    const actualHash  = toHex(new Uint8Array(hashBuffer))

    if (actualHash !== this._activeHash) {
      // Reconstruction is corrupt (bit-flip past CRC, or cross-transfer contamination).
      // Reset the decoder but keep the metadata — we know what file we want.
      // The caller should continue scanning; the endless sender stream will re-resolve.
      this._decoder = new PeelingDecoder(this._meta.k, this._meta.blockSize)
      this._state   = STATE.RECEIVING
      return null
    }

    return { bytes: reconstructed, filename: this._meta.filename }
  }

  // ── Manual reset ─────────────────────────────────────────────────────────────

  /**
   * reset()
   *
   * Fully resets to WAITING. Useful if the UI needs a "cancel" button.
   */
  reset() {
    this._state      = STATE.WAITING
    this._meta       = null
    this._activeHash = null
    this._decoder    = null
  }
}
