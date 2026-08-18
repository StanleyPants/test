import { useRef } from 'react'
import { PROMPT_PRESETS } from '../state/settings'
import type { SessionController } from '../state/useSession'

interface Props {
  session: SessionController
}

/** Prompt entry, reference image, and the start/stop controls. */
export function PromptBar({ session }: Props) {
  const { settings, update, isStreaming, actions, refImages, status } = session
  const fileInput = useRef<HTMLInputElement | null>(null)

  const onRefImageFile = (file: File) => {
    const reader = new FileReader()
    reader.onload = () => update('refImage', String(reader.result))
    reader.readAsDataURL(file)
  }

  return (
    <section className="prompt-bar">
      <div className="prompt-row">
        <textarea
          className="prompt-input"
          value={settings.prompt}
          rows={2}
          placeholder="Describe the edit, e.g. 'Turn into a white marble statue'"
          onChange={(event) => update('prompt', event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              isStreaming ? actions.applyPrompt() : actions.start()
            }
          }}
        />
        <div className="prompt-actions">
          {isStreaming ? (
            <>
              <button className="primary" onClick={actions.applyPrompt}>
                Apply prompt
              </button>
              <button onClick={actions.stop}>Stop</button>
            </>
          ) : (
            <button className="primary" onClick={actions.start}>
              Start editing
            </button>
          )}
        </div>
      </div>

      <div className="prompt-presets">
        {PROMPT_PRESETS.map((preset) => (
          <button
            key={preset}
            className={`chip ${settings.prompt === preset ? 'chip-active' : ''}`}
            title={preset}
            onClick={() => update('prompt', preset)}
          >
            {preset.length > 42 ? `${preset.slice(0, 40)}...` : preset}
          </button>
        ))}
      </div>

      <div className="ref-row">
        <span className="label">Reference image</span>
        <span className="muted small">subject-driven (rv2v) edits</span>
        <div className="ref-thumbs">
          <button className={`chip ${settings.refImage ? '' : 'chip-active'}`} onClick={() => update('refImage', null)}>
            None
          </button>
          {Object.entries(refImages).map(([name, dataUrl]) => (
            <button
              key={name}
              className={`ref-thumb ${settings.refImage === dataUrl ? 'ref-thumb-active' : ''}`}
              title={name}
              onClick={() => update('refImage', dataUrl)}
            >
              <img src={dataUrl} alt={name} />
            </button>
          ))}
          <button className="chip" onClick={() => fileInput.current?.click()}>
            Upload...
          </button>
          {settings.refImage && !Object.values(refImages).includes(settings.refImage) && (
            <span className="ref-thumb ref-thumb-active">
              <img src={settings.refImage} alt="custom reference" />
            </span>
          )}
        </div>
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) onRefImageFile(file)
            event.target.value = ''
          }}
        />
      </div>

      {status.promptEnhanced?.enhanced_prompt && (
        <div className="pe-note">
          <strong>Enhanced prompt</strong>
          <span>{status.promptEnhanced.enhanced_prompt}</span>
        </div>
      )}
    </section>
  )
}
