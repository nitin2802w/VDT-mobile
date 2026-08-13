/**
 * api.js
 *
 * All network calls in one place. Page components import helpers from here —
 * never raw fetch or WebSocket constructors directly. This makes it trivial
 * to change the base URL or swap transports later.
 *
 * All fetch calls use relative paths (e.g. /api/upload) which Vite's dev
 * proxy forwards to http://127.0.0.1:8000. No base URL constant needed.
 *
 * Error shapes from the backend:
 *   - 409 download errors use a flat JSON body: { error, message }
 *     (backend returns JSONResponse directly, not HTTPException)
 *   - 4xx/5xx from other endpoints use FastAPI's default { detail } wrapper
 */

/**
 * uploadFile(file) → Promise<UploadMeta>
 *
 * POST /api/upload — uploads the file, triggers state reset on the server.
 *
 * Returns: { filename, file_size, block_size, k, sha256 }
 *
 * @param {File} file
 */
export async function uploadFile(file) {
  const form = new FormData()
  form.append('file', file)
  const res = await fetch('/api/upload', { method: 'POST', body: form })
  if (!res.ok) throw new Error(`Upload failed: ${res.status} ${res.statusText}`)
  return res.json()
}

/**
 * getMetadata() → Promise<Metadata | null>
 *
 * GET /api/metadata — lightweight status poll, safe to call before upload.
 *
 * Returns: { filename, file_size, block_size, k, sha256, progress, complete }
 *   or null if no transfer is active (404).
 */
export async function getMetadata() {
  const res = await fetch('/api/metadata')
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`Metadata fetch failed: ${res.status}`)
  return res.json()
}

/**
 * postSymbol(seed, payload, crc) → Promise<SymbolResult>
 *
 * POST /api/symbol — submits one decoded fountain symbol to the server decoder.
 *
 * Returns: { progress, k, complete, dropped }
 *
 * @param {number}     seed    - symbol_seed integer (uint32)
 * @param {Uint8Array} payload - raw XOR'd block bytes
 * @param {number}     crc     - CRC-32 (uint32) from the decoded packet
 */
export async function postSymbol(seed, payload, crc) {
  // Uint8Array must be base64-encoded for JSON transport.
  // btoa(String.fromCharCode(...)) is safe for payloads up to ~400 bytes
  // (the chosen BLOCK_SIZE). For larger payloads, use a chunked version.
  const b64 = btoa(String.fromCharCode(...payload))
  const res = await fetch('/api/symbol', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seed, payload: b64, crc }),
  })
  if (!res.ok) throw new Error(`Symbol post failed: ${res.status}`)
  return res.json()
}

/**
 * downloadFile(expectedSha256) → Promise<Blob>
 *
 * GET /api/download?expected_sha256=<hex> — downloads the reconstructed file
 * once decoding is complete.
 *
 * Throws a typed error on 409 with the backend's flat error shape attached:
 *   err.error   → "stale_transfer" | "not_complete" | "hash_mismatch"
 *   err.message → human-readable description
 *
 * ReceivePage.jsx uses err.error to decide whether to restart or keep listening.
 *
 * @param {string} expectedSha256 - hex SHA-256 returned by /api/upload
 * @returns {Promise<Blob>}
 */
export async function downloadFile(expectedSha256) {
  const res = await fetch(`/api/download?expected_sha256=${expectedSha256}`)
  if (!res.ok) {
    // Backend returns flat JSON: { error: "...", message: "..." }
    // (not wrapped in FastAPI's { detail: ... } envelope)
    const body = await res.json()
    throw Object.assign(new Error(body.error ?? 'Download failed'), body)
  }
  return res.blob()
}

/**
 * openSenderSocket(onSymbol, onWaiting, onError) → SenderSocket
 *
 * Connects to WS /api/ws/sender. Returns a control object.
 *
 * onSymbol  : ({ seed, payload, crc }) => void
 *   payload here is the raw base64 string from the server — call
 *   Uint8Array.from(atob(msg.payload), c => c.charCodeAt(0)) to get bytes.
 *
 * onWaiting : ({ reason }) => void   — server has no active transfer yet
 * onError   : ({ type, detail }) => void
 *
 * Control object:
 *   .start(fps?)  — begin/resume streaming at fps (default 10)
 *   .pause()      — stop symbol flow until next start()
 *   .stop()       — close connection
 *
 * @returns {{ start: (fps?: number) => void, pause: () => void, stop: () => void }}
 */
export function openSenderSocket(onSymbol, onWaiting, onError) {
  const ws = new WebSocket('/api/ws/sender')

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data)
      if (msg.type === 'symbol')  onSymbol?.(msg)
      else if (msg.type === 'waiting') onWaiting?.(msg)
      else if (msg.type === 'error')   onError?.(msg)
    } catch {
      onError?.({ type: 'error', detail: 'Malformed message from sender socket' })
    }
  }

  ws.onerror = () => onError?.({ type: 'error', detail: 'Sender WebSocket error' })

  return {
    start(fps = 10) {
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ action: 'start', fps }))
    },
    pause() {
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ action: 'pause' }))
    },
    stop() {
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ action: 'stop' }))
      ws.close()
    },
  }
}

/**
 * openReceiverSocket(onProgress, onError) → ReceiverSocket
 *
 * Connects to WS /api/ws/receiver. The server pushes a progress event every
 * time a symbol is successfully decoded, so the UI updates without polling.
 *
 * onProgress : ({ progress, k, complete }) => void
 * onError    : ({ type, detail }) => void
 *
 * @returns {{ close: () => void }}
 */
export function openReceiverSocket(onProgress, onError) {
  const ws = new WebSocket('/api/ws/receiver')

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data)
      if (msg.type === 'progress') onProgress?.(msg)
      else if (msg.type === 'error') onError?.(msg)
      // 'connected' confirmation — no action needed
    } catch {
      onError?.({ type: 'error', detail: 'Malformed message from receiver socket' })
    }
  }

  ws.onerror = () => onError?.({ type: 'error', detail: 'Receiver WebSocket error' })

  return {
    close() { ws.close() },
  }
}
