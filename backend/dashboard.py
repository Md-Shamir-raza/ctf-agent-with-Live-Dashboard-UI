"""CLI entry point for the CTF Agent Dashboard (FastAPI + Uvicorn).

Starts the dashboard web server, which:
  1. Spins up the coordinator event loop in the background.
  2. Serves the REST API at /api/*.
  3. Serves the frontend at /.
  4. Streams real-time events over WebSocket at /ws.
"""

from __future__ import annotations

import asyncio
import logging
import sys
from contextlib import asynccontextmanager
from pathlib import Path

import click
import uvicorn
from rich.console import Console

from backend.config import Settings
from backend.models import DEFAULT_MODELS

console = Console()


def _setup_logging(verbose: bool = False) -> None:
    level = logging.DEBUG if verbose else logging.INFO
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    logging.getLogger("botocore").setLevel(logging.WARNING)
    logging.getLogger("urllib3").setLevel(logging.WARNING)
    logging.getLogger("aiodocker").setLevel(logging.WARNING)
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter("[%(asctime)s] %(levelname)-8s %(message)s", datefmt="%X"))
    logging.basicConfig(level=level, handlers=[handler], force=True)


@click.command()
@click.option("--ctfd-url", default=None, help="CTFd URL (overrides .env)")
@click.option("--ctfd-token", default=None, help="CTFd API token (overrides .env)")
@click.option("--image", default="ctf-sandbox", help="Docker sandbox image name")
@click.option("--models", multiple=True, help="Model specs (default: all configured)")
@click.option("--challenges-dir", default="challenges", help="Directory for challenge files")
@click.option("--no-submit", is_flag=True, help="Dry run — don't submit flags")
@click.option("--coordinator-model", default=None, help="Model for coordinator")
@click.option("--coordinator", default="claude", type=click.Choice(["claude", "codex"]), help="Coordinator backend")
@click.option("--max-challenges", default=10, type=int, help="Max challenges solved concurrently")
@click.option("--host", default="0.0.0.0", help="Dashboard host")
@click.option("--port", default=8080, type=int, help="Dashboard port")
@click.option("-v", "--verbose", is_flag=True, help="Verbose logging")
def dashboard(
    ctfd_url: str | None,
    ctfd_token: str | None,
    image: str,
    models: tuple[str, ...],
    challenges_dir: str,
    no_submit: bool,
    coordinator_model: str | None,
    coordinator: str,
    max_challenges: int,
    host: str,
    port: int,
    verbose: bool,
) -> None:
    """CTF Agent Dashboard — web UI for the solver swarm.

    Starts the coordinator in the background and serves a real-time
    dashboard at http://host:port.
    """
    _setup_logging(verbose)

    settings = Settings(sandbox_image=image)
    if ctfd_url:
        settings.ctfd_url = ctfd_url
    if ctfd_token:
        settings.ctfd_token = ctfd_token
    settings.max_concurrent_challenges = max_challenges

    model_specs = list(models) if models else list(DEFAULT_MODELS)

    console.print("[bold]CTF Agent Dashboard[/bold]")
    console.print(f"  CTFd:       {settings.ctfd_url}")
    console.print(f"  Models:     {', '.join(model_specs)}")
    console.print(f"  Image:      {settings.sandbox_image}")
    console.print(f"  Dashboard:  http://{host}:{port}")
    console.print()

    # Store config for use in the lifespan
    _config.update({
        "settings": settings,
        "model_specs": model_specs,
        "challenges_dir": challenges_dir,
        "no_submit": no_submit,
        "coordinator_model": coordinator_model,
        "coordinator_backend": coordinator,
        "max_challenges": max_challenges,
    })

    uvicorn.run(
        "backend.dashboard:create_app",
        factory=True,
        host=host,
        port=port,
        log_level="warning" if not verbose else "info",
    )


# ─── Config storage ──────────────────────────────────────────────────────
_config: dict = {}


def create_app():
    """Factory function for uvicorn — creates the FastAPI app with lifespan."""
    from backend.api import app, configure_api, broadcast_event

    @asynccontextmanager
    async def lifespan(app):
        """Start coordinator in background, configure API deps."""
        from backend.agents.coordinator_loop import build_deps, run_event_loop
        from backend.poller import CTFdPoller
        from backend.sandbox import cleanup_orphan_containers, configure_semaphore

        cfg = _config
        settings = cfg["settings"]
        model_specs = cfg["model_specs"]

        max_containers = cfg["max_challenges"] * len(model_specs)
        configure_semaphore(max_containers)
        await cleanup_orphan_containers()

        ctfd, cost_tracker, deps = build_deps(
            settings=settings,
            model_specs=model_specs,
            challenges_root=cfg["challenges_dir"],
            no_submit=cfg["no_submit"],
        )

        poller = CTFdPoller(ctfd=ctfd, interval_s=5.0)
        await poller.start()

        configure_api(deps, ctfd, cost_tracker, poller, settings)

        # Start the coordinator event loop as a background task
        coordinator_task = None
        coordinator_backend = cfg.get("coordinator_backend", "claude")
        coordinator_model = cfg.get("coordinator_model")

        async def run_coordinator():
            if coordinator_backend == "codex":
                from backend.agents.codex_coordinator import run_codex_coordinator
                await run_codex_coordinator(
                    settings=settings,
                    model_specs=model_specs,
                    challenges_root=cfg["challenges_dir"],
                    no_submit=cfg["no_submit"],
                    coordinator_model=coordinator_model,
                )
            else:
                from backend.agents.claude_coordinator import run_claude_coordinator
                await run_claude_coordinator(
                    settings=settings,
                    model_specs=model_specs,
                    challenges_root=cfg["challenges_dir"],
                    no_submit=cfg["no_submit"],
                    coordinator_model=coordinator_model,
                )

        coordinator_task = asyncio.create_task(run_coordinator(), name="coordinator")
        logging.getLogger(__name__).info("Coordinator started in background")

        # Background event broadcaster — monitors poller for events
        async def event_broadcaster():
            while True:
                try:
                    evt = await poller.get_event(timeout=2.0)
                    if evt:
                        await broadcast_event({
                            "type": evt.kind,
                            "challenge": evt.challenge_name,
                            "details": evt.details,
                        })
                except asyncio.CancelledError:
                    break
                except Exception:
                    await asyncio.sleep(1)

        broadcaster_task = asyncio.create_task(event_broadcaster(), name="event-broadcaster")

        yield

        # Shutdown
        broadcaster_task.cancel()
        if coordinator_task:
            coordinator_task.cancel()
        try:
            await asyncio.gather(broadcaster_task, coordinator_task, return_exceptions=True)
        except Exception:
            pass
        await poller.stop()
        await ctfd.close()

    app.router.lifespan_context = lifespan
    return app


if __name__ == "__main__":
    dashboard()
