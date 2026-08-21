/**
 * QRRenderer.jsx
 *
 * Renders a single fountain-coded frame as a QR code onto a <canvas>.
 *
 * Props:
 *   frameBytes {Uint8Array} Fully-encoded frame bytes from SenderSession.
 *                           Can be a data frame (0x02) or metadata frame (0x01).
 *                           QRRenderer does not inspect the frame type — it
 *                           renders whatever bytes it receives.
 *   size       {number}     Canvas width & height in pixels (default: 300)
 *   ecLevel    {string}     QR error correction: 'M' (default) or 'Q'
 *
 * Implementation notes:
 *   - QRCode.toCanvas() is called with [{data: Uint8Array, mode: 'byte'}] to
 *     force binary mode. Passing a string or using auto-detect would corrupt
 *     bytes above 0x7F via UTF-8 interpretation.
 *   - The bytes are NOT decoded or re-encoded here. SenderSession already
 *     produced fully-encoded packets. Rendering them directly avoids a
 *     pointless decode→re-encode round trip and works identically for both
 *     data frames and metadata frames.
 *   - toCanvas() returns a Promise. The .catch() is mandatory — a failed render
 *     produces a blank canvas with no visible error unless caught explicitly.
 */

import { useEffect, useRef } from 'react'
import QRCode from 'qrcode'

export default function QRRenderer({ frameBytes, size = 300, ecLevel = 'M' }) {
  const canvasRef = useRef(null)

  useEffect(() => {
    // Guard: render nothing until real data arrives.
    if (!frameBytes || frameBytes.length === 0) return

    QRCode.toCanvas(
      canvasRef.current,
      [{ data: frameBytes, mode: 'byte' }],
      {
        width: size,
        errorCorrectionLevel: ecLevel,
        margin: 2,
      }
    ).catch(err => console.error('QR render failed:', err))
  }, [frameBytes, size, ecLevel])

  return (
    <canvas
      ref={canvasRef}
      width={size}
      height={size}
      aria-label="QR code frame"
    />
  )
}
