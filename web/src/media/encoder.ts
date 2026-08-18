/**
 * Uplink encoding.
 *
 * The server sniffs the first uplink frame's magic bytes, so plain JPEG is
 * always safe: it downgrades an `input_codec: "h264"` session to MJPEG on its
 * own. We therefore encode JPEG, which every browser can do synchronously off
 * a canvas, and let the server's sniffing sort out the rest.
 */

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement

function createCanvas(width: number, height: number): AnyCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

/** Scales `source` to fill `target` without distortion, cropping the overflow. */
function coverRect(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
): [number, number, number, number] {
  const scale = Math.max(targetWidth / sourceWidth, targetHeight / sourceHeight)
  const drawWidth = sourceWidth * scale
  const drawHeight = sourceHeight * scale
  return [(targetWidth - drawWidth) / 2, (targetHeight - drawHeight) / 2, drawWidth, drawHeight]
}

export class JpegEncoder {
  private canvas: AnyCanvas
  private ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

  constructor(
    private width: number,
    private height: number,
    private quality = 0.8,
  ) {
    this.canvas = createCanvas(width, height)
    const ctx = this.canvas.getContext('2d', { alpha: false, desynchronized: true })
    if (!ctx) throw new Error('2D canvas context unavailable')
    this.ctx = ctx as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D
  }

  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return
    this.width = width
    this.height = height
    this.canvas.width = width
    this.canvas.height = height
  }

  setQuality(quality: number): void {
    this.quality = Math.min(1, Math.max(0.05, quality))
  }

  get size(): { width: number; height: number } {
    return { width: this.width, height: this.height }
  }

  async encode(source: CanvasImageSource, sourceWidth: number, sourceHeight: number): Promise<Uint8Array> {
    const [x, y, w, h] = coverRect(sourceWidth, sourceHeight, this.width, this.height)
    this.ctx.drawImage(source, x, y, w, h)

    if (typeof OffscreenCanvas !== 'undefined' && this.canvas instanceof OffscreenCanvas) {
      const blob = await this.canvas.convertToBlob({ type: 'image/jpeg', quality: this.quality })
      return new Uint8Array(await blob.arrayBuffer())
    }
    const canvas = this.canvas as HTMLCanvasElement
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', this.quality),
    )
    if (!blob) throw new Error('JPEG encoding failed')
    return new Uint8Array(await blob.arrayBuffer())
  }
}
