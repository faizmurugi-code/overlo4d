"""
Overlord Grid — Sovereign Shield backend.

Serves the frontend, streams engine snapshots over /ws (5 Hz), and exposes
manual + scripted scenario controls. One process, no build step:

    uvicorn main:app --host 0.0.0.0 --port 8000

then open http://localhost:8000
"""

import asyncio
import json
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from engine import Engine

FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"
TICK = 0.2  # seconds — 5 Hz telemetry

app = FastAPI(title="Overlord Grid — Sovereign Shield")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

engine = Engine()


@app.on_event("startup")
async def start_engine_loop():
    """The grid runs whether or not an operator console is attached."""
    async def loop():
        while True:
            engine.update(TICK)
            await asyncio.sleep(TICK)
    asyncio.create_task(loop())


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    print("Frontend connected to Overlord Grid")
    try:
        while True:
            await websocket.send_text(json.dumps(engine.snapshot()))
            await asyncio.sleep(TICK)
    except WebSocketDisconnect:
        print("Frontend disconnected")
    except Exception as exc:  # keep the loop alive for the next client
        print(f"WS error: {exc}")


@app.get("/trigger/{mode}")
async def trigger(mode: str):
    """Manual overrides — same contract as the original demo, plus 'scenario'."""
    if mode == "scenario":
        engine.start_scenario()
    elif mode == "attack":
        engine.start_attack()
    elif mode == "defend":
        engine.start_mitigation()
    elif mode == "secure":
        engine.reset()
    else:
        return {"ok": False, "error": f"unknown mode '{mode}'"}
    print(f"Trigger: {mode} -> phase={engine.phase} status={engine.status}")
    return {"ok": True, "status": engine.status, "phase": engine.phase}


@app.get("/health")
async def health():
    return {"ok": True, "phase": engine.phase, "status": engine.status}


# ---- static frontend (mounted last so /ws and /trigger win) ----------------

@app.get("/")
async def index():
    return FileResponse(FRONTEND_DIR / "index.html")


app.mount("/", StaticFiles(directory=FRONTEND_DIR), name="frontend")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
