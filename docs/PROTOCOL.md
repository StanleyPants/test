# JoyAI-Video-Edit streaming protocol

Reference notes taken from `deploy/xvideo/serving/serve_joyomni_streaming.py`
in [jd-opensource/JoyAI-Video-Edit](https://github.com/jd-opensource/JoyAI-Video-Edit),
covering what this webapp implements. `web/src/protocol/types.ts` is the typed
mirror of everything below.

## HTTP

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/` | The server's own bundled UI |
| GET | `/health` | Health and runtime state (`runtime_loaded`, device, checkpoint) |
| GET | `/debug` | Runtime debug snapshot |
| GET | `/ref-images` | Reference images for rv2v edits, as `{ name: dataURL }` |
| POST | `/load` | Warm up / load the model. Minutes when cold |
| GET | `/download_last` | Last recorded clip; 404 unless recording is configured |
| WS | `/ws` | The streaming session |

## Transport

One WebSocket carries two interleaved streams:

- **JSON text frames** — control messages, both directions.
- **Binary frames** — encoded video.

Binary frames are *positional*, not self-describing. Every downlink binary frame
is immediately preceded by the `output_frame` JSON describing it, and every
uplink binary frame may be preceded by a `frame_meta` JSON labelling it. A
client must therefore hold the last header and pair it with the next binary
message.

## Session lifecycle

```
connect
  └─▶ queue_position (repeats while another client holds the session)
  └─▶ session_granted
        client: start {prompt, width, height, ...}
  └─▶ started {width, height, output_codec, input_codec, frames_per_next_chunk, ...}
        client: frame_meta + binary, repeatedly
  └─▶ accepted            (frames buffered, chunk not full yet)
  └─▶ chunk_start
      output_frame + binary   × count
      chunk_done
        client: stop
```

The server serialises sessions behind a single-holder gate. On connect you are
queued and receive `queue_position` until you are the holder.

**The holder is released after 10 s without any inbound message**, which yields
`session_timeout`. Ping regardless of whether frames are flowing.

## Client → server

| Type | Notes |
| --- | --- |
| `start` | Opens a session; omitted fields fall back to the server's CLI defaults |
| `frame_meta` | `{seq, t_capture_ms}` labelling the next binary frame |
| *(binary)* | One encoded source frame |
| `ack` | `{recv}` — output frames received this session. Drives congestion control |
| `ping` | `{t, recv}` — `t` is echoed in `pong` for RTT |
| `set_output_quality` | `{value}` 1–100, applies live |
| `finalize_recording` | Flush and close the server-side recording |
| `stop` | Ends the session |

### Notable `start` fields

- `width` / `height` — **snapped to the VAE stride by the server.** Always
  configure encoders and renderers from the `started` reply, not from what you
  asked for.
- `output_codec` / `input_codec` — `"h264"` or `"mjpeg"`. Requests, not
  guarantees; the `started` reply states what was actually negotiated.
- `source` — `"file"` puts the server in **lossless mode**, which forces MJPEG
  in both directions regardless of the codec fields.
- `ref_image` — data URL or bare base64, for subject-driven (rv2v) edits.
- `use_pe` — LLM prompt rewriting; silently ignored unless the server has an
  `OPENAI_API_KEY`.
- `gate_enabled` — face/person presence gate; edits are withheld until a subject
  is detected.

### Uplink codec sniffing

The server inspects the first uplink frame's magic bytes. JPEG (`FF D8 FF`)
downgrades an `input_codec: "h264"` session to MJPEG automatically, so sending
JPEG is always safe. This webapp relies on that.

## Server → client

| Type | Meaning |
| --- | --- |
| `queue_position` | Waiting for the session holder to release |
| `session_granted` | You are the holder; `start` is now accepted |
| `started` | Negotiated session parameters |
| `accepted` | Frames buffered; `next_chunk_needs` more before output |
| `chunk_start` | A chunk of `count` frames follows |
| `output_frame` | Header for the binary frame that follows immediately |
| `chunk_done` | Chunk complete, with `frames_in` / `frames_out` counters |
| `flow_drop` | A whole chunk was dropped because the client fell behind |
| `no_person` / `waiting_face` | Presence gate is holding edits |
| `pe_running` / `prompt_enhanced` | Prompt-enhancement progress and result |
| `session_reset` | Server restarted the stream (e.g. subject count changed) |
| `recording_finalized` | `{ok, message}` |
| `pong` | `{t, ts, up_ms}` — `up_ms` is the server's uplink delay estimate |
| `session_timeout` | Holder released after 10 s idle |
| `error` | `{message}` |

## Flow control

The server tracks how far the client has fallen behind:

```
outstanding = (frames_out - baseline_at_start) - last_acked_recv
```

Adjusted for the reported uplink delay, crossing a high-water mark flips it into
a congested state where it **drops entire output chunks** and clamps H.264
quality, recovering once the backlog drains.

Two consequences for a client:

1. **Ack regularly.** `recv` is the count of output frames received *since the
   current `start`* — the server rebases its own baseline on every `start`, so
   the counter must reset there too. Without acks, the server assumes the worst.
2. **Don't over-buffer the uplink.** Frames queued ahead of the server are pure
   added latency. This webapp caps its uplink queue at half a second of frames.

## H.264 downlink

Packets are Annex B from the server's PyAV encoder. In WebCodecs, omitting
`description` from the decoder config selects Annex B. Decoding cannot start
mid-GOP, so drop packets until the first frame flagged `key: true`.
