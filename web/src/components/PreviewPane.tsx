import { useEffect, useRef } from 'react'
import type { SessionController } from '../state/useSession'

interface Props {
  session: SessionController
}

/** Side-by-side source and edited output. */
export function PreviewPane({ session }: Props) {
  const sourceHost = useRef<HTMLDivElement | null>(null)
  const { sourceVideo, sourceInfo, outputCanvasRef, isStreaming, status } = session

  // The <video> lives in the FrameSource (it must survive re-renders and be
  // sampled by the capture loop), so it is adopted into the DOM here.
  useEffect(() => {
    const host = sourceHost.current
    if (!host) return
    sourceVideo.className = 'preview-media'
    host.appendChild(sourceVideo)
    return () => {
      if (sourceVideo.parentElement === host) host.removeChild(sourceVideo)
    }
  }, [sourceVideo])

  return (
    <div className="preview-pane">
      <figure className="preview">
        <figcaption>
          <span>Source</span>
          <span className="muted">
            {sourceInfo ? `${sourceInfo.width}x${sourceInfo.height} · ${sourceInfo.label}` : 'no source'}
          </span>
        </figcaption>
        <div className="preview-frame" ref={sourceHost}>
          {!sourceInfo && <div className="placeholder">Choose a camera, screen, or video file</div>}
        </div>
      </figure>

      <figure className="preview">
        <figcaption>
          <span>Edited</span>
          <span className="muted">
            {isStreaming ? status.message : 'idle'}
          </span>
        </figcaption>
        <div className="preview-frame">
          <canvas ref={outputCanvasRef} className="preview-media" />
          {!isStreaming && <div className="placeholder">Start a session to see edited frames</div>}
          {status.gateHold && <div className="gate-badge">{status.gateHold}</div>}
        </div>
      </figure>
    </div>
  )
}
