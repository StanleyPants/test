import { useEffect, useRef, useState } from 'react'
import { FrameSource } from '../media/source'
import type { SessionController } from '../state/useSession'

interface Props {
  session: SessionController
}

const CONNECTED_STATES = new Set(['queued', 'granted', 'streaming'])

/** Server address, connection lifecycle, and source selection. */
export function ConnectionBar({ session }: Props) {
  const { settings, update, status, actions, stats } = session
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([])
  const fileInput = useRef<HTMLInputElement | null>(null)
  const connected = CONNECTED_STATES.has(status.connection)

  useEffect(() => {
    FrameSource.listCameras().then(setCameras).catch(() => setCameras([]))
  }, [status.connection])

  return (
    <header className="connection-bar">
      <div className="brand">
        <span className="brand-mark">JoyAI</span>
        <span className="brand-sub">realtime video edit</span>
      </div>

      <label className="field field-grow">
        <span>Server</span>
        <input
          type="text"
          value={settings.serverUrl}
          placeholder="same origin (dev proxy) or http://gpu-host:8080"
          onChange={(event) => update('serverUrl', event.target.value.trim())}
          disabled={connected}
        />
      </label>

      {connected ? (
        <button onClick={actions.disconnect}>Disconnect</button>
      ) : (
        <button className="primary" onClick={actions.connect}>
          Connect
        </button>
      )}
      <button onClick={actions.preload} title="Warm the model before streaming (can take minutes cold)">
        Preload
      </button>

      <div className="divider" />

      <label className="field">
        <span>Camera</span>
        <select
          onChange={(event) => actions.selectCamera(event.target.value || undefined)}
          defaultValue=""
        >
          <option value="">Default camera</option>
          {cameras.map((camera, index) => (
            <option key={camera.deviceId} value={camera.deviceId}>
              {camera.label || `Camera ${index + 1}`}
            </option>
          ))}
        </select>
      </label>
      <button onClick={() => actions.selectCamera()}>Use camera</button>
      <button onClick={actions.selectScreen}>Share screen</button>
      <button onClick={() => fileInput.current?.click()}>Open video...</button>
      <input
        ref={fileInput}
        type="file"
        accept="video/*"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) actions.selectFile(file)
          event.target.value = ''
        }}
      />

      <div className="conn-status">
        <span className={`dot dot-${status.connection}`} />
        <span>{status.connection}</span>
        {stats.queuePosition !== null && <span className="muted">queue #{stats.queuePosition}</span>}
        {status.health && (
          <span className="muted" title={String(status.health.dit_ckpt ?? '')}>
            {status.health.runtime_loaded ? 'model loaded' : 'model cold'}
            {status.health.device ? ` · ${status.health.device}` : ''}
          </span>
        )}
      </div>
    </header>
  )
}
