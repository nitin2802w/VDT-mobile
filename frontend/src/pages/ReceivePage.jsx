/**
 * ReceivePage.jsx — Phase F4
 *
 * State machine:
 *   IDLE        → user lands here; fetches metadata to confirm a transfer is active
 *   SCANNING    → camera + receiver WebSocket open; symbols being decoded & posted
 *   COMPLETE    → decoder reports all blocks received; download ready
 *   DOWNLOADING → downloadFile() in flight
 *   DONE        → file saved to disk
 *   ERROR       → unrecoverable failure; retry resets to IDLE
 *
 * Symbol pipeline (per QR frame):
 *   jsQR(frame) → binaryData (Uint8Array)
 *   → decodePacket(bytes) → null = bad frame, skip
 *   → seenRef.has(seed)  → true = duplicate, skip
 *   → seenRef.add(seed)
 *   → postSymbol(seed, payload, crc)  [fire-and-forget, errors logged not thrown]
 *
 * Progress source:
 *   Receiver WebSocket pushes { type:'progress', progress, k, complete } on
 *   every successful symbol — no polling. When complete:true arrives, we
 *   transition to COMPLETE and trigger the download.
 *
 * Download:
 *   sha256 is captured from getMetadata() at scan-start. downloadFile(sha256)
 *   returns a Blob; we create an object URL and click a hidden anchor to trigger
 *   the browser's native Save dialog. URL is revoked after click.
 *
 * Cleanup:
 *   Receiver WebSocket closed and camera stopped when leaving SCANNING state
 *   or on unmount.
 */

import { useState, useRef, useCallback, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { getMetadata, postSymbol, downloadFile, openReceiverSocket } from '../lib/api'
import { decodePacket } from '../lib/packetCodec'
import CameraCapture from '../components/CameraCapture'
import ProgressBar   from '../components/ProgressBar'

// ── state machine ─────────────────────────────────────────────────────────────
const IDLE        = 'idle'
const SCANNING    = 'scanning'
const COMPLETE    = 'complete'
const DOWNLOADING = 'downloading'
const DONE        = 'done'
const ERROR       = 'error'

export default function ReceivePage() {
  const [phase,    setPhase]    = useState(IDLE)
  const [progress, setProgress] = useState({ known: 0, total: 0 })
  const [filename, setFilename] = useState('')
  const [errorMsg, setErrorMsg] = useState('')
  const [scanned,  setScanned]  = useState(0)   // raw QR frames decoded (including dupes)

  // Persistent across renders without causing re-renders
  const seenRef    = useRef(new Set())   // deduplicate seeds
  const sha256Ref  = useRef('')          // sha256 for download gate
  const wsRef      = useRef(null)        // ReceiverSocket control object
  const phaseRef   = useRef(IDLE)        // mirror of phase for callbacks

  // Keep phaseRef in sync
  useEffect(() => { phaseRef.current = phase }, [phase])

  // ── cleanup on unmount ────────────────────────────────────────────────────────
  useEffect(() => {
    return () => { wsRef.current?.close() }
  }, [])

  // ── helpers ───────────────────────────────────────────────────────────────────

  function enterError(msg) {
    wsRef.current?.close()
    wsRef.current = null
    setPhase(ERROR)
    setErrorMsg(msg)
  }

  function reset() {
    wsRef.current?.close()
    wsRef.current = null
    seenRef.current.clear()
    sha256Ref.current = ''
    setPhase(IDLE)
    setProgress({ known: 0, total: 0 })
    setFilename('')
    setErrorMsg('')
    setScanned(0)
  }

  // ── trigger browser save from a Blob ─────────────────────────────────────────
  function saveBlobAs(blob, name) {
    const url = URL.createObjectURL(blob)
    const a   = document.createElement('a')
    a.href     = url
    a.download = name
    a.click()
    // Revoke after a short delay so the browser has time to start the download
    setTimeout(() => URL.revokeObjectURL(url), 2000)
  }

  // ── download sequence ─────────────────────────────────────────────────────────
  async function triggerDownload() {
    setPhase(DOWNLOADING)
    try {
      const blob = await downloadFile(sha256Ref.current)
      saveBlobAs(blob, filename || 'received_file')
      setPhase(DONE)
    } catch (err) {
      // hash_mismatch → keep scanning; stale_transfer → tell user to restart
      if (err.error === 'hash_mismatch') {
        // Server has reset the decoder — go back to scanning
        setPhase(SCANNING)
      } else {
        enterError(err.message ?? 'Download failed')
      }
    }
  }

  // ── start scanning ────────────────────────────────────────────────────────────
  async function startScanning() {
    seenRef.current.clear()

    // Fetch metadata to get sha256 + filename + k before opening the camera
    let meta
    try {
      meta = await getMetadata()
    } catch {
      enterError('Could not reach the server. Is the backend running?')
      return
    }

    if (!meta) {
      enterError('No active transfer found. Ask the sender to upload a file first.')
      return
    }

    sha256Ref.current = meta.sha256
    setFilename(meta.filename)
    setProgress({ known: meta.progress, total: meta.k })

    // Open receiver WebSocket for live progress pushes
    const ws = openReceiverSocket(
      (msg) => {
        // Progress push from server after each successful symbol
        setProgress({ known: msg.progress, total: msg.k })
        setScanned(n => n + 1)

        if (msg.complete && phaseRef.current === SCANNING) {
          wsRef.current?.close()
          wsRef.current = null
          setPhase(COMPLETE)
        }
      },
      (msg) => {
        if (phaseRef.current === SCANNING)
          enterError(msg.detail ?? 'Receiver WebSocket error')
      }
    )

    wsRef.current = ws
    setPhase(SCANNING)
  }

  // ── onDecode — called by CameraCapture for every QR frame ────────────────────
  const onDecode = useCallback((bytes) => {
    // Only process while actively scanning
    if (phaseRef.current !== SCANNING) return

    const packet = decodePacket(bytes)
    if (!packet) return  // bad CRC or wrong format — skip silently

    const { seed, payload, crc } = packet

    // Deduplicate — fountain coding sends every seed many times
    if (seenRef.current.has(seed)) return
    seenRef.current.add(seed)

    // Fire-and-forget — don't await in the scan callback (would block rAF)
    postSymbol(seed, payload, crc).catch(err => {
      // Log but don't crash — a single failed POST shouldn't stop scanning
      console.warn('postSymbol failed:', err.message)
    })
  }, [])

  // ── render ────────────────────────────────────────────────────────────────────

  const pct = progress.total > 0
    ? Math.round((progress.known / progress.total) * 100)
    : 0

  return (
    <div className="min-h-screen bg-gray-950 text-white flex flex-col">
      {/* ── top bar ── */}
      <header className="flex items-center gap-4 px-6 py-4 border-b border-gray-800">
        <Link to="/" className="text-gray-400 hover:text-white transition-colors text-sm">
          ← Back
        </Link>
        <h1 className="text-lg font-semibold">Receive a File</h1>
        {filename && (
          <span className="ml-auto text-xs text-gray-500 truncate max-w-xs">
            {filename}
          </span>
        )}
      </header>

      <main className="flex-1 flex flex-col items-center justify-center gap-6 px-4 py-8">

        {/* ── IDLE ── */}
        {phase === IDLE && (
          <div className="flex flex-col items-center gap-6 text-center max-w-sm">
            <div className="text-6xl">📡</div>
            <div>
              <h2 className="text-xl font-semibold mb-2">Ready to receive</h2>
              <p className="text-gray-400 text-sm">
                Make sure the sender has uploaded a file, then point your camera
                at their screen.
              </p>
            </div>
            <button
              id="btn-start-scan"
              onClick={startScanning}
              className="w-full py-4 px-6 rounded-2xl bg-emerald-600 hover:bg-emerald-500 font-semibold text-lg transition-colors duration-200"
            >
              Start Scanning
            </button>
          </div>
        )}

        {/* ── SCANNING ── */}
        {phase === SCANNING && (
          <div className="flex flex-col items-center gap-5 w-full max-w-sm">
            {/* Camera viewfinder */}
            <CameraCapture onDecode={onDecode} active={true} />

            {/* Progress bar */}
            <ProgressBar known={progress.known} total={progress.total} />

            {/* Stats */}
            <div className="flex gap-6 text-sm text-gray-400">
              <span>QR decoded: <strong className="text-white">{scanned}</strong></span>
              <span>Unique: <strong className="text-white">{seenRef.current.size}</strong></span>
              <span className="text-emerald-400 font-semibold">{pct}%</span>
            </div>

            <button
              id="btn-stop-scan"
              onClick={reset}
              className="text-sm text-gray-500 hover:text-gray-300 transition-colors underline"
            >
              Cancel
            </button>
          </div>
        )}

        {/* ── COMPLETE ── */}
        {phase === COMPLETE && (
          <div className="flex flex-col items-center gap-6 text-center max-w-sm">
            <div className="text-6xl animate-bounce">✅</div>
            <div>
              <h2 className="text-xl font-semibold mb-2">Transfer complete!</h2>
              <p className="text-gray-400 text-sm">
                All {progress.total} blocks received. Your file is ready.
              </p>
            </div>
            <button
              id="btn-download"
              onClick={triggerDownload}
              className="w-full py-4 px-6 rounded-2xl bg-emerald-600 hover:bg-emerald-500 font-semibold text-lg transition-colors duration-200"
            >
              ⬇ Download {filename}
            </button>
            <button onClick={reset} className="text-sm text-gray-500 hover:text-gray-300 underline">
              Receive another file
            </button>
          </div>
        )}

        {/* ── DOWNLOADING ── */}
        {phase === DOWNLOADING && (
          <div className="flex flex-col items-center gap-4">
            <div className="w-12 h-12 border-4 border-emerald-500 border-t-transparent rounded-full animate-spin" />
            <p className="text-gray-400">Verifying and downloading…</p>
          </div>
        )}

        {/* ── DONE ── */}
        {phase === DONE && (
          <div className="flex flex-col items-center gap-6 text-center max-w-sm">
            <div className="text-6xl">🎉</div>
            <div>
              <h2 className="text-xl font-semibold mb-2">File saved!</h2>
              <p className="text-gray-400 text-sm">
                {filename} was transferred and saved successfully.
              </p>
            </div>
            <button
              id="btn-receive-another"
              onClick={reset}
              className="w-full py-4 px-6 rounded-2xl bg-gray-800 hover:bg-gray-700 font-semibold text-lg transition-colors duration-200"
            >
              Receive another file
            </button>
          </div>
        )}

        {/* ── ERROR ── */}
        {phase === ERROR && (
          <div className="flex flex-col items-center gap-4 text-center max-w-sm">
            <div className="text-5xl">⚠️</div>
            <p className="text-red-400 font-medium">{errorMsg}</p>
            <button
              id="btn-retry"
              onClick={reset}
              className="py-2 px-6 rounded-xl bg-gray-800 hover:bg-gray-700 text-sm transition-colors"
            >
              Try again
            </button>
          </div>
        )}

      </main>
    </div>
  )
}
