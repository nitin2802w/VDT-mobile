/**
 * SendPage.jsx — Phase O4 (Offline)
 *
 * State machine:
 *   idle      → file drop zone
 *   encoding  → file.arrayBuffer() + SenderSession.create() in flight
 *   streaming → session running, QR frames flashing
 *   paused    → session paused, QR dimmed
 *   error     → any failure
 *
 * The backend and WebSocket are gone. All encoding happens locally via
 * SenderSession. QRRenderer receives raw Uint8Array frame bytes directly —
 * no seed/payload splitting, no re-encode.
 */

import { useState, useRef, useCallback, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { SenderSession } from '../lib/senderSession'
import QRRenderer from '../components/QRRenderer'

// ── constants ─────────────────────────────────────────────────────────────────
const MIN_FPS     = 1
const MAX_FPS     = 30
const DEFAULT_FPS = 10
const BLOCK_SIZE  = 400

// ── state machine ─────────────────────────────────────────────────────────────
const IDLE      = 'idle'
const ENCODING  = 'encoding'
const STREAMING = 'streaming'
const PAUSED    = 'paused'
const ERROR     = 'error'

export default function SendPage() {
  const [phase,         setPhase]         = useState(IDLE)
  const [fps,           setFps]           = useState(DEFAULT_FPS)
  const [fileInfo,      setFileInfo]      = useState(null)   // { name, sizeKb, k }
  const [currentFrame,  setCurrentFrame]  = useState(null)   // Uint8Array | null
  const [frameCount,    setFrameCount]    = useState(0)
  const [errorMsg,      setErrorMsg]      = useState('')

  const sessionRef = useRef(null)
  const fileRef    = useRef(null)

  // ── cleanup on unmount ────────────────────────────────────────────────────────
  useEffect(() => {
    return () => sessionRef.current?.stop()
  }, [])

  // ── helpers ───────────────────────────────────────────────────────────────────

  function enterError(msg) {
    sessionRef.current?.stop()
    sessionRef.current = null
    setPhase(ERROR)
    setErrorMsg(msg)
  }

  function reset() {
    sessionRef.current?.stop()
    sessionRef.current = null
    setPhase(IDLE)
    setFileInfo(null)
    setCurrentFrame(null)
    setFrameCount(0)
    setErrorMsg('')
  }

  // ── file handling ─────────────────────────────────────────────────────────────

  const handleFile = useCallback(async (file) => {
    if (!file) return
    reset()
    setPhase(ENCODING)

    try {
      const bytes   = new Uint8Array(await file.arrayBuffer())
      const session = await SenderSession.create(file.name, bytes, BLOCK_SIZE)
      sessionRef.current = session

      // Expose file stats for the header bar.
      // k is encoded inside the metadata frame; read it from the encoder.
      setFileInfo({
        name:   file.name,
        sizeKb: (bytes.length / 1024).toFixed(1),
        k:      session._encoder.k,
      })

      // onFrame: called on every tick with the next ready-to-render Uint8Array.
      // Data frames and metadata frames both arrive here identically.
      const onFrame = (frameBytes) => {
        setCurrentFrame(frameBytes)
        setFrameCount(n => n + 1)
      }

      session.start(onFrame, DEFAULT_FPS)
      setPhase(STREAMING)

    } catch (err) {
      enterError(err.message ?? 'Failed to encode file')
    }
  }, [])

  // ── drag-and-drop ─────────────────────────────────────────────────────────────

  function onDrop(e) {
    e.preventDefault()
    handleFile(e.dataTransfer.files?.[0])
  }

  function onDragOver(e) { e.preventDefault() }

  // ── play / pause ──────────────────────────────────────────────────────────────

  function togglePlay() {
    if (phase === STREAMING) {
      sessionRef.current?.pause()
      setPhase(PAUSED)
    } else if (phase === PAUSED) {
      // start() is idempotent — does NOT reset seed counter or interleave position.
      sessionRef.current?.start(
        (frameBytes) => { setCurrentFrame(frameBytes); setFrameCount(n => n + 1) },
        fps
      )
      setPhase(STREAMING)
    }
  }

  // ── fps slider ────────────────────────────────────────────────────────────────

  function onFpsChange(e) {
    const newFps = Number(e.target.value)
    setFps(newFps)
    // setFps adjusts the interval in-place — no stop/restart needed.
    sessionRef.current?.setFps(newFps)
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
        {fileInfo && (
          <span className="ml-auto text-xs text-gray-500 truncate max-w-xs">
            {fileInfo.name} · {fileInfo.sizeKb} KB · {fileInfo.k} blocks
          </span>
        )}
      </header>

      {/* ── main ── */}
      <main className="flex-1 flex flex-col items-center justify-center gap-8 px-4 py-8">

        {/* ── IDLE: drop zone ── */}
        {phase === IDLE && (
          <div
            onDrop={onDrop}
            onDragOver={onDragOver}
            onClick={() => fileRef.current?.click()}
            className="w-full max-w-md border-2 border-dashed border-gray-700 hover:border-indigo-500 rounded-3xl p-16 flex flex-col items-center gap-4 cursor-pointer transition-colors duration-200 group"
          >
            <div className="text-5xl select-none">📂</div>
            <p className="text-gray-300 text-center font-medium group-hover:text-white transition-colors">
              Drop a file here, or click to browse
            </p>
            <p className="text-gray-600 text-sm">Any file · Transferred via QR codes</p>
            <input
              ref={fileRef}
              type="file"
              id="file-input"
              className="hidden"
              onChange={e => handleFile(e.target.files?.[0])}
            />
          </div>
        )}

        {/* ── ENCODING: spinner ── */}
        {phase === ENCODING && (
          <div className="flex flex-col items-center gap-4">
            <div className="w-12 h-12 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin" />
            <p className="text-gray-400">Encoding…</p>
          </div>
        )}

        {/* ── STREAMING / PAUSED: QR flipbook ── */}
        {(phase === STREAMING || phase === PAUSED) && (
          <div className="flex flex-col items-center gap-6 w-full max-w-sm">

            {/* QR canvas — receives raw frame bytes, renders both data + metadata */}
            <div className={`rounded-2xl overflow-hidden shadow-2xl transition-opacity duration-200 ${phase === PAUSED ? 'opacity-40' : 'opacity-100'}`}>
              <QRRenderer
                frameBytes={currentFrame}
                size={280}
                ecLevel="M"
              />
            </div>

            {/* Stats */}
            <div className="flex gap-6 text-sm text-gray-400">
              <span>Frames sent: <strong className="text-white">{frameCount}</strong></span>
              <span>FPS: <strong className="text-white">{fps}</strong></span>
            </div>

            {/* Play / Pause */}
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

            <button
              id="btn-new-file"
              onClick={reset}
              className="text-sm text-gray-500 hover:text-gray-300 transition-colors underline"
            >
              Choose a different file
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
