import type { OutputCodec } from '../protocol/types'

/**
 * Downlink decoding and painting.
 *
 * MJPEG sessions deliver standalone JPEGs, which `createImageBitmap` handles.
 * H.264 sessions deliver Annex B packets from the server's PyAV encoder; those
 * need WebCodecs, and only the first keyframe onward is decodable.
 */
export interface FrameRenderer {
  push(data: Uint8Array, isKeyframe: boolean): void
  close(): void
}

export interface RendererCallbacks {
  /** Fired per painted frame so the UI can count real output FPS. */
  onPainted?: () => void
  onError?: (message: string) => void
}

class MjpegRenderer implements FrameRenderer {
  private closed = false
  /** Serialises decodes so frames cannot be painted out of order. */
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private canvas: HTMLCanvasElement,
    private callbacks: RendererCallbacks,
  ) {}

  push(data: Uint8Array): void {
    if (this.closed) return
    // Copy: the caller's view may be backed by a buffer that gets reused.
    const blob = new Blob([data.slice().buffer], { type: 'image/jpeg' })
    this.queue = this.queue
      .then(async () => {
        if (this.closed) return
        const bitmap = await createImageBitmap(blob)
        this.paint(bitmap)
        bitmap.close()
      })
      .catch((cause) => this.callbacks.onError?.(`JPEG decode failed: ${cause}`))
  }

  private paint(bitmap: ImageBitmap): void {
    if (this.canvas.width !== bitmap.width || this.canvas.height !== bitmap.height) {
      this.canvas.width = bitmap.width
      this.canvas.height = bitmap.height
    }
    const ctx = this.canvas.getContext('2d', { alpha: false })
    ctx?.drawImage(bitmap, 0, 0)
    this.callbacks.onPainted?.()
  }

  close(): void {
    this.closed = true
  }
}

class H264Renderer implements FrameRenderer {
  private decoder: VideoDecoder | null = null
  private configured = false
  /** Annex B decoding cannot start mid-GOP, so packets before the first key are dropped. */
  private sawKeyframe = false
  private timestamp = 0

  constructor(
    private canvas: HTMLCanvasElement,
    private callbacks: RendererCallbacks,
    private width: number,
    private height: number,
  ) {}

  private ensureDecoder(): VideoDecoder | null {
    if (this.decoder) return this.decoder
    if (typeof VideoDecoder === 'undefined') {
      this.callbacks.onError?.('WebCodecs is unavailable; switch the output codec to MJPEG')
      return null
    }
    this.decoder = new VideoDecoder({
      output: (frame) => {
        this.paint(frame)
        frame.close()
      },
      error: (cause) => this.callbacks.onError?.(`H.264 decode failed: ${cause.message}`),
    })
    // No `description` => Annex B, which is what the server's PyAV encoder emits.
    this.decoder.configure({
      codec: 'avc1.42E01E',
      codedWidth: this.width,
      codedHeight: this.height,
      optimizeForLatency: true,
    })
    this.configured = true
    return this.decoder
  }

  push(data: Uint8Array, isKeyframe: boolean): void {
    const decoder = this.ensureDecoder()
    if (!decoder || decoder.state === 'closed') return
    if (!this.sawKeyframe) {
      if (!isKeyframe) return
      this.sawKeyframe = true
    }
    this.timestamp += 1000
    try {
      decoder.decode(
        new EncodedVideoChunk({
          type: isKeyframe ? 'key' : 'delta',
          timestamp: this.timestamp,
          data: data.slice(),
        }),
      )
    } catch (cause) {
      this.callbacks.onError?.(`H.264 chunk rejected: ${cause}`)
    }
  }

  private paint(frame: VideoFrame): void {
    const width = frame.displayWidth || this.width
    const height = frame.displayHeight || this.height
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width
      this.canvas.height = height
    }
    const ctx = this.canvas.getContext('2d', { alpha: false })
    ctx?.drawImage(frame, 0, 0)
    this.callbacks.onPainted?.()
  }

  close(): void {
    if (this.decoder && this.configured && this.decoder.state !== 'closed') {
      this.decoder.close()
    }
    this.decoder = null
  }
}

export function createRenderer(
  codec: OutputCodec,
  canvas: HTMLCanvasElement,
  callbacks: RendererCallbacks,
  width: number,
  height: number,
): FrameRenderer {
  return codec === 'h264'
    ? new H264Renderer(canvas, callbacks, width, height)
    : new MjpegRenderer(canvas, callbacks)
}

export const hasWebCodecs = typeof VideoDecoder !== 'undefined'
