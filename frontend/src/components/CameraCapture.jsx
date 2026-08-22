/**
 * CameraCapture.jsx
 *
 * Requests camera access, renders the live feed, and continuously decodes
 * QR codes from each frame using jsQR. When a QR is found, calls onDecode
 * with the raw binary payload as a Uint8Array.
 *
 * Props:
 *   onDecode  {(Uint8Array) => void}  called on every successful QR decode
 *   onStatus  {(string) => void}      optional — called on every scan attempt
 *                                     with 'found' or 'scanning', useful for
 *                                     debugging camera decode rate on device
 *   onError   {(string) => void}      optional — called if camera access fails
 *   active    {boolean}               when false, scan loop is suspended
 *                                     (video feed stays visible)
 *
 * Design notes:
 *   - Uses requestAnimationFrame for the capture loop, gated to SCAN_INTERVAL_MS
 *     so jsQR (synchronous, ~5-15ms) doesn't fire 60 times/s and starve the
 *     React render loop.
 *   - `active` is read as a ref inside the rAF loop to avoid stale closures —
 *     changing the prop doesn't need to restart the loop.
 *   - Tracks acquired camera stream in a ref to ensure full cleanup (stop all
 *     tracks) even if the component unmounts mid-stream.
 *   - jsQR returns binaryData as Uint8ClampedArray; we wrap it in a Uint8Array
 *     before passing to onDecode so decodePacket's DataView works correctly.
 *   - facingMode: 'environment' selects the rear camera on mobile by default.
 */

import { useEffect, useRef, useCallback } from 'react'
import jsQR from 'jsqr'
import { Capacitor } from '@capacitor/core'

const SCAN_INTERVAL_MS = 50  // 20 scans/s — better decode rate on real devices

export default function CameraCapture({ onDecode, onStatus, onError, active = true }) {
  const videoRef    = useRef(null)
  const canvasRef   = useRef(null)
  const streamRef   = useRef(null)  // MediaStream, for cleanup
  const rafRef      = useRef(null)  // rAF handle, for cleanup
  const lastScanRef = useRef(0)     // timestamp of last jsQR call
  const activeRef   = useRef(active)

  // Keep the ref in sync without restarting the loop
  useEffect(() => { activeRef.current = active }, [active])

  // ── scan loop ─────────────────────────────────────────────────────────────────
  const scan = useCallback((timestamp) => {
    rafRef.current = requestAnimationFrame(scan)

    if (!activeRef.current) return
    if (timestamp - lastScanRef.current < SCAN_INTERVAL_MS) return

    lastScanRef.current = timestamp

    const video  = videoRef.current
    const canvas = canvasRef.current
    if (!video || !canvas || video.readyState < HTMLMediaElement.HAVE_ENOUGH_DATA) return

    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    canvas.width  = video.videoWidth
    canvas.height = video.videoHeight
    ctx.drawImage(video, 0, 0)

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
    const result = jsQR(imageData.data, canvas.width, canvas.height, {
      inversionAttempts: 'dontInvert',  // binary data is never inverted
    })

    if (result?.binaryData?.length > 0) {
      onStatus?.('found')
      onDecode(new Uint8Array(result.binaryData))
    } else {
      onStatus?.('scanning')
    }
  }, [onDecode])

  // ── camera lifecycle ──────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false

    async function startCamera() {
      try {
        // Android requires an explicit runtime permission request BEFORE
        // getUserMedia — declaring CAMERA in the manifest alone isn't enough.
        // This is a no-op in a plain browser (Capacitor.isNativePlatform() = false).
        if (Capacitor.isNativePlatform()) {
          const { Camera } = await import('@capacitor/camera')
          const perm = await Camera.requestPermissions({ permissions: ['camera'] })
          if (perm.camera !== 'granted') {
            console.error('Camera permission denied by user')
            return
          }
        }

        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
          audio: false,
        })
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return }

        streamRef.current = stream
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          videoRef.current.play()
        }

        rafRef.current = requestAnimationFrame(scan)
      } catch (err) {
        if (!cancelled) {
          const msg = err.name === 'NotAllowedError'
            ? 'Camera permission denied'
            : `Camera failed: ${err.name}`
          console.error('Camera access failed:', err.name, err.message)
          onError?.(msg)
        }
      }
    }

    startCamera()

    return () => {
      cancelled = true
      cancelAnimationFrame(rafRef.current)
      streamRef.current?.getTracks().forEach(t => t.stop())
      streamRef.current = null
    }
  }, [scan])

  return (
    <div className="relative w-full max-w-sm aspect-square rounded-2xl overflow-hidden bg-gray-900">
      {/* Live video feed */}
      <video
        ref={videoRef}
        muted
        playsInline
        className="absolute inset-0 w-full h-full object-cover"
        aria-label="Camera viewfinder"
      />

      {/* Offscreen canvas for jsQR — hidden, used only for pixel capture */}
      <canvas ref={canvasRef} className="hidden" aria-hidden="true" />

      {/* Scan overlay — a subtle corner-bracket target indicator */}
      <div className="absolute inset-0 pointer-events-none">
        <svg viewBox="0 0 100 100" className="absolute inset-4 w-auto h-auto opacity-60" fill="none">
          {/* Top-left */}
          <path d="M5 20 L5 5 L20 5"   stroke="white" strokeWidth="3" strokeLinecap="round"/>
          {/* Top-right */}
          <path d="M80 5 L95 5 L95 20" stroke="white" strokeWidth="3" strokeLinecap="round"/>
          {/* Bottom-left */}
          <path d="M5 80 L5 95 L20 95" stroke="white" strokeWidth="3" strokeLinecap="round"/>
          {/* Bottom-right */}
          <path d="M80 95 L95 95 L95 80" stroke="white" strokeWidth="3" strokeLinecap="round"/>
        </svg>
      </div>
    </div>
  )
}
