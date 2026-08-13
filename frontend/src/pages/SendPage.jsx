/**
 * SendPage.jsx — Phase F3
 *
 * State machine:
 *   idle       → user sees file drop zone, no WebSocket open
 *   uploading  → POST /api/upload in flight
 *   streaming  → upload done, WebSocket open, QR codes flashing
 *   paused     → user hit pause; WebSocket open but server stopped sending
 *   error      → any unrecoverable failure
 *
 * Symbol flow:
 *   openSenderSocket.onSymbol fires → convert base64 payload to Uint8Array
 *   → store as currentSymbol state → QRRenderer re-renders the canvas.
 *   The server already paces symbols at the requested FPS; we do NOT need
 *   a client-side timer — just render whatever arrives.
 *
 * Cleanup:
 *   socketRef.current.stop() is called in a useEffect cleanup so the
 *   WebSocket closes if the user navigates away mid-stream.
 */

import { useState, useRef, useCallback, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { uploadFile, openSenderSocket } from '../lib/api'
import QRRenderer from '../components/QRRenderer'

// ── constants ─────────────────────────────────────────────────────────────────
const MIN_FPS = 1
const MAX_FPS = 30
const DEFAULT_FPS = 10

// ── state machine values ──────────────────────────────────────────────────────
const IDLE      = 'idle'
const UPLOADING = 'uploading'
const STREAMING = 'streaming'
const PAUSED    = 'paused'
const ERROR     = 'error'

export default function SendPage() {
  const [phase, setPhase]               = useState(IDLE)
  const [fps, setFps]                   = useState(DEFAULT_FPS)
  const [meta, setMeta]                 = useState(null)     // upload response
  const [currentSymbol, setCurrentSymbol] = useState(null)  // { seed, payload (Uint8Array), crc }
  const [errorMsg, setErrorMsg]         = useState('')
  const [symbolCount, setSymbolCount]   = useState(0)

  const socketRef  = useRef(null)   // SenderSocket control object
  const fileRef    = useRef(null)   // hidden <input type="file"> ref
  const dragActive = useRef(false)

  // ── cleanup on unmount / navigation ──────────────────────────────────────────
  useEffect(() => {
    return () => {
      socketRef.current?.stop()
    }
  }, [])

  // ── helpers ───────────────────────────────────────────────────────────────────

  function enterError(msg) {
    socketRef.current?.stop()
    socketRef.current = null
    setPhase(ERROR)
    setErrorMsg(msg)
  }

  function decodeSymbolPayload(b64) {
    return Uint8Array.from(atob(b64), c => c.charCodeAt(0))
  }

  // ── upload + socket open ──────────────────────────────────────────────────────

  const handleFile = useCallback(async (file) => {
    if (!file) return
    setPhase(UPLOADING)
    setMeta(null)
    setCurrentSymbol(null)
    setSymbolCount(0)
    socketRef.current?.stop()
    socketRef.current = null

    try {
      const uploadMeta = await uploadFile(file)
      setMeta(uploadMeta)

      // Open sender WebSocket and immediately start streaming
      const socket = openSenderSocket(
        // onSymbol — convert base64 payload to Uint8Array and push to renderer
        (msg) => {
          const payload = decodeSymbolPayload(msg.payload)
          setCurrentSymbol({ seed: msg.seed, payload, crc: msg.crc })
          setSymbolCount(n => n + 1)
        },
        // onWaiting — server has no transfer? Shouldn't happen here but handle gracefully
        () => {
          // Server may briefly send 'waiting' before registering our upload — ignore
        },
        // onError
        (msg) => enterError(msg.detail ?? 'WebSocket error from sender')
      )

      socketRef.current = socket
      setPhase(STREAMING)
      socket.start(fps)

    } catch (err) {
      enterError(err.message ?? 'Upload failed')
    }
  }, [fps])

  // ── drag-and-drop ─────────────────────────────────────────────────────────────

  function onDrop(e) {
    e.preventDefault()
    dragActive.current = false
    const file = e.dataTransfer.files?.[0]
    if (file) handleFile(file)
  }

  function onDragOver(e) {
    e.preventDefault()
    dragActive.current = true
  }

  // ── play / pause ──────────────────────────────────────────────────────────────

  function togglePlay() {
    if (phase === STREAMING) {
      socketRef.current?.pause()
      setPhase(PAUSED)
    } else if (phase === PAUSED) {
      socketRef.current?.start(fps)
      setPhase(STREAMING)
    }
  }

  // ── fps slider change ─────────────────────────────────────────────────────────

  function onFpsChange(e) {
    const newFps = Number(e.target.value)
    setFps(newFps)
    if (phase === STREAMING) {
      // Re-send start with new fps to update server pacing
      socketRef.current?.start(newFps)
    }
  }

  // ── reset to idle ─────────────────────────────────────────────────────────────

  function reset() {
    socketRef.current?.stop()
    socketRef.current = null
    setPhase(IDLE)
    setMeta(null)
    setCurrentSymbol(null)
    setSymbolCount(0)
    setErrorMsg('')
  }

  // ── render ────────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gray-950 text-white flex flex-col">
      {/* ── top bar ── */}
      <header className="flex items-center gap-4 px-6 py-4 border-b border-gray-800">
        <Link to="/" className="text-gray-400 hover:text-white transition-colors text-sm">
          ← Back
        </Link>
        <h1 className="text-lg font-semibold">Send a File</h1>
        {meta && (
          <span className="ml-auto text-xs text-gray-500 truncate max-w-xs">
            {meta.filename} · {(meta.file_size / 1024).toFixed(1)} KB · {meta.k} blocks
          </span>
        )}
      </header>

      {/* ── main content ── */}
      <main className="flex-1 flex flex-col items-center justify-center gap-8 px-4 py-8">

        {/* ── IDLE: drop zone ── */}
        {phase === IDLE && (
          <div
            onDrop={onDrop}
            onDragOver={onDragOver}
            onDragLeave={() => { dragActive.current = false }}
            onClick={() => fileRef.current?.click()}
            className="w-full max-w-md border-2 border-dashed border-gray-700 hover:border-indigo-500 rounded-3xl p-16 flex flex-col items-center gap-4 cursor-pointer transition-colors duration-200 group"
          >
            <div className="text-5xl select-none">📂</div>
            <p className="text-gray-300 text-center font-medium group-hover:text-white transition-colors">
              Drop a file here, or click to browse
            </p>
            <p className="text-gray-600 text-sm">Max 10 MB</p>
            <input
              ref={fileRef}
              type="file"
              id="file-input"
              className="hidden"
              onChange={e => handleFile(e.target.files?.[0])}
            />
          </div>
        )}

        {/* ── UPLOADING: spinner ── */}
        {phase === UPLOADING && (
          <div className="flex flex-col items-center gap-4">
            <div className="w-12 h-12 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin" />
            <p className="text-gray-400">Uploading…</p>
          </div>
        )}

        {/* ── STREAMING / PAUSED: QR flipbook ── */}
        {(phase === STREAMING || phase === PAUSED) && (
          <div className="flex flex-col items-center gap-6 w-full max-w-sm">

            {/* QR canvas */}
            <div className={`rounded-2xl overflow-hidden shadow-2xl transition-opacity duration-200 ${phase === PAUSED ? 'opacity-40' : 'opacity-100'}`}>
              <QRRenderer
                seed={currentSymbol?.seed}
                payload={currentSymbol?.payload}
                size={280}
                ecLevel="M"
              />
            </div>

            {/* Stats bar */}
            <div className="flex gap-6 text-sm text-gray-400">
              <span>Symbols sent: <strong className="text-white">{symbolCount}</strong></span>
              <span>FPS: <strong className="text-white">{fps}</strong></span>
            </div>

            {/* Play / Pause button */}
            <button
              id="btn-playpause"
              onClick={togglePlay}
              className={`w-full py-3 px-6 rounded-2xl font-semibold text-lg transition-colors duration-200
                ${phase === STREAMING
                  ? 'bg-yellow-600 hover:bg-yellow-500'
                  : 'bg-indigo-600 hover:bg-indigo-500'}`}
            >
              {phase === STREAMING ? '⏸ Pause' : '▶ Resume'}
            </button>

            {/* FPS slider */}
            <div className="w-full">
              <div className="flex justify-between text-xs text-gray-500 mb-1">
                <span>{MIN_FPS} fps</span>
                <span className="text-gray-300">Speed: {fps} fps</span>
                <span>{MAX_FPS} fps</span>
              </div>
              <input
                id="fps-slider"
                type="range"
                min={MIN_FPS}
                max={MAX_FPS}
                step="1"
                value={fps}
                onChange={onFpsChange}
                className="w-full accent-indigo-500"
              />
            </div>

            {/* Upload a different file */}
            <button
              id="btn-new-file"
              onClick={reset}
              className="text-sm text-gray-500 hover:text-gray-300 transition-colors underline"
            >
              Upload a different file
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
