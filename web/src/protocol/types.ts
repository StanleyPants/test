/**
 * Wire types for the JoyAI-Video-Edit streaming server.
 *
 * Mirrors deploy/xvideo/serving/serve_joyomni_streaming.py. The transport is a
 * single WebSocket at `/ws` carrying two interleaved streams:
 *
 *   - JSON text frames  -> control messages (both directions)
 *   - binary frames     -> encoded video payloads
 *
 * Binary frames are positional, not self-describing: every downlink binary
 * frame is preceded by the `output_frame` JSON that describes it, and every
 * uplink binary frame may be preceded by a `frame_meta` JSON that labels it.
 */

export type OutputCodec = 'h264' | 'mjpeg'
export type SourceKind = 'camera' | 'file' | 'screen'

/** `start` — opens an editing session. Any omitted field falls back to the server's CLI default. */
export interface StartMessage {
  type: 'start'
  prompt: string
  /** Reference image for rv2v (subject-driven) edits: data URL or bare base64. */
  ref_image?: string | null
  /** Pre-computed prompt-enhancement result, to skip a round trip on restart. */
  enhanced_prompt?: string
  width?: number
  height?: number
  fps?: number
  seed?: number
  num_inference_steps?: number
  /** JPEG/H.264 quality for the returned frames, 1-100. */
  output_quality?: number
  output_codec?: OutputCodec
  input_codec?: OutputCodec
  /**
   * `"file"` puts the server in lossless mode, which forces both directions to
   * MJPEG regardless of the codec fields above.
   */
  source?: SourceKind
  kv_reset_frames?: number
  max_temporal_ids?: number | null
  freeze_kv_on_static?: boolean
  static_diff_thresh?: number
  max_inflight_chunks?: number
  /** Prompt enhancement; the server ignores it unless it has an OPENAI_API_KEY. */
  use_pe?: boolean
  /** Face/person presence gate — edits are held until a subject is detected. */
  gate_enabled?: boolean
  fg_score?: number
  fg_min_below_ratio?: number
  fg_stable_frames?: number
  profile_timings?: boolean
}

export interface FrameMetaMessage {
  type: 'frame_meta'
  seq: number
  t_capture_ms: number
}

/** Flow control: how many output frames we have received this session. */
export interface AckMessage {
  type: 'ack'
  recv: number
}

export interface PingMessage {
  type: 'ping'
  /** Client wall clock in ms; echoed back in `pong` for RTT measurement. */
  t: number
  recv?: number
}

export interface SetOutputQualityMessage {
  type: 'set_output_quality'
  value: number
}

export interface StopMessage {
  type: 'stop'
}

export interface FinalizeRecordingMessage {
  type: 'finalize_recording'
}

export type ClientMessage =
  | StartMessage
  | FrameMetaMessage
  | AckMessage
  | PingMessage
  | SetOutputQualityMessage
  | StopMessage
  | FinalizeRecordingMessage

/**
 * The server serialises sessions behind a single-holder gate: on connect you
 * are queued, and only the holder may stream. Holding lapses after 10s of
 * silence, so the client must keep pinging even when it is not sending frames.
 */
export interface QueuePositionMessage {
  type: 'queue_position'
  position: number
  ahead: number
}

export interface SessionGrantedMessage {
  type: 'session_granted'
}

export interface SessionTimeoutMessage {
  type: 'session_timeout'
  message: string
}

export interface StartedMessage {
  type: 'started'
  /** How many frames the server wants before it can emit the next chunk. */
  frames_per_next_chunk: number
  /** Effective size, snapped to the VAE stride — may differ from what we asked for. */
  height: number
  width: number
  output_codec: OutputCodec
  input_codec: OutputCodec
  ref_image: boolean
  kv_reset_frames: number
  use_pe: boolean
  pe_model: string
  max_temporal_ids: number | null
  freeze_kv_on_static: boolean
  static_diff_thresh: number
}

export interface SessionResetMessage {
  type: 'session_reset'
  reason?: string
  frames_per_next_chunk: number
  [key: string]: unknown
}

export interface ChunkStartMessage {
  type: 'chunk_start'
  count: number
  elapsed: number
  frames_in: number
  source_seq_start: number | null
  source_seq_end: number | null
}

/** Always immediately followed by one binary frame. */
export interface OutputFrameMessage {
  type: 'output_frame'
  index: number
  count: number
  source_seq: number | null
  t_capture_ms: number | null
  server_elapsed: number
  profile: Record<string, unknown>
  /** H.264 keyframe flag; meaningless for MJPEG. */
  key: boolean
}

export interface ChunkDoneMessage {
  type: 'chunk_done'
  count: number
  frames_in: number
  frames_out: number
  next_chunk_needs: number
  ws_send_s?: number
  server_residence_s?: number
  chunk_idx?: number
}

/** Frames consumed, but no output yet (still filling the chunk). */
export interface AcceptedMessage {
  type: 'accepted'
  frames_in: number
  frames_out: number
  next_chunk_needs: number
}

/** The server dropped a whole chunk because our receive side fell behind. */
export interface FlowDropMessage {
  type: 'flow_drop'
  count: number
  outstanding: number
  dropped_total: number
}

export interface NoPersonMessage {
  type: 'no_person'
  reason: string
  frames_in: number
}

export interface WaitingFaceMessage {
  type: 'waiting_face'
  reason: unknown
  frames_in: number
}

export interface PeRunningMessage {
  type: 'pe_running'
  frames_in: number
}

export interface PromptEnhancedMessage {
  type: 'prompt_enhanced'
  enabled: boolean
  task_type?: 'v2v' | 'rv2v'
  model?: string
  raw_prompt?: string
  enhanced_prompt?: string
  elapsed_s?: number
  fallback?: boolean
  cached?: boolean
}

export interface PongMessage {
  type: 'pong'
  t: number
  ts: number
  up_ms: number | null
}

export interface RecordingFinalizedMessage {
  type: 'recording_finalized'
  ok: boolean
  message: string | null
}

export interface ErrorMessage {
  type: 'error'
  message: string
}

export type ServerMessage =
  | QueuePositionMessage
  | SessionGrantedMessage
  | SessionTimeoutMessage
  | StartedMessage
  | SessionResetMessage
  | ChunkStartMessage
  | OutputFrameMessage
  | ChunkDoneMessage
  | AcceptedMessage
  | FlowDropMessage
  | NoPersonMessage
  | WaitingFaceMessage
  | PeRunningMessage
  | PromptEnhancedMessage
  | PongMessage
  | RecordingFinalizedMessage
  | ErrorMessage

/** `GET /health` */
export interface HealthResponse {
  ok: boolean
  runtime_loaded: boolean
  device?: string
  dit_ckpt?: string
  use_pe?: boolean
  pe_model?: string
  [key: string]: unknown
}

/** `GET /ref-images` — name -> data URL. */
export type RefImagesResponse = Record<string, string>
