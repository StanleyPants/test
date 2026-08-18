import type { OutputCodec, SourceKind } from '../protocol/types'

export interface SessionSettings {
  /** JoyAI server origin; empty string uses the Vite dev proxy / same origin. */
  serverUrl: string
  prompt: string
  /** Reference image as a data URL, for subject-driven (rv2v) edits. */
  refImage: string | null
  width: number
  height: number
  fps: number
  numInferenceSteps: number
  seed: number
  /** Server-side encode quality for returned frames, 1-100. */
  outputQuality: number
  /** Browser-side JPEG quality for uploaded frames, 0-1. */
  uplinkQuality: number
  outputCodec: OutputCodec
  source: SourceKind
  kvResetFrames: number
  maxTemporalIds: number | null
  freezeKvOnStatic: boolean
  staticDiffThresh: number
  maxInflightChunks: number
  /** LLM prompt rewriting; the server ignores it without an OPENAI_API_KEY. */
  usePe: boolean
  /** Hold edits until a face/person is detected. */
  gateEnabled: boolean
  profileTimings: boolean
}

export const DEFAULT_SETTINGS: SessionSettings = {
  serverUrl: '',
  prompt: 'Turn into a white marble statue',
  refImage: null,
  width: 840,
  height: 480,
  fps: 24,
  numInferenceSteps: 4,
  seed: 42,
  outputQuality: 85,
  uplinkQuality: 0.8,
  outputCodec: 'mjpeg',
  source: 'camera',
  kvResetFrames: 0,
  maxTemporalIds: null,
  freezeKvOnStatic: false,
  staticDiffThresh: 0.02,
  maxInflightChunks: 0,
  usePe: false,
  gateEnabled: true,
  profileTimings: true,
}

export interface ResolutionPreset {
  label: string
  width: number
  height: number
  fps: number
  note: string
}

/** The presets JoyAI documents per GPU class in DEPLOYMENT.md §5. */
export const RESOLUTION_PRESETS: ResolutionPreset[] = [
  { label: '480p · 24 FPS', width: 840, height: 480, fps: 24, note: 'default; RTX PRO 6000' },
  { label: '720p · 24 FPS', width: 1248, height: 720, fps: 24, note: 'B200 only' },
  { label: '720p · 16 FPS', width: 1248, height: 720, fps: 16, note: 'RTX PRO 6000' },
  { label: '360p · 24 FPS', width: 640, height: 360, fps: 24, note: 'low latency / testing' },
]

export const PROMPT_PRESETS: string[] = [
  'Turn into a white marble statue',
  'Turn into a LEGO minifigure',
  'Turn into a stop-motion clay character',
  'Transform the subject into a cyborg: a silver metal skeleton and precision gears exposed on the face',
  'Replace the background scene with a sunny tropical beach',
  'Replace the background scene with a barren, empty desert',
  'Replace the background with a modern Chinese-style living room',
  'Turn the subject into a Labrador',
]

const STORAGE_KEY = 'joyai-webapp-settings'

export function loadSettings(): SessionSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_SETTINGS
    const parsed = JSON.parse(raw) as Partial<SessionSettings>
    // Reference images can be megabytes; they are deliberately session-scoped.
    return { ...DEFAULT_SETTINGS, ...parsed, refImage: null }
  } catch {
    return DEFAULT_SETTINGS
  }
}

export function saveSettings(settings: SessionSettings): void {
  try {
    const { refImage: _refImage, ...persisted } = settings
    localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted))
  } catch {
    /* private browsing / quota - settings just will not persist */
  }
}
