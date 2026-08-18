import type { SourceKind } from '../protocol/types'

export interface SourceInfo {
  kind: SourceKind
  label: string
  width: number
  height: number
}

/**
 * Owns whatever is producing source frames — webcam, screen share, or a local
 * video file — behind one `<video>` element the capture loop can sample.
 */
export class FrameSource {
  readonly video: HTMLVideoElement
  private stream: MediaStream | null = null
  private objectUrl: string | null = null
  private kind: SourceKind = 'camera'
  private label = ''

  constructor() {
    this.video = document.createElement('video')
    this.video.playsInline = true
    this.video.muted = true
    this.video.autoplay = true
  }

  get info(): SourceInfo | null {
    if (!this.video.videoWidth) return null
    return {
      kind: this.kind,
      label: this.label,
      width: this.video.videoWidth,
      height: this.video.videoHeight,
    }
  }

  /** True once the element has decodable pixels; the capture loop must not run before this. */
  get ready(): boolean {
    return this.video.readyState >= 2 && this.video.videoWidth > 0
  }

  get isFile(): boolean {
    return this.kind === 'file'
  }

  async useCamera(deviceId?: string, width = 1280, height = 720): Promise<void> {
    this.release()
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        width: { ideal: width },
        height: { ideal: height },
      },
      audio: false,
    })
    this.stream = stream
    this.kind = 'camera'
    this.label = stream.getVideoTracks()[0]?.label ?? 'camera'
    this.video.srcObject = stream
    this.video.loop = false
    await this.play()
  }

  async useScreen(): Promise<void> {
    this.release()
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
    this.stream = stream
    this.kind = 'screen'
    this.label = stream.getVideoTracks()[0]?.label ?? 'screen'
    this.video.srcObject = stream
    this.video.loop = false
    await this.play()
  }

  async useFile(file: File): Promise<void> {
    this.release()
    this.objectUrl = URL.createObjectURL(file)
    this.kind = 'file'
    this.label = file.name
    this.video.srcObject = null
    this.video.src = this.objectUrl
    this.video.loop = true
    await this.play()
  }

  private async play(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onReady = () => {
        cleanup()
        resolve()
      }
      const onError = () => {
        cleanup()
        reject(new Error('failed to load video source'))
      }
      const cleanup = () => {
        this.video.removeEventListener('loadeddata', onReady)
        this.video.removeEventListener('error', onError)
      }
      if (this.ready) {
        resolve()
        return
      }
      this.video.addEventListener('loadeddata', onReady)
      this.video.addEventListener('error', onError)
    })
    await this.video.play().catch(() => {
      /* autoplay rejection is harmless; the capture loop samples on demand */
    })
  }

  /** Available camera devices. Labels are only populated after permission is granted. */
  static async listCameras(): Promise<MediaDeviceInfo[]> {
    if (!navigator.mediaDevices?.enumerateDevices) return []
    const devices = await navigator.mediaDevices.enumerateDevices()
    return devices.filter((device) => device.kind === 'videoinput')
  }

  release(): void {
    this.stream?.getTracks().forEach((track) => track.stop())
    this.stream = null
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl)
      this.objectUrl = null
    }
    this.video.removeAttribute('src')
    this.video.srcObject = null
  }
}
