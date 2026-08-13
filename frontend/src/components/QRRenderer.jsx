/**
 * QRRenderer.jsx
 *
 * Renders a single fountain-coded symbol as a QR code onto a <canvas>.
 *
 * Props:
 *   seed     {number}     symbol_seed (uint32) — must be defined (0 is valid)
 *   payload  {Uint8Array} XOR'd block bytes from the sender WebSocket
 *   size     {number}     canvas width & height in pixels (default: 300)
 *   ecLevel  {string}     QR error correction: 'M' (default) or 'Q'
 *
 * Implementation notes:
 *   - QRCode.toCanvas() is called with [{data: Uint8Array, mode: 'byte'}] to
 *     force binary mode. Passing a string or using the auto-detect default
 *     would corrupt bytes above 0x7F via UTF-8 interpretation.
 *   - toCanvas() returns a Promise. The .catch() is mandatory — a failed render
 *     produces a blank canvas with no visible error unless caught explicitly.
 *   - The seed guard uses (seed === undefined) not (!seed) — seed=0 is the
 *     very first symbol fountain.py generates and must not be skipped.
 */

import { useEffect, useRef } from 'react'
import QRCode from 'qrcode'
import { encodePacket } from '../lib/packetCodec'

export default function QRRenderer({ seed, payload, size = 300, ecLevel = 'M' }) {
  const canvasRef = useRef(null)

  useEffect(() => {
    // Guard: wait until real data arrives. seed=0 is valid, so use strict undefined check.
    if (seed === undefined || !payload) return

    const packetBytes = encodePacket(seed, payload)

    QRCode.toCanvas(
      canvasRef.current,
      [{ data: packetBytes, mode: 'byte' }],
      {
        width: size,
        errorCorrectionLevel: ecLevel,
        margin: 2,
      }
    ).catch(err => console.error('QR render failed:', err))
  }, [seed, payload, size, ecLevel])

  return (
    <canvas
      ref={canvasRef}
      width={size}
      height={size}
      aria-label={`QR code for symbol seed ${seed}`}
    />
  )
}
