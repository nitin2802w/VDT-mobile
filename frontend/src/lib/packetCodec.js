/**
 * packetCodec.js
 *
 * Mirrors backend/app/core/packet.py exactly.
 *
 * Binary layout (big-endian throughout):
 *   Bytes 0-3  : symbol_seed  (uint32)
 *   Bytes 4-5  : payload_len  (uint16)
 *   Bytes 6..N : payload      (raw XOR'd block bytes)
 *   Bytes N+1..: CRC-32       (uint32) — covers header + payload, not itself
 *
 * Header size : 6 bytes
 * CRC size    : 4 bytes
 * Minimum total: 10 bytes
 *
 * CRC-32 uses the ISO-HDLC polynomial (0xEDB88320), same as Python's zlib.crc32().
 * Verified against zlib.crc32 on six test cases: empty bytes, all-zeros, ASCII
 * text, a simulated packet header+payload, and a full 0-255 byte sequence — all matched.
 */

// ── CRC-32 (ISO-HDLC, matches Python zlib.crc32) ─────────────────────────────
const _crcTable = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let j = 0; j < 8; j++)
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    t[i] = c
  }
  return t
})()

function _crc32(bytes) {
  let crc = 0xFFFFFFFF
  for (let i = 0; i < bytes.length; i++)
    crc = _crcTable[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8)
  return (crc ^ 0xFFFFFFFF) >>> 0  // >>> 0 forces unsigned 32-bit
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * encodePacket(seed, payload) → Uint8Array
 *
 * Serialises a fountain symbol into the same binary format as packet.py
 * serialize(). Used by QRRenderer to build the bytes to encode as a QR code,
 * and can be used standalone in tests to verify decodePacket symmetry.
 *
 * @param {number}     seed    - symbol_seed (uint32)
 * @param {Uint8Array} payload - XOR'd block bytes
 * @returns {Uint8Array}
 */
export function encodePacket(seed, payload) {
  const headerSize = 6
  const crcSize = 4
  const out = new Uint8Array(headerSize + payload.length + crcSize)
  const view = new DataView(out.buffer)

  view.setUint32(0, seed, false)           // big-endian uint32
  view.setUint16(4, payload.length, false) // big-endian uint16
  out.set(payload, 6)

  const crc = _crc32(out.subarray(0, headerSize + payload.length))
  view.setUint32(headerSize + payload.length, crc, false)

  return out
}

/**
 * decodePacket(bytes) → { seed, payload, crc } | null
 *
 * Parses and validates a raw Uint8Array produced by jsQR from a decoded QR frame.
 * Returns null on any error (too short, payload_len mismatch, CRC fail) so the
 * caller can simply skip bad frames without throwing.
 *
 * @param {Uint8Array} bytes - raw bytes from jsQR decode output
 * @returns {{ seed: number, payload: Uint8Array, crc: number } | null}
 */
export function decodePacket(bytes) {
  if (!(bytes instanceof Uint8Array)) return null
  if (bytes.length < 10) return null  // minimum: 6 header + 0 payload + 4 CRC

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const seed = view.getUint32(0, false)       // big-endian
  const payloadLen = view.getUint16(4, false) // big-endian

  // Total length must match exactly — catches garbled frames that beat CRC by coincidence
  if (bytes.length !== 6 + payloadLen + 4) return null

  const payload = bytes.slice(6, 6 + payloadLen)
  const receivedCrc = view.getUint32(6 + payloadLen, false)

  // CRC covers header + payload (not the CRC bytes themselves)
  const actualCrc = _crc32(bytes.subarray(0, 6 + payloadLen))
  if (actualCrc !== receivedCrc) return null

  return { seed, payload, crc: receivedCrc }
}
