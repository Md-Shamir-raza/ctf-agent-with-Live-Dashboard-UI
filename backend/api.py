"""FastAPI API layer — REST + WebSocket for the CTF Agent dashboard.

Serves the frontend from ../frontend/ and exposes:
  GET  /api/status           — overall competition status
  GET  /api/challenges       — all challenges from CTFd
  GET  /api/swarms           — active solver swarms
  GET  /api/swarm/{name}     — per-challenge swarm detail
  GET  /api/costs            — cost breakdown by model
  GET  /api/logs/{name}/{model} — solver trace log
  POST /api/message          — send operator message
  POST /api/spawn/{name}     — spawn a swarm for a challenge
  POST /api/kill/{name}      — kill a running swarm
  WS   /ws                   — real-time event stream
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from pathlib import Path
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

logger = logging.getLogger(__name__)

FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"

app = FastAPI(title="CTF Agent Dashboard", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── Shared state (populated by start_api_server) ───────────────────────

_deps = None          # CoordinatorDeps
_ctfd = None          # CTFdClient
_cost_tracker = None  # CostTracker
_poller = None        # CTFdPoller
_settings = None      # Settings
_start_time: float = 0.0

# Connected WebSocket clients
_ws_clients: set[WebSocket] = set()

# Event log for dashboard (ring buffer)
_event_log: list[dict[str, Any]] = []
MAX_EVENT_LOG = 500


def configure_api(deps, ctfd, cost_tracker, poller, settings):
    """Called once at startup to inject dependencies."""
    global _deps, _ctfd, _cost_tracker, _poller, _settings, _start_time
    _deps = deps
    _ctfd = ctfd
    _cost_tracker = cost_tracker
    _poller = poller
    _settings = settings
    _start_time = time.time()


async def broadcast_event(event: dict[str, Any]) -> None:
    """Send an event to all connected WebSocket clients and log it."""
    event.setdefault("ts", time.time())
    _event_log.append(event)
    if len(_event_log) > MAX_EVENT_LOG:
        del _event_log[:len(_event_log) - MAX_EVENT_LOG]

    dead: list[WebSocket] = []
    msg = json.dumps(event)
    for ws in _ws_clients:
        try:
            await ws.send_text(msg)
        except Exception:
            dead.append(ws)
    for ws in dead:
        _ws_clients.discard(ws)


# ─── REST Endpoints ─────────────────────────────────────────────────────

@app.get("/api/status")
async def get_status():
    """Overall competition status."""
    if not _deps or not _poller:
        return JSONResponse({"error": "Not initialized"}, status_code=503)

    solved = _poller.known_solved
    all_challenges = _poller.known_challenges
    unsolved = all_challenges - solved
    active_swarms = {
        name: not task.done()
        for name, task in _deps.swarm_tasks.items()
    }

    return {
        "uptime_s": round(time.time() - _start_time, 1),
        "total_challenges": len(all_challenges),
        "solved_count": len(solved),
        "unsolved_count": len(unsolved),
        "solved": sorted(solved),
        "unsolved": sorted(unsolved),
        "active_swarm_count": sum(1 for v in active_swarms.values() if v),
        "total_cost_usd": round(_cost_tracker.total_cost_usd, 4) if _cost_tracker else 0,
        "total_tokens": _cost_tracker.total_tokens if _cost_tracker else 0,
        "models": _deps.model_specs,
        "ctfd_url": _settings.ctfd_url if _settings else "",
    }


@app.get("/api/challenges")
async def get_challenges():
    """All challenges with status info."""
    if not _ctfd or not _poller:
        return JSONResponse({"error": "Not initialized"}, status_code=503)

    try:
        challenges = await _ctfd.fetch_all_challenges()
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)

    solved = _poller.known_solved
    result = []
    for ch in challenges:
        name = ch.get("name", "?")
        swarm = _deps.swarms.get(name) if _deps else None
        swarm_status = None
        if swarm:
            swarm_status = swarm.get_status()

        result.append({
            "name": name,
            "category": ch.get("category", ""),
            "value": ch.get("value", 0),
            "solves": ch.get("solves", 0),
            "solved": name in solved,
            "description": (ch.get("description") or "")[:300],
            "has_swarm": swarm is not None,
            "swarm_status": swarm_status,
        })

    return {"challenges": result}


@app.get("/api/swarms")
async def get_swarms():
    """All active swarms with their status."""
    if not _deps:
        return JSONResponse({"error": "Not initialized"}, status_code=503)

    swarms = {}
    for name, swarm in _deps.swarms.items():
        task = _deps.swarm_tasks.get(name)
        swarms[name] = {
            **swarm.get_status(),
            "task_done": task.done() if task else True,
        }

    return {"swarms": swarms}


@app.get("/api/swarm/{challenge_name}")
async def get_swarm_detail(challenge_name: str):
    """Detailed status for a specific swarm."""
    if not _deps:
        return JSONResponse({"error": "Not initialized"}, status_code=503)

    swarm = _deps.swarms.get(challenge_name)
    if not swarm:
        return JSONResponse({"error": f"No swarm for '{challenge_name}'"}, status_code=404)

    return swarm.get_status()


@app.get("/api/costs")
async def get_costs():
    """Cost breakdown by agent and model."""
    if not _cost_tracker:
        return JSONResponse({"error": "Not initialized"}, status_code=503)

    by_model = _cost_tracker.get_usage_by_model()
    by_agent = {}
    for agent_name, agent_usage in _cost_tracker.by_agent.items():
        by_agent[agent_name] = {
            "model": agent_usage.model_name,
            "provider": agent_usage.provider_spec,
            "cost_usd": round(agent_usage.cost_usd, 4),
            "input_tokens": agent_usage.usage.input_tokens,
            "output_tokens": agent_usage.usage.output_tokens,
            "cache_read_tokens": agent_usage.usage.cache_read_tokens,
            "duration_s": round(agent_usage.duration_seconds, 1),
        }

    return {
        "total_cost_usd": round(_cost_tracker.total_cost_usd, 4),
        "total_tokens": _cost_tracker.total_tokens,
        "by_model": {
            model: {k: round(v, 4) if isinstance(v, float) else v for k, v in stats.items()}
            for model, stats in by_model.items()
        },
        "by_agent": by_agent,
    }


@app.get("/api/logs/{challenge_name}/{model_spec:path}")
async def get_solver_log(challenge_name: str, model_spec: str, last_n: int = 50):
    """Read the last N trace events from a solver log."""
    if not _deps:
        return JSONResponse({"error": "Not initialized"}, status_code=503)

    from backend.agents.coordinator_core import do_read_solver_trace
    trace = await do_read_solver_trace(_deps, challenge_name, model_spec, last_n)
    return {"trace": trace}


@app.get("/api/events")
async def get_events(last_n: int = 100):
    """Return recent events from the event log."""
    return {"events": _event_log[-last_n:]}


@app.post("/api/message")
async def post_message(body: dict):
    """Send an operator message to the coordinator."""
    if not _deps:
        return JSONResponse({"error": "Not initialized"}, status_code=503)

    message = body.get("message", "")
    if not message:
        return JSONResponse({"error": "Empty message"}, status_code=400)

    _deps.operator_inbox.put_nowait(message)
    await broadcast_event({"type": "operator_message", "message": message})
    return {"ok": True, "queued": message[:200]}


@app.post("/api/spawn/{challenge_name}")
async def spawn_swarm(challenge_name: str):
    """Spawn a solver swarm for a challenge."""
    if not _deps:
        return JSONResponse({"error": "Not initialized"}, status_code=503)

    from backend.agents.coordinator_core import do_spawn_swarm
    result = await do_spawn_swarm(_deps, challenge_name)
    await broadcast_event({
        "type": "swarm_spawned",
        "challenge": challenge_name,
        "result": result,
    })
    return {"result": result}


@app.post("/api/kill/{challenge_name}")
async def kill_swarm(challenge_name: str):
    """Kill a running swarm."""
    if not _deps:
        return JSONResponse({"error": "Not initialized"}, status_code=503)

    from backend.agents.coordinator_core import do_kill_swarm
    result = await do_kill_swarm(_deps, challenge_name)
    await broadcast_event({
        "type": "swarm_killed",
        "challenge": challenge_name,
    })
    return {"result": result}


# ─── WebSocket ───────────────────────────────────────────────────────────

@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    _ws_clients.add(ws)

    # Send initial state dump
    try:
        if _deps and _poller and _cost_tracker:
            await ws.send_text(json.dumps({
                "type": "init",
                "solved": sorted(_poller.known_solved),
                "unsolved": sorted(_poller.known_challenges - _poller.known_solved),
                "active_swarms": list(_deps.swarms.keys()),
                "total_cost_usd": round(_cost_tracker.total_cost_usd, 4),
            }))
    except Exception:
        pass

    try:
        while True:
            # Keep connection alive; handle pings
            data = await ws.receive_text()
            if data == "ping":
                await ws.send_text(json.dumps({"type": "pong"}))
    except WebSocketDisconnect:
        pass
    finally:
        _ws_clients.discard(ws)


# ─── Static frontend ────────────────────────────────────────────────────

@app.get("/")
async def serve_index():
    index = FRONTEND_DIR / "index.html"
    if index.exists():
        return FileResponse(index)
    return JSONResponse({"error": "Frontend not found"}, status_code=404)


# Mount static files last so API routes take precedence
if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
