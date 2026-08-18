"""
Protocol-accurate mock of the JoyAI-Video-Edit streaming server.

It speaks the exact wire protocol of
`deploy/xvideo/serving/serve_joyomni_streaming.py` -- the same HTTP routes, the
same JSON control messages, and the same `output_frame`-header-then-binary
framing -- but replaces the 16B diffusion transformer with cheap PIL filters.

That makes the webapp developable and testable on a machine with no GPU and no
51GB of checkpoints. Point the app at a real JoyAI server and nothing in the
client changes.

    pip install -r requirements.txt
    python server.py --port 8080
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import io
import json
import math
import time
from pathlib import Path
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageOps

# The real server pulls frames in chunks; the client waits on `next_chunk_needs`,
# so the mock must chunk too or the UI's pacing logic goes untested.
FIRST_CHUNK_FRAMES = 5
STEADY_CHUNK_FRAMES = 4
# Stand-in for DiT denoise time, so latency plumbing has something to show.
SIMULATED_CHUNK_LATENCY_S = 0.12
HOLDER_IDLE_TIMEOUT_S = 10.0


# --------------------------------------------------------------------------- #
# Fake "edits"
# --------------------------------------------------------------------------- #


def _stylize(image: Image.Image, prompt: str, frame_index: int) -> Image.Image:
    """A keyword-driven caricature of the real model's edit styles."""
    text = prompt.lower()

    if "marble" in text or "statue" in text:
        out = ImageOps.grayscale(image).convert("RGB")
        out = ImageEnhance.Contrast(out).enhance(1.6)
        out = Image.blend(out, out.filter(ImageFilter.GaussianBlur(1.2)), 0.4)
        out = ImageEnhance.Brightness(out).enhance(1.12)
    elif "lego" in text:
        small = image.resize((max(1, image.width // 16), max(1, image.height // 16)), Image.BILINEAR)
        out = small.resize(image.size, Image.NEAREST)
        out = ImageOps.posterize(out, 3)
        out = ImageEnhance.Color(out).enhance(1.8)
    elif "clay" in text or "claymation" in text or "stop-motion" in text:
        out = ImageOps.posterize(image, 4).filter(ImageFilter.SMOOTH_MORE)
        out = ImageEnhance.Color(out).enhance(1.3)
        out = _tint(out, (255, 226, 196), 0.18)
    elif "cyborg" in text or "metal" in text or "silver" in text:
        out = ImageOps.grayscale(image).convert("RGB")
        out = ImageOps.autocontrast(out)
        out = _tint(out, (168, 196, 230), 0.28)
        out = out.filter(ImageFilter.EDGE_ENHANCE_MORE)
    elif "beach" in text or "tropical" in text:
        out = _tint(image, (255, 196, 120), 0.25)
        out = ImageEnhance.Color(out).enhance(1.5)
    elif "desert" in text:
        out = _tint(image, (214, 176, 118), 0.32)
    elif "background" in text:
        out = _tint(image, (120, 150, 220), 0.22)
    elif "dog" in text or "labrador" in text:
        out = _tint(image, (222, 186, 120), 0.2)
        out = out.filter(ImageFilter.SMOOTH)
    else:
        out = ImageOps.posterize(image, 5)
        out = ImageEnhance.Color(out).enhance(1.4)
        out = ImageEnhance.Contrast(out).enhance(1.15)

    # A slow pulse proves frames are being produced continuously, not cached.
    pulse = 1.0 + 0.05 * math.sin(frame_index / 12.0)
    out = ImageEnhance.Brightness(out).enhance(pulse)
    return _annotate(out, prompt)


def _tint(image: Image.Image, color: tuple[int, int, int], amount: float) -> Image.Image:
    layer = Image.new("RGB", image.size, color)
    return Image.blend(image, layer, amount)


def _annotate(image: Image.Image, prompt: str) -> Image.Image:
    """Marks output unmistakably as mock, so it is never taken for model output."""
    draw = ImageDraw.Draw(image, "RGBA")
    label = f"MOCK EDIT · {prompt[:52]}" if prompt else "MOCK EDIT"
    bar_height = max(18, image.height // 22)
    draw.rectangle([0, image.height - bar_height, image.width, image.height], fill=(0, 0, 0, 150))
    draw.text((8, image.height - bar_height + 3), label, fill=(255, 255, 255, 230))
    return image


def _cover_resize(image: Image.Image, width: int, height: int) -> Image.Image:
    return ImageOps.fit(image, (width, height), Image.BILINEAR)


# --------------------------------------------------------------------------- #
# App
# --------------------------------------------------------------------------- #


def build_app(args: argparse.Namespace) -> FastAPI:
    app = FastAPI(title="JoyAI-Video-Edit (mock)")
    app.state.runtime_loaded = False
    app.state.ws_debug: dict[str, Any] = {}
    app.state.last_recording: bytes | None = None

    @app.get("/health")
    def health() -> JSONResponse:
        return JSONResponse(
            {
                "ok": True,
                "runtime_loaded": app.state.runtime_loaded,
                "mock": True,
                "device": "cpu (mock)",
                "dit_ckpt": "<mock: no checkpoint loaded>",
                "use_pe": False,
                "pe_model": "none",
                "kv_reset_frames": 0,
                "max_temporal_ids": None,
                "freeze_kv_on_static": False,
                "static_diff_thresh": 0.02,
            }
        )

    @app.get("/debug")
    def debug() -> JSONResponse:
        return JSONResponse(
            {"ok": True, "ts": time.time(), "mock": True, "ws": app.state.ws_debug, "session": None}
        )

    @app.post("/load")
    def load() -> JSONResponse:
        started = time.time()
        app.state.runtime_loaded = True
        return JSONResponse({"ok": True, "elapsed": time.time() - started})

    @app.get("/ref-images")
    def ref_images() -> JSONResponse:
        return JSONResponse(_load_ref_images(args.ref_dir))

    @app.get("/download_last")
    def download_last() -> JSONResponse:
        # The mock keeps no muxer, so it reports the same shape of error the
        # real server returns before anything has been recorded.
        return JSONResponse(
            {"error": "Mock server does not record clips. Use a real JoyAI server."},
            status_code=404,
        )

    @app.websocket("/ws")
    async def websocket_endpoint(websocket: WebSocket) -> None:
        await websocket.accept()
        await _run_session(app, websocket, args)

    static_dir = Path(args.static_dir) if args.static_dir else None
    if static_dir and static_dir.is_dir():
        app.mount("/", StaticFiles(directory=str(static_dir), html=True), name="static")
    else:

        @app.get("/")
        def index() -> HTMLResponse:
            return HTMLResponse(
                "<h1>JoyAI-Video-Edit mock server</h1>"
                "<p>WebSocket endpoint is <code>/ws</code>. "
                "Run the webapp with <code>npm run dev</code> in <code>web/</code>, "
                "or build it and pass <code>--static-dir ../web/dist</code>.</p>"
            )

    return app


def _load_ref_images(ref_dir: str | None) -> dict[str, str]:
    if not ref_dir:
        return {}
    directory = Path(ref_dir)
    if not directory.is_dir():
        return {}
    out: dict[str, str] = {}
    for path in sorted(directory.iterdir()):
        if path.suffix.lower() not in (".png", ".jpg", ".jpeg"):
            continue
        mime = "image/jpeg" if path.suffix.lower() in (".jpg", ".jpeg") else "image/png"
        out[path.stem] = f"data:{mime};base64," + base64.b64encode(path.read_bytes()).decode("ascii")
    return out


async def _run_session(app: FastAPI, websocket: WebSocket, args: argparse.Namespace) -> None:
    """One connection: queue gate, then the start/frames/stop loop."""
    debug = app.state.ws_debug
    debug.update({"opened_at": time.time(), "frames_in": 0, "frames_out": 0})

    # Single-holder gate. The mock has no contention, but the client's queue
    # handling still needs to see these two messages in this order.
    await websocket.send_json({"type": "queue_position", "position": 0, "ahead": 0})
    await websocket.send_json({"type": "session_granted"})

    session: dict[str, Any] | None = None
    frames_in = 0
    frames_out = 0
    next_meta: dict[str, Any] | None = None
    last_activity = time.monotonic()

    try:
        while True:
            if time.monotonic() - last_activity >= HOLDER_IDLE_TIMEOUT_S:
                await websocket.send_json(
                    {
                        "type": "session_timeout",
                        "message": f"released after {HOLDER_IDLE_TIMEOUT_S:.0f}s idle; reconnect to re-queue",
                    }
                )
                break
            try:
                message = await asyncio.wait_for(websocket.receive(), timeout=2.0)
            except asyncio.TimeoutError:
                continue

            if message.get("type") == "websocket.disconnect":
                break

            text = message.get("text")
            if text is not None:
                payload = json.loads(text)
                kind = payload.get("type")
                last_activity = time.monotonic()

                if kind == "start":
                    session = _start_session(payload, args)
                    frames_in = 0
                    frames_out = 0
                    await websocket.send_json(
                        {
                            "type": "started",
                            "frames_per_next_chunk": session["needs"],
                            "height": session["height"],
                            "width": session["width"],
                            "output_codec": "mjpeg",  # the mock never emits H.264
                            "input_codec": "mjpeg",
                            "ref_image": session["ref_image"] is not None,
                            "kv_reset_frames": int(payload.get("kv_reset_frames", 0)),
                            "use_pe": False,
                            "pe_model": "none",
                            "max_temporal_ids": payload.get("max_temporal_ids"),
                            "freeze_kv_on_static": bool(payload.get("freeze_kv_on_static", False)),
                            "static_diff_thresh": float(payload.get("static_diff_thresh", 0.02)),
                        }
                    )
                elif kind == "stop":
                    session = None
                    break
                elif kind == "ping":
                    await websocket.send_json(
                        {
                            "type": "pong",
                            "t": payload.get("t"),
                            "ts": time.time() * 1000.0,
                            "up_ms": 0.0,
                        }
                    )
                elif kind == "ack":
                    pass  # the mock never applies congestion drops
                elif kind == "frame_meta":
                    next_meta = {
                        "seq": int(payload.get("seq", frames_in + 1)),
                        "t_capture_ms": float(payload.get("t_capture_ms", time.time() * 1000.0)),
                    }
                elif kind == "set_output_quality":
                    if session is not None:
                        session["quality"] = max(1, min(100, int(payload.get("value", 85))))
                elif kind == "finalize_recording":
                    await websocket.send_json(
                        {
                            "type": "recording_finalized",
                            "ok": False,
                            "message": "Mock server does not record clips.",
                        }
                    )
                else:
                    await websocket.send_json(
                        {"type": "error", "message": f"unknown message type: {kind}"}
                    )
                continue

            data = message.get("bytes")
            if data is None:
                continue
            if session is None:
                await websocket.send_json(
                    {"type": "error", "message": "send start JSON before frames"}
                )
                continue

            frames_in += 1
            last_activity = time.monotonic()
            meta = next_meta or {"seq": frames_in, "t_capture_ms": time.time() * 1000.0}
            next_meta = None
            session["pending"].append((data, meta))
            debug["frames_in"] = frames_in

            if len(session["pending"]) < session["needs"]:
                await websocket.send_json(
                    {
                        "type": "accepted",
                        "frames_in": frames_in,
                        "frames_out": frames_out,
                        "next_chunk_needs": session["needs"] - len(session["pending"]),
                    }
                )
                continue

            chunk = session["pending"]
            session["pending"] = []
            session["needs"] = STEADY_CHUNK_FRAMES
            frames_out = await _emit_chunk(websocket, session, chunk, frames_in, frames_out)
            debug["frames_out"] = frames_out

    except WebSocketDisconnect:
        pass
    except RuntimeError as exc:  # raised when the socket dies mid-send
        if "disconnect" not in str(exc).lower():
            raise
    finally:
        debug["closed_at"] = time.time()


def _start_session(payload: dict[str, Any], args: argparse.Namespace) -> dict[str, Any]:
    # Match the real server's stride snapping so the client sees a size that
    # may differ from what it requested.
    align = 16
    width = max(align, round(int(payload.get("width", args.width)) / align) * align)
    height = max(align, round(int(payload.get("height", args.height)) / align) * align)
    return {
        "prompt": str(payload.get("prompt", "")),
        "ref_image": payload.get("ref_image") or None,
        "width": width,
        "height": height,
        "quality": max(1, min(100, int(payload.get("output_quality", 85)))),
        "pending": [],
        "needs": FIRST_CHUNK_FRAMES,
        "index": 0,
    }


async def _emit_chunk(
    websocket: WebSocket,
    session: dict[str, Any],
    chunk: list[tuple[bytes, dict[str, Any]]],
    frames_in: int,
    frames_out: int,
) -> int:
    started = time.time()
    encoded = await asyncio.to_thread(_process_chunk, session, chunk)
    await asyncio.sleep(SIMULATED_CHUNK_LATENCY_S)
    elapsed = time.time() - started

    await websocket.send_json(
        {
            "type": "chunk_start",
            "count": len(encoded),
            "elapsed": elapsed,
            "frames_in": frames_in,
            "source_seq_start": chunk[0][1].get("seq"),
            "source_seq_end": chunk[-1][1].get("seq"),
        }
    )

    for index, (payload, meta) in enumerate(zip(encoded, [m for _, m in chunk])):
        await websocket.send_json(
            {
                "type": "output_frame",
                "index": index,
                "count": len(encoded),
                "source_seq": meta.get("seq"),
                "t_capture_ms": meta.get("t_capture_ms"),
                "server_elapsed": elapsed,
                "profile": {"mock": True},
                "key": True,  # every MJPEG frame is independently decodable
            }
        )
        await websocket.send_bytes(payload)
        frames_out += 1

    await websocket.send_json(
        {
            "type": "chunk_done",
            "count": len(encoded),
            "frames_in": frames_in,
            "frames_out": frames_out,
            "next_chunk_needs": session["needs"] - len(session["pending"]),
        }
    )
    return frames_out


def _process_chunk(
    session: dict[str, Any], chunk: list[tuple[bytes, dict[str, Any]]]
) -> list[bytes]:
    out: list[bytes] = []
    for data, _meta in chunk:
        session["index"] += 1
        try:
            with Image.open(io.BytesIO(data)) as decoded:
                image = decoded.convert("RGB")
        except Exception:
            image = Image.new("RGB", (session["width"], session["height"]), (20, 20, 28))
        image = _cover_resize(image, session["width"], session["height"])
        edited = _stylize(image, session["prompt"], session["index"])
        buffer = io.BytesIO()
        edited.save(buffer, format="JPEG", quality=session["quality"])
        out.append(buffer.getvalue())
    return out


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Mock JoyAI-Video-Edit streaming server")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--width", type=int, default=840)
    parser.add_argument("--height", type=int, default=480)
    parser.add_argument("--ref-dir", default=None, help="directory of reference images to expose")
    parser.add_argument("--static-dir", default=None, help="serve a built webapp from this dir")
    return parser.parse_args()


def main() -> None:
    import uvicorn

    args = parse_args()
    uvicorn.run(build_app(args), host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
