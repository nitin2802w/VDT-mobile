/**
 * packetCodec.js
 *
 * DATA frame encoder/decoder for fountain symbols.
 *
 * Wire format (big-endian throughout):
 *   Byte  0     : frame_type   (0x02 = DATA)
 *   Bytes 1–4   : symbol_seed  (uint32)
 *   Bytes 5–6   : payload_len  (uint16)
 *   Bytes 7..N  : payload      (raw XOR'd block bytes)
 *   Bytes N+1..4: CRC-32       (uint32) — covers bytes 0..N inclusive
 *
 * HEADER_SIZE = 7 bytes (type + seed + len)
 * CRC_SIZE    = 4 bytes
 * Minimum packet = 11 bytes (7 header + 0 payload + 4 CRC)
 *
 * IMPORTANT — decodePacket scope:
 *   decodePacket ONLY handles type 0x02 frames and returns null for anything
 *   else (including type 0x01 metadata frames). Frame-type routing lives in
 *   receiverSession.js, not here — that keeps each decoder's return shape
 *   unambiguous and avoids polymorphic returns from a single function.
 *
 * IMPORTANT — CRC boundary:
 *   CRC covers HEADER_SIZE + payload.length bytes (all bytes before the CRC
 *   field itself, including the type byte at index 0). The constant HEADER_SIZE
 *   is used everywhere rather than a hardcoded literal so a future layout change
 *   can't silently leave one call site stale.
 */

import { crc32 } from './crc32.js'

export const FRAME_DATA     = 0x02
const        HEADER_SIZE    = 7   // type(1) + seed(4) + payload_len(2)
const        CRC_SIZE       = 4
const        MIN_PACKET_LEN = HEADER_SIZE + CRC_SIZE  // 11 — zero-length payload

/**
 * encodePacket(seed, payload) → Uint8Array
 *
 * @param {number}     seed    - symbol_seed (uint32)
 * @param {Uint8Array} payload - XOR'd block bytes from FountainEncoder
 * @returns {Uint8Array}
 */
export function encodePacket(seed, payload) {
  const out  = new Uint8Array(HEADER_SIZE + payload.length + CRC_SIZE)
  const view = new DataView(out.buffer)

  out[0] = FRAME_DATA
  view.setUint32(1, seed,           false)  // big-endian uint32
  view.setUint16(5, payload.length, false)  // big-endian uint16
  out.set(payload, HEADER_SIZE)

  // CRC covers every byte before the CRC field — type byte included.
  const coveredLen = HEADER_SIZE + payload.length
  view.setUint32(coveredLen, crc32(out.subarray(0, coveredLen)), false)

  return out
}

/**
 * decodePacket(bytes) → { seed, payload, crc } | null
 *
 * Returns null on any rejection: wrong type byte, wrong total length,
 * CRC failure. Never throws — callers skip null frames without branching.
 *
 * @param {Uint8Array} bytes - raw bytes from jsQR binaryData
 * @returns {{ seed: number, payload: Uint8Array, crc: number } | null}
 */
export function decodePacket(bytes) {
  if (!(bytes instanceof Uint8Array))  return null
  if (bytes.length < MIN_PACKET_LEN)   return null
  if (bytes[0] !== FRAME_DATA)         return null  // type 0x01 handled elsewhere

  const view       = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const seed       = view.getUint32(1, false)
  const payloadLen = view.getUint16(5, false)

  // Exact-length check catches garbled frames that happen to pass CRC.
  if (bytes.length !== HEADER_SIZE + payloadLen + CRC_SIZE) return null

  const coveredLen = HEADER_SIZE + payloadLen
  const receivedCrc = view.getUint32(coveredLen, false)
  const actualCrc   = crc32(bytes.subarray(0, coveredLen))
  if (actualCrc !== receivedCrc) return null

  const payload = bytes.slice(HEADER_SIZE, coveredLen)
  return { seed, payload, crc: receivedCrc }
}
