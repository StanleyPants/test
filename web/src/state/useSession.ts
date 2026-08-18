import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { JoyAIClient, type ConnectionState } from '../protocol/JoyAIClient'
import type { HealthResponse, PromptEnhancedMessage, ServerMessage } from '../protocol/types'
import { FrameSource, type SourceInfo } from '../media/source'
import { JpegEncoder } from '../media/encoder'
import { createRenderer, type FrameRenderer } from '../media/renderer'
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type SessionSettings } from './settings'

export interface SessionStats {
  /** Frames per second we are pushing to the server. */
  uplinkFps: number
  /** Frames per second actually painted from the server. */
  downlinkFps: number
  framesSent: number
  framesReceived: number
  /** Server-side counters from `chunk_done`. */
  serverFramesIn: number
  serverFramesOut: number
  rttMs: number | null
  uplinkMs: number | null
  /** Capture -> paint, measured from the `t_capture_ms` we stamped on the source frame. */
  glassToGlassMs: number | null
  chunksDropped: number
  queuePosition: number | null
  /** Server-reported time to produce the last chunk. */
  lastChunkElapsedMs: number | null
}

const EMPTY_STATS: SessionStats = {
  uplinkFps: 0,
  downlinkFps: 0,
  framesSent: 0,
  framesReceived: 0,
  serverFramesIn: 0,
  serverFramesOut: 0,
  rttMs: null,
  uplinkMs: null,
  glassToGlassMs: null,
  chunksDropped: 0,
  queuePosition: null,
  lastChunkElapsedMs: null,
}

export interface SessionStatus {
  connection: ConnectionState
  /** Human-readable line for the status bar. */
  message: string
  /** Set while the presence gate is holding edits back. */
  gateHold: string | null
  promptEnhanced: PromptEnhancedMessage | null
  health: HealthResponse | null
  errors: string[]
}

/** Rolling-window rate counter. */
class RateMeter {
  private stamps: number[] = []
  mark(now = performance.now()): void {
    this.stamps.push(now)
    const cutoff = now - 2000
    while (this.stamps.length && this.stamps[0] < cutoff) this.stamps.shift()
  }
  get rate(): number {
    if (this.stamps.length < 2) return 0
    const span = this.stamps[this.stamps.length - 1] - this.stamps[0]
    return span > 0 ? ((this.stamps.length - 1) * 1000) / span : 0
  }
  reset(): void {
    this.stamps = []
  }
}

export function useJoyAISession() {
  const [settings, setSettings] = useState<SessionSettings>(() => loadSettings())
  const [status, setStatus] = useState<SessionStatus>({
    connection: 'idle',
    message: 'Not connected',
    gateHold: null,
    promptEnhanced: null,
    health: null,
    errors: [],
  })
  const [stats, setStats] = useState<SessionStats>(EMPTY_STATS)
  const [sourceInfo, setSourceInfo] = useState<SourceInfo | null>(null)
  const [refImages, setRefImages] = useState<Record<string, string>>({})
  const [isStreaming, setIsStreaming] = useState(false)

  const outputCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const clientRef = useRef<JoyAIClient | null>(null)
  const sourceRef = useRef<FrameSource | null>(null)
  const encoderRef = useRef<JpegEncoder | null>(null)
  const rendererRef = useRef<FrameRenderer | null>(null)
  const captureTimerRef = useRef<number | null>(null)
  const uplinkMeter = useRef(new RateMeter())
  const downlinkMeter = useRef(new RateMeter())
  const statsRef = useRef<SessionStats>(EMPTY_STATS)
  // Settings are read inside long-lived callbacks; a ref keeps them current
  // without tearing down the capture loop on every keystroke.
  const settingsRef = useRef(settings)

  useEffect(() => {
    settingsRef.current = settings
    saveSettings(settings)
  }, [settings])

  if (!sourceRef.current) sourceRef.current = new FrameSource()

  const pushError = useCallback((message: string) => {
    setStatus((prev) => ({ ...prev, errors: [...prev.errors.slice(-4), message] }))
  }, [])

  const mergeStats = useCallback((patch: Partial<SessionStats>) => {
    statsRef.current = { ...statsRef.current, ...patch }
    setStats(statsRef.current)
  }, [])

  const client = useMemo(() => {
    clientRef.current?.disconnect()
    const next = new JoyAIClient({ baseUrl: settings.serverUrl })
    clientRef.current = next
    return next
    // Intentionally keyed on the URL alone: a new server means a new client.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.serverUrl])

  const update = useCallback(<K extends keyof SessionSettings>(key: K, value: SessionSettings[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }))
  }, [])

  const updateMany = useCallback((patch: Partial<SessionSettings>) => {
    setSettings((prev) => ({ ...prev, ...patch }))
  }, [])

  const resetSettings = useCallback(() => setSettings(DEFAULT_SETTINGS), [])

  /* ------------------------------------------------------------------ *
   * Capture loop
   * ------------------------------------------------------------------ */

  const stopCapture = useCallback(() => {
    if (captureTimerRef.current !== null) {
      window.clearInterval(captureTimerRef.current)
      captureTimerRef.current = null
    }
  }, [])

  const startCapture = useCallback(() => {
    stopCapture()
    const source = sourceRef.current!
    let busy = false

    captureTimerRef.current = window.setInterval(
      async () => {
        const active = clientRef.current
        const encoder = encoderRef.current
        if (busy || !active?.isOpen || !encoder || !source.ready) return

        // Uplink backpressure. Frames queued ahead of the server are pure
        // added latency, so cap the queue at half a second's worth: deep
        // enough to keep the server's chunk filler fed, shallow enough that
        // glass-to-glass stays responsive.
        const inFlight = statsRef.current.framesSent - statsRef.current.serverFramesIn
        if (inFlight > Math.max(4, Math.round(settingsRef.current.fps / 2))) return

        busy = true
        try {
          const bytes = await encoder.encode(
            source.video,
            source.video.videoWidth,
            source.video.videoHeight,
          )
          active.sendFrame(bytes, Date.now())
          uplinkMeter.current.mark()
          mergeStats({
            framesSent: statsRef.current.framesSent + 1,
            uplinkFps: uplinkMeter.current.rate,
          })
        } catch (cause) {
          pushError(`frame encode failed: ${cause}`)
        } finally {
          busy = false
        }
      },
      Math.max(10, Math.round(1000 / Math.max(1, settingsRef.current.fps))),
    )
  }, [mergeStats, pushError, stopCapture])

  /* ------------------------------------------------------------------ *
   * Server events
   * ------------------------------------------------------------------ */

  useEffect(() => {
    const offState = client.on('state', (connection, detail) => {
      setStatus((prev) => ({
        ...prev,
        connection,
        message: detail ? `${connection} - ${detail}` : connection,
      }))
      if (connection === 'closed' || connection === 'error') {
        setIsStreaming(false)
        stopCapture()
      }
    })

    const offError = client.on('error', pushError)

    const offLatency = client.on('latency', (rttMs, uplinkMs) => {
      mergeStats({ rttMs, uplinkMs })
    })

    const offFrame = client.on('frame', ({ meta, data }) => {
      rendererRef.current?.push(data, meta.key)
      downlinkMeter.current.mark()
      const glassToGlass = meta.t_capture_ms ? Date.now() - meta.t_capture_ms : null
      mergeStats({
        framesReceived: statsRef.current.framesReceived + 1,
        downlinkFps: downlinkMeter.current.rate,
        glassToGlassMs: glassToGlass,
      })
    })

    const offMessage = client.on('message', (message: ServerMessage) => {
      switch (message.type) {
        case 'started': {
          // The server snaps the requested size to the VAE stride and may
          // refuse the codec we asked for, so the renderer follows its reply.
          const canvas = outputCanvasRef.current
          rendererRef.current?.close()
          if (canvas) {
            rendererRef.current = createRenderer(
              message.output_codec,
              canvas,
              { onPainted: () => undefined, onError: pushError },
              message.width,
              message.height,
            )
          }
          encoderRef.current?.resize(message.width, message.height)
          setIsStreaming(true)
          setStatus((prev) => ({
            ...prev,
            gateHold: null,
            message: `streaming ${message.width}x${message.height} · up ${message.input_codec} · down ${message.output_codec}`,
          }))
          startCapture()
          break
        }
        case 'queue_position':
          mergeStats({ queuePosition: message.position })
          break
        case 'session_granted':
          mergeStats({ queuePosition: null })
          break
        case 'chunk_start':
          mergeStats({ lastChunkElapsedMs: message.elapsed * 1000 })
          break
        case 'chunk_done':
          mergeStats({ serverFramesIn: message.frames_in, serverFramesOut: message.frames_out })
          setStatus((prev) => (prev.gateHold ? { ...prev, gateHold: null } : prev))
          break
        case 'accepted':
          mergeStats({ serverFramesIn: message.frames_in, serverFramesOut: message.frames_out })
          break
        case 'flow_drop':
          mergeStats({ chunksDropped: message.dropped_total })
          break
        case 'no_person':
          setStatus((prev) => ({ ...prev, gateHold: `waiting for subject (${message.reason})` }))
          break
        case 'waiting_face':
          setStatus((prev) => ({ ...prev, gateHold: 'waiting for a face to enter frame' }))
          break
        case 'pe_running':
          setStatus((prev) => ({ ...prev, message: 'enhancing prompt...' }))
          break
        case 'prompt_enhanced':
          setStatus((prev) => ({ ...prev, promptEnhanced: message }))
          break
        case 'session_reset':
          setStatus((prev) => ({ ...prev, message: `session reset (${message.reason ?? 'unknown'})` }))
          break
        case 'recording_finalized':
          setStatus((prev) => ({
            ...prev,
            message: message.ok
              ? 'recording finalized - ready to download'
              : `recording unavailable: ${message.message ?? 'unknown reason'}`,
          }))
          break
      }
    })

    return () => {
      offState()
      offError()
      offLatency()
      offFrame()
      offMessage()
    }
  }, [client, mergeStats, pushError, startCapture, stopCapture])

  /* ------------------------------------------------------------------ *
   * Actions
   * ------------------------------------------------------------------ */

  const refreshHealth = useCallback(async () => {
    try {
      const health = await client.health()
      setStatus((prev) => ({ ...prev, health }))
      return health
    } catch (cause) {
      pushError(`health check failed: ${cause}`)
      return null
    }
  }, [client, pushError])

  const loadRefImages = useCallback(async () => {
    try {
      setRefImages(await client.refImages())
    } catch {
      /* the server only exposes these when its reference dir is populated */
    }
  }, [client])

  const connect = useCallback(async () => {
    try {
      await client.connect()
      void refreshHealth()
      void loadRefImages()
    } catch (cause) {
      pushError(`connect failed: ${cause}`)
    }
  }, [client, loadRefImages, pushError, refreshHealth])

  const disconnect = useCallback(() => {
    stopCapture()
    rendererRef.current?.close()
    rendererRef.current = null
    setIsStreaming(false)
    client.disconnect()
  }, [client, stopCapture])

  const start = useCallback(() => {
    const current = settingsRef.current
    const source = sourceRef.current!
    if (!source.ready) {
      pushError('no source selected - pick a camera, screen, or video file first')
      return
    }
    if (!client.isOpen) {
      pushError('not connected to a JoyAI server')
      return
    }

    encoderRef.current = new JpegEncoder(current.width, current.height, current.uplinkQuality)
    uplinkMeter.current.reset()
    downlinkMeter.current.reset()
    statsRef.current = { ...EMPTY_STATS }
    setStats(statsRef.current)
    setStatus((prev) => ({ ...prev, promptEnhanced: null, gateHold: null }))

    client.startSession({
      prompt: current.prompt,
      ref_image: current.refImage,
      width: current.width,
      height: current.height,
      fps: current.fps,
      seed: current.seed,
      num_inference_steps: current.numInferenceSteps,
      output_quality: current.outputQuality,
      output_codec: current.outputCodec,
      input_codec: 'mjpeg',
      source: source.isFile ? 'file' : current.source,
      kv_reset_frames: current.kvResetFrames,
      max_temporal_ids: current.maxTemporalIds,
      freeze_kv_on_static: current.freezeKvOnStatic,
      static_diff_thresh: current.staticDiffThresh,
      max_inflight_chunks: current.maxInflightChunks,
      use_pe: current.usePe,
      gate_enabled: current.gateEnabled,
      profile_timings: current.profileTimings,
    })
  }, [client, pushError])

  const stop = useCallback(() => {
    stopCapture()
    client.stopSession()
    rendererRef.current?.close()
    rendererRef.current = null
    setIsStreaming(false)
    setStatus((prev) => ({ ...prev, message: 'stopped' }))
  }, [client, stopCapture])

  /** Applies a prompt change without dropping the connection: restart the session in place. */
  const applyPrompt = useCallback(() => {
    if (!isStreaming) return
    start()
  }, [isStreaming, start])

  const finalizeRecording = useCallback(() => client.finalizeRecording(), [client])

  const downloadUrl = useMemo(() => client.downloadUrl(), [client])

  const setOutputQuality = useCallback(
    (value: number) => {
      update('outputQuality', value)
      if (isStreaming) client.setOutputQuality(value)
    },
    [client, isStreaming, update],
  )

  const selectCamera = useCallback(
    async (deviceId?: string) => {
      try {
        await sourceRef.current!.useCamera(deviceId)
        update('source', 'camera')
        setSourceInfo(sourceRef.current!.info)
      } catch (cause) {
        pushError(`camera unavailable: ${cause}`)
      }
    },
    [pushError, update],
  )

  const selectScreen = useCallback(async () => {
    try {
      await sourceRef.current!.useScreen()
      update('source', 'screen')
      setSourceInfo(sourceRef.current!.info)
    } catch (cause) {
      pushError(`screen capture unavailable: ${cause}`)
    }
  }, [pushError, update])

  const selectFile = useCallback(
    async (file: File) => {
      try {
        await sourceRef.current!.useFile(file)
        update('source', 'file')
        setSourceInfo(sourceRef.current!.info)
      } catch (cause) {
        pushError(`could not open ${file.name}: ${cause}`)
      }
    },
    [pushError, update],
  )

  useEffect(() => {
    const source = sourceRef.current!
    return () => {
      stopCapture()
      rendererRef.current?.close()
      source.release()
      clientRef.current?.disconnect()
    }
  }, [stopCapture])

  return {
    settings,
    update,
    updateMany,
    resetSettings,
    status,
    stats,
    sourceInfo,
    refImages,
    isStreaming,
    sourceVideo: sourceRef.current!.video,
    outputCanvasRef,
    downloadUrl,
    actions: {
      connect,
      disconnect,
      start,
      stop,
      applyPrompt,
      finalizeRecording,
      setOutputQuality,
      selectCamera,
      selectScreen,
      selectFile,
      refreshHealth,
      preload: () => client.preload().catch((cause) => pushError(`preload failed: ${cause}`)),
    },
  }
}

export type SessionController = ReturnType<typeof useJoyAISession>
