/**
 * metadataPacket.js
 *
 * Encoder/decoder for METADATA frames (frame_type = 0x01).
 *
 * The sender interleaves one metadata QR code every ~15-20 data frames so a
 * receiver joining mid-transfer picks up the file parameters quickly without
 * needing a REST API call.
 *
 * Wire format (big-endian throughout):
 *   Byte  0     : frame_type      (0x01 = METADATA)
 *   Bytes 1–2   : filename_length (uint16) — byte length of UTF-8 filename
 *   Bytes 3..X  : filename        (UTF-8 bytes)
 *   Next  4     : file_size       (uint32)
 *   Next  4     : k               (uint32) — total source block count
 *   Next  2     : block_size      (uint16)
 *   Next 32     : sha256_digest   (raw 32 bytes, NOT hex — saves 32 bytes per frame)
 *   Next  4     : CRC-32          (uint32, covers every byte before it)
 *
 * SAFETY CONTRACT for decodeMetadata:
 *   jsQR produces false-positive reads on every blurry/misread camera frame.
 *   DataView throws RangeError when a read exceeds the buffer — if that
 *   propagates out of this function it crashes the entire camera decode loop.
 *   Defence strategy:
 *     1. Two-stage explicit length check before any DataView read.
 *     2. try/catch around the entire body as a backstop.
 *   A corrupted frame must always produce null, never an exception.
 */

import { crc32 } from './crc32.js'

export const FRAME_METADATA = 0x01

// Byte counts for fixed fields that appear AFTER the variable-length filename.
const POST_FILENAME_FIXED = 4 + 4 + 2 + 32  // file_size + k + block_size + sha256
const CRC_SIZE            = 4
const FIXED_PREFIX        = 3               // type(1) + filename_length(2)

// Minimum total size assuming a zero-length filename.
const MIN_METADATA_LEN = FIXED_PREFIX + POST_FILENAME_FIXED + CRC_SIZE  // 45

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * encodeMetadata({ filename, fileSize, k, blockSize, sha256Bytes }) → Uint8Array
 *
 * @param {object}     opts
 * @param {string}     opts.filename    - Original filename (UTF-8).
 * @param {number}     opts.fileSize    - Original unpadded file size in bytes.
 * @param {number}     opts.k           - Total source block count.
 * @param {number}     opts.blockSize   - Block size in bytes.
 * @param {Uint8Array} opts.sha256Bytes - Raw 32-byte SHA-256 digest.
 * @returns {Uint8Array}
 */
export function encodeMetadata({ filename, fileSize, k, blockSize, sha256Bytes }) {
  const nameBytes = encoder.encode(filename)  // UTF-8 — byte length may exceed char length
  const total     = FIXED_PREFIX + nameBytes.length + POST_FILENAME_FIXED + CRC_SIZE
  const out       = new Uint8Array(total)
  const view      = new DataView(out.buffer)

  let offset = 0
  out[offset++] = FRAME_METADATA                         // type byte

  view.setUint16(offset, nameBytes.length, false); offset += 2  // filename_length
  out.set(nameBytes, offset);                        offset += nameBytes.length
  view.setUint32(offset, fileSize,   false);         offset += 4  // file_size
  view.setUint32(offset, k,          false);         offset += 4  // k
  view.setUint16(offset, blockSize,  false);         offset += 2  // block_size
  out.set(sha256Bytes, offset);                      offset += 32 // sha256

  // CRC covers every byte written so far.
  view.setUint32(offset, crc32(out.subarray(0, offset)), false)

  return out
}

/**
 * decodeMetadata(bytes) → { filename, fileSize, k, blockSize, sha256Bytes } | null
 *
 * Returns null on any error: wrong type byte, insufficient length, CRC fail,
 * or any unexpected exception from malformed input.
 *
 * @param {Uint8Array} bytes
 * @returns {object|null}
 */
export function decodeMetadata(bytes) {
  try {
    if (!(bytes instanceof Uint8Array))    return null
    if (bytes[0] !== FRAME_METADATA)       return null

    // ── Stage 1: check we can safely read filename_length ─────────────────────
    if (bytes.length < FIXED_PREFIX) return null

    const view          = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const filenameLen   = view.getUint16(1, false)

    // ── Stage 2: check total length covers everything ──────────────────────────
    const expectedLen   = FIXED_PREFIX + filenameLen + POST_FILENAME_FIXED + CRC_SIZE
    if (bytes.length !== expectedLen) return null

    let offset = FIXED_PREFIX
    const filename   = decoder.decode(bytes.subarray(offset, offset + filenameLen))
    offset += filenameLen

    const fileSize   = view.getUint32(offset, false); offset += 4
    const k          = view.getUint32(offset, false); offset += 4
    const blockSize  = view.getUint16(offset, false); offset += 2
    const sha256Bytes = bytes.slice(offset, offset + 32); offset += 32

    // ── CRC check — covers everything before the CRC field ────────────────────
    const receivedCrc = view.getUint32(offset, false)
    const actualCrc   = crc32(bytes.subarray(0, offset))
    if (actualCrc !== receivedCrc) return null

    return { filename, fileSize, k, blockSize, sha256Bytes }

  } catch {
    // Any RangeError or other exception from malformed input → drop the frame.
    return null
  }
}
