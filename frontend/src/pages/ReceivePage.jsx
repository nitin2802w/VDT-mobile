/**
 * ReceivePage.jsx — Phase O6 (Native Filesystem)
 *
 * State machine:
 *   idle     → "Start Scanning" button
 *   scanning → camera open, frames being fed to ReceiverSession
 *   complete → isComplete flipped; getResult() running (shows "Verifying…")
 *   done     → SHA-256 verified, file saved to disk
 *   error    → camera failure
 *
 * No backend. No WebSocket. No getMetadata() API call.
 * File metadata (k, blockSize, filename, sha256) arrives via the QR stream
 * itself in 0x01 METADATA frames — ReceiverSession handles all of this.
 *
 * Key correctness guarantees preserved from O3:
 *   - onDecode is guarded: if phase !== 'scanning', frames are dropped.
 *     This prevents triggerSave() from firing repeatedly on every subsequent
 *     frame after isComplete flips (sender keeps flashing, camera keeps decoding).
 *   - 'complete' is the "Verifying…" holding state while getResult() runs.
 *     We do NOT optimistically jump to 'done' before the SHA-256 check passes.
 *   - If getResult() returns null (hash mismatch), the decoder has already
 *     reset internally — we return to 'scanning' and keep going.
 */

import { useState, useRef, useCallback, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { Capacitor } from '@capacitor/core'
import { Filesystem, Directory } from '@capacitor/filesystem'
import { ReceiverSession } from '../lib/receiverSession'
import CameraCapture from '../components/CameraCapture'
import ProgressBar   from '../components/ProgressBar'

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Convert Uint8Array → base64 string.
 * @capacitor/filesystem writeFile requires base64 data, not raw bytes.
 */
function uint8ToBase64(bytes) {
  let binary = ''
  // Process in chunks to avoid call-stack overflow on large files.
  const chunkSize = 8192
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

/**
 * saveFile(bytes, filename)
 *
 * On Android (Capacitor native context): writes the bytes to Documents/
 * using @capacitor/filesystem so the file actually lands on disk.
 *
 * In a browser (desktop testing): falls back to the standard Blob/anchor
 * click, which triggers the browser's native Save dialog.
 *
 * @param {Uint8Array} bytes
 * @param {string} filename
 * @returns {Promise<string>} Human-readable save location message.
 */
async function saveFile(bytes, filename) {
  if (Capacitor.isNativePlatform()) {
    const base64 = uint8ToBase64(bytes)
    await Filesystem.writeFile({
      path: filename,
      data: base64,
      directory: Directory.Documents,
      recursive: false,
    })
    return `Saved to Documents/${filename}`
  } else {
    // Browser fallback for desktop testing.
    const url = URL.createObjectURL(new Blob([bytes]))
    const a   = document.createElement('a')
    a.href     = url
    a.download = filename
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 2000)
    return `Downloaded as ${filename}`
  }
}

// ── state machine ─────────────────────────────────────────────────────────────
const IDLE     = 'idle'
const SCANNING = 'scanning'
const COMPLETE = 'complete'   // isComplete true; SHA-256 verification in flight
const DONE     = 'done'       // verified + saved
const ERROR    = 'error'

export default function ReceivePage() {
  const [phase,    setPhase]    = useState(IDLE)
  const [progress, setProgress] = useState({ known: 0, total: 0 })
  const [filename, setFilename] = useState('')
  const [errorMsg, setErrorMsg] = useState('')
  const [scanned,  setScanned]  = useState(0)
  const [saveMsg,  setSaveMsg]  = useState('')  // where the file was saved

  const sessionRef = useRef(null)
  const phaseRef   = useRef(IDLE)   // mirror for callbacks that close over stale phase

  useEffect(() => { phaseRef.current = phase }, [phase])

  // ── cleanup on unmount ────────────────────────────────────────────────────────
  useEffect(() => {
    return () => { sessionRef.current?.reset() }
  }, [])

  // ── helpers ───────────────────────────────────────────────────────────────────

  function enterError(msg) {
    setPhase(ERROR)
    setErrorMsg(msg)
  }

  function reset() {
    sessionRef.current?.reset()
    sessionRef.current = null
    setPhase(IDLE)
    setProgress({ known: 0, total: 0 })
    setFilename('')
    setErrorMsg('')
    setScanned(0)
  }


  // ── start scanning ────────────────────────────────────────────────────────────

  function startScanning() {
    sessionRef.current = new ReceiverSession()
    setPhase(SCANNING)
    // No getMetadata() — k/blockSize/filename/sha256 arrive via 0x01 QR frames.
  }

  // ── complete phase: run getResult() once isComplete flips ─────────────────────

  useEffect(() => {
    if (phase !== COMPLETE) return
    let cancelled = false

    sessionRef.current.getResult().then(async result => {
      if (cancelled) return

      if (!result) {
        // SHA-256 mismatch — ReceiverSession reset decoder internally.
        // Return to scanning; fresh symbols will re-resolve the affected blocks.
        setPhase(SCANNING)
        return
      }

      try {
        const msg = await saveFile(result.bytes, result.filename)
        setSaveMsg(msg)
        setPhase(DONE)
      } catch (err) {
        // Native filesystem write failed (e.g. storage permission denied).
        enterError(`Could not save file: ${err.message ?? err}`)
      }
    })

    return () => { cancelled = true }
  }, [phase])

  // ── onDecode — called by CameraCapture for every decoded QR frame ──────────

  const onDecode = useCallback((bytes) => {
    // GUARD: only process frames while actively scanning.
    // Prevents triggerSave() from firing on every frame after isComplete, since
    // the sender loops forever and the camera keeps decoding.
    if (phaseRef.current !== SCANNING) return

    const session = sessionRef.current
    session.handleDecodedFrame(bytes)
    setScanned(n => n + 1)

    // Update progress from session getters (synchronous — no await needed).
    const known = session.progress
    const total = session.totalBlocks
    setProgress({ known, total })

    // If filename arrived via metadata, surface it in the header.
    if (session.state !== 'WAITING' && session._meta?.filename) {
      setFilename(session._meta.filename)
    }

    if (session.isComplete) {
      // Transition to 'complete' — the useEffect above picks this up and
      // calls getResult(). Shows "Verifying…" UI while the SHA-256 runs.
      setPhase(COMPLETE)
    }
  }, [])

  // ── progress percentage ───────────────────────────────────────────────────────

  const pct = progress.total > 0
    ? Math.round((progress.known / progress.total) * 100)
    : 0

  // ── render ────────────────────────────────────────────────────────────────────

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
                Point your camera at the sender's screen. No internet needed —
                everything transfers via QR codes.
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
            <CameraCapture onDecode={onDecode} active={true} />

            <ProgressBar known={progress.known} total={progress.total} />

            <div className="flex gap-6 text-sm text-gray-400">
              <span>QR decoded: <strong className="text-white">{scanned}</strong></span>
              <span>Blocks: <strong className="text-white">{progress.known}/{progress.total}</strong></span>
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

        {/* ── COMPLETE: verifying SHA-256 ── */}
        {phase === COMPLETE && (
          <div className="flex flex-col items-center gap-4">
            <div className="w-12 h-12 border-4 border-emerald-500 border-t-transparent rounded-full animate-spin" />
            <p className="text-gray-400">Verifying integrity…</p>
          </div>
        )}

        {/* ── DONE ── */}
        {phase === DONE && (
          <div className="flex flex-col items-center gap-6 text-center max-w-sm">
            <div className="text-6xl">🎉</div>
                      <div>
              <h2 className="text-xl font-semibold mb-2">File saved!</h2>
              <p className="text-gray-400 text-sm">
                {filename} transferred and verified successfully.
              </p>
              {saveMsg && (
                <p className="text-emerald-400 text-xs mt-2 font-mono">{saveMsg}</p>
              )}
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
