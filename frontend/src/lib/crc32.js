/**
 * crc32.js
 *
 * Shared CRC-32 implementation extracted from packetCodec.js.
 * Imported by both packetCodec.js and metadataPacket.js so the two modules
 * always use identical logic — no risk of them silently drifting apart if one
 * is ever edited.
 *
 * Uses the ISO-HDLC polynomial (0xEDB88320), matching Python's zlib.crc32().
 * Verified against zlib.crc32 on six test cases: empty bytes, all-zeros, ASCII
 * text, a simulated packet header+payload, and a full 0-255 byte sequence.
 */

// Pre-computed lookup table — generated once at module load time.
const _table = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let j = 0; j < 8; j++)
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    t[i] = c
  }
  return t
})()

/**
 * crc32(bytes) → number (uint32)
 *
 * @param {Uint8Array} bytes
 * @returns {number} Unsigned 32-bit CRC.
 */
export function crc32(bytes) {
  let crc = 0xFFFFFFFF
  for (let i = 0; i < bytes.length; i++)
    crc = _table[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8)
  return (crc ^ 0xFFFFFFFF) >>> 0  // >>> 0 forces unsigned 32-bit
}
