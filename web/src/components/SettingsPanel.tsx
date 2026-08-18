import { RESOLUTION_PRESETS } from '../state/settings'
import { hasWebCodecs } from '../media/renderer'
import type { SessionController } from '../state/useSession'

interface Props {
  session: SessionController
}

/** Streaming, sampling, and gating controls. */
export function SettingsPanel({ session }: Props) {
  const { settings, update, updateMany, resetSettings, actions, isStreaming } = session

  return (
    <aside className="settings-panel">
      <div className="settings-head">
        <h2>Settings</h2>
        <button className="link" onClick={resetSettings}>
          Reset
        </button>
      </div>

      <fieldset>
        <legend>Output</legend>
        <div className="preset-row">
          {RESOLUTION_PRESETS.map((preset) => {
            const active =
              settings.width === preset.width &&
              settings.height === preset.height &&
              settings.fps === preset.fps
            return (
              <button
                key={preset.label}
                className={`chip ${active ? 'chip-active' : ''}`}
                title={preset.note}
                onClick={() =>
                  updateMany({ width: preset.width, height: preset.height, fps: preset.fps })
                }
              >
                {preset.label}
              </button>
            )
          })}
        </div>
        <p className="hint">
          The server snaps size to the VAE stride, so the effective resolution may differ slightly.
        </p>

        <label className="field">
          <span>Width</span>
          <input
            type="number"
            min={256}
            step={8}
            value={settings.width}
            onChange={(event) => update('width', Number(event.target.value))}
          />
        </label>
        <label className="field">
          <span>Height</span>
          <input
            type="number"
            min={256}
            step={8}
            value={settings.height}
            onChange={(event) => update('height', Number(event.target.value))}
          />
        </label>
        <label className="field">
          <span>FPS</span>
          <input
            type="number"
            min={1}
            max={60}
            value={settings.fps}
            onChange={(event) => update('fps', Number(event.target.value))}
          />
        </label>

        <label className="field">
          <span>Downlink codec</span>
          <select
            value={settings.outputCodec}
            onChange={(event) => update('outputCodec', event.target.value as 'h264' | 'mjpeg')}
          >
            <option value="mjpeg">MJPEG (works everywhere)</option>
            <option value="h264" disabled={!hasWebCodecs}>
              H.264 {hasWebCodecs ? '(lower bandwidth)' : '(needs WebCodecs)'}
            </option>
          </select>
        </label>
        <p className="hint">
          A video-file source puts the server in lossless mode, which forces MJPEG both ways.
        </p>

        <label className="field">
          <span>Output quality ({settings.outputQuality})</span>
          <input
            type="range"
            min={1}
            max={100}
            value={settings.outputQuality}
            onChange={(event) => actions.setOutputQuality(Number(event.target.value))}
          />
        </label>
        <label className="field">
          <span>Uplink JPEG quality ({settings.uplinkQuality.toFixed(2)})</span>
          <input
            type="range"
            min={0.3}
            max={1}
            step={0.05}
            value={settings.uplinkQuality}
            onChange={(event) => update('uplinkQuality', Number(event.target.value))}
          />
        </label>
      </fieldset>

      <fieldset>
        <legend>Sampling</legend>
        <label className="field">
          <span>Inference steps</span>
          <input
            type="number"
            min={1}
            max={20}
            value={settings.numInferenceSteps}
            onChange={(event) => update('numInferenceSteps', Number(event.target.value))}
          />
        </label>
        <label className="field">
          <span>Seed</span>
          <input
            type="number"
            value={settings.seed}
            onChange={(event) => update('seed', Number(event.target.value))}
          />
        </label>
        <label className="field checkbox">
          <input
            type="checkbox"
            checked={settings.usePe}
            onChange={(event) => update('usePe', event.target.checked)}
          />
          <span>Prompt enhancement (needs an LLM key on the server)</span>
        </label>
      </fieldset>

      <fieldset>
        <legend>Streaming state</legend>
        <label className="field">
          <span>KV reset every N frames (0 = never)</span>
          <input
            type="number"
            min={0}
            value={settings.kvResetFrames}
            onChange={(event) => update('kvResetFrames', Number(event.target.value))}
          />
        </label>
        <label className="field">
          <span>Max temporal IDs (blank = server default)</span>
          <input
            type="number"
            min={1}
            value={settings.maxTemporalIds ?? ''}
            onChange={(event) =>
              update('maxTemporalIds', event.target.value === '' ? null : Number(event.target.value))
            }
          />
        </label>
        <label className="field checkbox">
          <input
            type="checkbox"
            checked={settings.freezeKvOnStatic}
            onChange={(event) => update('freezeKvOnStatic', event.target.checked)}
          />
          <span>Freeze KV cache on static scenes</span>
        </label>
        <label className="field">
          <span>Static diff threshold</span>
          <input
            type="number"
            step={0.005}
            min={0}
            value={settings.staticDiffThresh}
            onChange={(event) => update('staticDiffThresh', Number(event.target.value))}
          />
        </label>
        <label className="field checkbox">
          <input
            type="checkbox"
            checked={settings.gateEnabled}
            onChange={(event) => update('gateEnabled', event.target.checked)}
          />
          <span>Presence gate (hold edits until a subject appears)</span>
        </label>
        <label className="field checkbox">
          <input
            type="checkbox"
            checked={settings.profileTimings}
            onChange={(event) => update('profileTimings', event.target.checked)}
          />
          <span>Server timing profile</span>
        </label>
      </fieldset>

      <p className="hint">
        {isStreaming
          ? 'Changes apply on the next Apply prompt / restart, except output quality which is live.'
          : 'Settings are sent when the session starts.'}
      </p>
    </aside>
  )
}
