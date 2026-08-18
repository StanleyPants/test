import type { SessionController } from '../state/useSession'

interface Props {
  session: SessionController
}

function format(value: number | null, unit: string, digits = 0): string {
  if (value === null || Number.isNaN(value)) return '--'
  return `${value.toFixed(digits)}${unit}`
}

/** Live throughput and latency readout. */
export function StatsHud({ session }: Props) {
  const { stats, status, downloadUrl, actions, isStreaming } = session

  const cells: Array<[string, string, string?]> = [
    ['Uplink', format(stats.uplinkFps, ' fps', 1), 'frames sent to the server per second'],
    ['Downlink', format(stats.downlinkFps, ' fps', 1), 'edited frames painted per second'],
    ['RTT', format(stats.rttMs, ' ms'), 'websocket round trip'],
    ['Uplink delay', format(stats.uplinkMs, ' ms'), 'server-estimated one-way upload delay'],
    ['Glass-to-glass', format(stats.glassToGlassMs, ' ms'), 'capture to painted edited frame'],
    ['Chunk time', format(stats.lastChunkElapsedMs, ' ms'), 'server time for the last chunk'],
    ['Frames in/out', `${stats.serverFramesIn} / ${stats.serverFramesOut}`, 'server-side counters'],
    ['Dropped', String(stats.chunksDropped), 'chunks dropped due to downlink congestion'],
  ]

  return (
    <section className="stats-hud">
      <div className="stats-grid">
        {cells.map(([label, value, title]) => (
          <div className="stat" key={label} title={title}>
            <span className="stat-label">{label}</span>
            <span className="stat-value">{value}</span>
          </div>
        ))}
      </div>

      <div className="stats-actions">
        <button onClick={actions.finalizeRecording} disabled={!isStreaming}>
          Finalize recording
        </button>
        <a className="button-link" href={downloadUrl} target="_blank" rel="noreferrer">
          Download last clip
        </a>
      </div>

      {status.errors.length > 0 && (
        <ul className="error-log">
          {status.errors.map((error, index) => (
            <li key={`${error}-${index}`}>{error}</li>
          ))}
        </ul>
      )}
    </section>
  )
}
