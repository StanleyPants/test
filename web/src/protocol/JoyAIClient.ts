import type {
  ClientMessage,
  HealthResponse,
  OutputFrameMessage,
  RefImagesResponse,
  ServerMessage,
  StartMessage,
} from './types'

export type ConnectionState =
  | 'idle'
  | 'connecting'
  | 'queued'
  | 'granted'
  | 'streaming'
  | 'closed'
  | 'error'

/** An `output_frame` header joined with the binary payload that followed it. */
export interface DecodedOutputFrame {
  meta: OutputFrameMessage
  data: Uint8Array
}

export interface JoyAIClientEvents {
  state: (state: ConnectionState, detail?: string) => void
  /** Any control message, already parsed — used for stats and status surfaces. */
  message: (message: ServerMessage) => void
  frame: (frame: DecodedOutputFrame) => void
  /** Round-trip time and server-estimated uplink delay, in ms. */
  latency: (rttMs: number, uplinkMs: number | null) => void
  error: (message: string) => void
}

type Listeners = { [K in keyof JoyAIClientEvents]: Set<JoyAIClientEvents[K]> }

const PING_INTERVAL_MS = 1000
/** The server releases an idle holder after 10s, so ack/ping must outpace that. */
const ACK_INTERVAL_MS = 250

export interface JoyAIClientOptions {
  /** Base HTTP origin of the JoyAI server, e.g. `http://gpu-box:8080`. Empty means same-origin. */
  baseUrl: string
}

/**
 * Transport client for a JoyAI streaming session.
 *
 * Owns the socket, the JSON/binary pairing, and the flow-control chatter the
 * server expects. It deliberately knows nothing about codecs or rendering:
 * frames go in as encoded bytes and come out as encoded bytes.
 */
export class JoyAIClient {
  private ws: WebSocket | null = null
  private listeners: Listeners = {
    state: new Set(),
    message: new Set(),
    frame: new Set(),
    latency: new Set(),
    error: new Set(),
  }

  /** Header awaiting its binary payload. */
  private pendingFrameHeader: OutputFrameMessage | null = null
  private pingTimer: number | null = null
  private ackTimer: number | null = null
  private seq = 0
  private framesReceived = 0
  private lastAckSent = -1
  private state: ConnectionState = 'idle'

  constructor(private options: JoyAIClientOptions) {}

  get connectionState(): ConnectionState {
    return this.state
  }

  /** Output frames received since the current session started (the server's flow-control input). */
  get receivedFrameCount(): number {
    return this.framesReceived
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  on<K extends keyof JoyAIClientEvents>(event: K, handler: JoyAIClientEvents[K]): () => void {
    this.listeners[event].add(handler as never)
    return () => {
      this.listeners[event].delete(handler as never)
    }
  }

  private emit<K extends keyof JoyAIClientEvents>(
    event: K,
    ...args: Parameters<JoyAIClientEvents[K]>
  ): void {
    for (const handler of this.listeners[event]) {
      ;(handler as (...a: unknown[]) => void)(...args)
    }
  }

  private setState(state: ConnectionState, detail?: string): void {
    this.state = state
    this.emit('state', state, detail)
  }

  private httpUrl(path: string): string {
    const base = this.options.baseUrl.replace(/\/$/, '')
    return `${base}${path}`
  }

  private wsUrl(): string {
    const base = this.options.baseUrl.replace(/\/$/, '')
    if (!base) {
      const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
      return `${scheme}//${location.host}/ws`
    }
    return `${base.replace(/^http/, 'ws')}/ws`
  }

  async health(): Promise<HealthResponse> {
    const response = await fetch(this.httpUrl('/health'))
    if (!response.ok) throw new Error(`health check failed: HTTP ${response.status}`)
    return (await response.json()) as HealthResponse
  }

  async refImages(): Promise<RefImagesResponse> {
    const response = await fetch(this.httpUrl('/ref-images'))
    if (!response.ok) throw new Error(`ref-images failed: HTTP ${response.status}`)
    return (await response.json()) as RefImagesResponse
  }

  /** Warms the model. On a cold server this can take minutes, so it is fire-and-forget. */
  async preload(): Promise<void> {
    await fetch(this.httpUrl('/load'), { method: 'POST' })
  }

  downloadUrl(): string {
    return this.httpUrl('/download_last')
  }

  connect(): Promise<void> {
    this.disconnect()
    this.setState('connecting')

    return new Promise((resolve, reject) => {
      let socket: WebSocket
      try {
        socket = new WebSocket(this.wsUrl())
      } catch (cause) {
        this.setState('error', String(cause))
        reject(cause instanceof Error ? cause : new Error(String(cause)))
        return
      }
      socket.binaryType = 'arraybuffer'
      this.ws = socket

      socket.onopen = () => {
        // The server may hold us in the queue; `session_granted` is the real go signal.
        this.setState('queued')
        this.startKeepalive()
        resolve()
      }
      socket.onerror = () => {
        const message = 'websocket error - is the JoyAI server reachable?'
        this.emit('error', message)
        this.setState('error', message)
        reject(new Error(message))
      }
      socket.onclose = (event) => {
        this.stopKeepalive()
        this.setState('closed', event.reason || undefined)
      }
      socket.onmessage = (event) => this.handleMessage(event)
    })
  }

  disconnect(): void {
    this.stopKeepalive()
    const socket = this.ws
    this.ws = null
    this.pendingFrameHeader = null
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      socket.onclose = null
      socket.close()
    }
  }

  private handleMessage(event: MessageEvent): void {
    if (typeof event.data !== 'string') {
      // Binary payloads are only meaningful directly after an `output_frame`
      // header. Anything else is a protocol desync; drop it rather than guess.
      const header = this.pendingFrameHeader
      this.pendingFrameHeader = null
      if (!header) return
      this.framesReceived += 1
      this.emit('frame', { meta: header, data: new Uint8Array(event.data as ArrayBuffer) })
      return
    }

    let message: ServerMessage
    try {
      message = JSON.parse(event.data) as ServerMessage
    } catch {
      this.emit('error', 'received malformed JSON from server')
      return
    }

    switch (message.type) {
      case 'output_frame':
        this.pendingFrameHeader = message
        return // not surfaced as a control message; the pairing above handles it
      case 'session_granted':
        this.setState('granted')
        break
      case 'queue_position':
        this.setState('queued', `position ${message.position}`)
        break
      case 'started':
        this.setState('streaming')
        break
      case 'session_timeout':
        this.setState('closed', message.message)
        break
      case 'pong': {
        const rtt = Date.now() - message.t
        this.emit('latency', rtt, message.up_ms)
        break
      }
      case 'error':
        this.emit('error', message.message)
        break
    }
    this.emit('message', message)
  }

  private send(message: ClientMessage): void {
    if (!this.isOpen) return
    this.ws!.send(JSON.stringify(message))
  }

  /**
   * Opens a session. Resets the flow-control counters, because the server
   * rebases its own `frames_out` baseline on every `start`.
   */
  startSession(options: Omit<StartMessage, 'type'>): void {
    this.seq = 0
    this.framesReceived = 0
    this.lastAckSent = -1
    this.pendingFrameHeader = null
    this.send({ type: 'start', ...options })
  }

  stopSession(): void {
    this.send({ type: 'stop' })
  }

  finalizeRecording(): void {
    this.send({ type: 'finalize_recording' })
  }

  setOutputQuality(value: number): void {
    this.send({ type: 'set_output_quality', value })
  }

  /** Sends one encoded source frame, labelled so the server can report end-to-end latency. */
  sendFrame(data: ArrayBuffer | Uint8Array, captureMs = Date.now()): void {
    if (!this.isOpen) return
    this.seq += 1
    this.send({ type: 'frame_meta', seq: this.seq, t_capture_ms: captureMs })
    this.ws!.send(data as ArrayBuffer)
  }

  private startKeepalive(): void {
    this.stopKeepalive()
    this.pingTimer = window.setInterval(() => {
      this.send({ type: 'ping', t: Date.now(), recv: this.framesReceived })
    }, PING_INTERVAL_MS)
    // Acks drive the server's congestion controller: without them it assumes
    // the worst and starts dropping whole chunks.
    this.ackTimer = window.setInterval(() => {
      if (this.framesReceived === this.lastAckSent) return
      this.lastAckSent = this.framesReceived
      this.send({ type: 'ack', recv: this.framesReceived })
    }, ACK_INTERVAL_MS)
  }

  private stopKeepalive(): void {
    if (this.pingTimer !== null) window.clearInterval(this.pingTimer)
    if (this.ackTimer !== null) window.clearInterval(this.ackTimer)
    this.pingTimer = null
    this.ackTimer = null
  }
}
