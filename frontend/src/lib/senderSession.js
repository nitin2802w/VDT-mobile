/**
 * senderSession.js
 *
 * Wraps FountainEncoder with the metadata-interleaving timer loop.
 * Emits a continuous stream of ready-to-render Uint8Array frames
 * via a callback, alternating between data frames and periodic metadata frames.
 *
 * IMPORTANT — async construction:
 *   The constructor does synchronous setup only. All async work (SHA-256
 *   hashing) lives in the static factory. Always use:
 *     const session = await SenderSession.create(filename, bytes, blockSize)
 *   Never call `new SenderSession()` directly from outside this module.
 *
 * IMPORTANT — metadata interleaving:
 *   The pre-computed metadata frame is emitted every METADATA_EVERY ticks.
 *   It's always the exact same bytes — the receiver uses SHA-256 to detect
 *   when the sender has switched to a different file.
 */

import { chunkFile }       from './chunker.js'
import { FountainEncoder } from './fountain.js'
import { encodePacket }    from './packetCodec.js'
import { encodeMetadata }  from './metadataPacket.js'

/** How many frames between each metadata frame injection. */
const METADATA_EVERY = 15

export class SenderSession {
  /** @private — use SenderSession.create() */
  constructor() {
    this._metadataBytes = null
    this._encoder       = null
    this._frameCount    = 0
    this._fps           = 10
    this._running       = false
    this._intervalId    = null
    this._onFrame       = null
  }

  // ── Factory ──────────────────────────────────────────────────────────────────

  /**
   * SenderSession.create(filename, bytes, blockSize) → Promise<SenderSession>
   *
   * Awaits SHA-256 computation, chunks the file, and builds the pre-computed
   * metadata frame before returning a fully-ready instance.
   *
   * @param {string}     filename  - Original filename (UTF-8).
   * @param {Uint8Array} bytes     - Raw file bytes.
   * @param {number}     blockSize - Block size in bytes (default 400).
   * @returns {Promise<SenderSession>}
   */
  static async create(filename, bytes, blockSize = 400) {
    // SHA-256 of the raw file — the receiver will use this to verify reconstruction.
    const hashBuffer  = await globalThis.crypto.subtle.digest('SHA-256', bytes)
    const sha256Bytes = new Uint8Array(hashBuffer)

    const { blocks, k, fileSize } = chunkFile(bytes, blockSize)

    const inst            = new SenderSession()
    inst._encoder         = new FountainEncoder(blocks)
    inst._metadataBytes   = encodeMetadata({ filename, fileSize, k, blockSize, sha256Bytes })

    return inst
  }

  // ── Frame generation ─────────────────────────────────────────────────────────

  /**
   * nextFrameBytes() → Uint8Array
   *
   * Generates and returns the next frame synchronously.
   * Also exposed publicly so test code can drive the session without timers.
   *
   * @returns {Uint8Array}
   */
  nextFrameBytes() {
    this._frameCount++
    if (this._frameCount % METADATA_EVERY === 0) {
      return this._metadataBytes  // same bytes every time — receiver de-dupes by SHA-256
    }
    const { seed, payload } = this._encoder.nextSymbol()
    return encodePacket(seed, payload)
  }

  // ── Timer loop ───────────────────────────────────────────────────────────────

  /**
   * start(onFrame, fps)
   *
   * Begins the timed emission loop. `onFrame(frameBytes)` is called on each tick.
   * No-op if already running.
   *
   * @param {(bytes: Uint8Array) => void} onFrame
   * @param {number} fps
   */
  start(onFrame, fps = 10) {
    if (this._running) return
    this._running  = true
    this._fps      = fps
    this._onFrame  = onFrame
    this._scheduleTick()
  }

  /** @private */
  _scheduleTick() {
    if (!this._running) return
    this._intervalId = setTimeout(() => {
      if (!this._running) return
      this._onFrame(this.nextFrameBytes())
      this._scheduleTick()
    }, 1000 / this._fps)
  }

  /**
   * setFps(fps)
   *
   * Adjusts the emission rate in place. Takes effect on the next scheduled
   * tick — does not reset the seed counter or metadata interleave position.
   *
   * @param {number} fps
   */
  setFps(fps) {
    this._fps = fps
  }

  /**
   * pause()
   *
   * Suspends the timer loop. The seed counter and interleave position are
   * preserved. A subsequent start() resumes from where it left off.
   */
  pause() {
    this._running = false
    clearTimeout(this._intervalId)
    this._intervalId = null
  }

  /**
   * stop()
   *
   * Stops the loop and resets to the beginning of the same file.
   * The same session instance can be restarted via start() to retransmit.
   */
  stop() {
    this.pause()
    this._encoder._nextSeed = 0  // rewind to symbol 0
    this._frameCount        = 0
    this._onFrame           = null
  }
}
