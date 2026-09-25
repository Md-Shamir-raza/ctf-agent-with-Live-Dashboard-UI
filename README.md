# CTF Agent

Autonomous CTF (Capture The Flag) solver that races multiple AI models against challenges in parallel. Built in a weekend, we used it to solve all 52/52 challenges and win **1st place at BSidesSF 2026 CTF**.

Built by [Veria Labs](https://verialabs.com), founded by members of [.;,;.](https://ctftime.org/team/222911) (smiley), the [#1 US CTF team on CTFTime in 2024 and 2025](https://ctftime.org/stats/2024/US). We build AI agents that find and exploit real security vulnerabilities for large enterprises.

## Results

| Competition | Challenges Solved | Result |
|-------------|:-:|--------|
| **BSidesSF 2026** | 52/52 (100%) | **1st place ($1,500)** |

The agent solves challenges across all categories — pwn, rev, crypto, forensics, web, and misc.

## How It Works

A **coordinator** LLM manages the competition while **solver swarms** attack individual challenges. Each swarm runs multiple models simultaneously — the first to find the flag wins.

```
                        +-----------------+
                        |  CTFd Platform  |
                        +--------+--------+
                                 |
                        +--------v--------+
                        |  Poller (5s)    |
                        +--------+--------+
                                 |
                        +--------v--------+
                        | Coordinator LLM |
                        | (Claude/Codex)  |
                        +--------+--------+
                                 |
              +------------------+------------------+
              |                  |                  |
     +--------v--------+ +------v---------+ +------v---------+
     | Swarm:          | | Swarm:         | | Swarm:         |
     | challenge-1     | | challenge-2    | | challenge-N    |
     |                 | |                | |                |
     |  Opus (med)     | |  Opus (med)    | |                |
     |  Opus (max)     | |  Opus (max)    | |     ...        |
     |  GPT-5.4        | |  GPT-5.4       | |                |
     |  GPT-5.4-mini   | |  GPT-5.4-mini  | |                |
     |  GPT-5.3-codex  | |  GPT-5.3-codex | |                |
     +--------+--------+ +--------+-------+ +----------------+
              |                    |
     +--------v--------+  +-------v--------+
     | Docker Sandbox  |  | Docker Sandbox |
     | (isolated)      |  | (isolated)     |
     |                 |  |                |
     | pwntools, r2,   |  | pwntools, r2,  |
     | gdb, python...  |  | gdb, python... |
     +-----------------+  +----------------+
```

Each solver runs in an isolated Docker container with CTF tools pre-installed. Solvers never give up — they keep trying different approaches until the flag is found.

## Quick Start

### Prerequisites

| Requirement | Version | Notes |
|-------------|---------|-------|
| **Python** | 3.14+ | Required for the agent |
| **Docker** | Latest | For sandbox containers |
| **uv** | Latest | Python package manager ([install](https://docs.astral.sh/uv/getting-started/installation/)) |
| **API Keys** | — | At least one: Anthropic, OpenAI, or Google |
| **`claude` CLI** | Latest | For Claude SDK coordinator/solver ([install](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview)) |
| **`codex` CLI** | Latest | For Codex coordinator/solver ([install](https://openai.com/index/codex/)) |

### Step-by-Step Setup

```bash
# 1. Clone the repository
git clone https://github.com/Md-Shamir-raza/ctf-agent-with-Live-Dashboard-UI.git
cd ctf-agent-with-Live-Dashboard-UI

# 2. Install dependencies
uv sync

# 3. Build the Docker sandbox image (contains all CTF tools)
docker build -f sandbox/Dockerfile.sandbox -t ctf-sandbox .

# 4. Configure credentials
cp .env.example .env
# Edit .env with your API keys and CTFd credentials
```

Your `.env` file should look like:

```env
# CTFd instance
CTFD_URL=https://ctf.example.com
CTFD_TOKEN=ctfd_your_api_token_here

# API Keys (at least one required)
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
GEMINI_API_KEY=...
```

### Running the Agent

There are two ways to run the agent:

#### Option A: Web Dashboard (Recommended)

The dashboard provides a real-time web UI to monitor and control the solver swarms:

```bash
uv run ctf-dashboard \
  --ctfd-url https://ctf.example.com \
  --ctfd-token ctfd_your_token \
  --challenges-dir challenges \
  --max-challenges 10 \
  --port 8080 \
  -v
```

Then open **http://localhost:8080** in your browser. The dashboard shows:
- **Overview** — progress ring, solved/unsolved counts, category breakdown
- **Challenges** — browse all challenges, spawn/kill swarms
- **Swarms** — see active solver agents per challenge, read solver traces
- **Costs** — real-time cost breakdown by model and agent
- **Events** — live event log (new challenges, solves, errors)
- **Operator** — send hints and instructions to the coordinator mid-competition

#### Option B: CLI Only

```bash
uv run ctf-solve \
  --ctfd-url https://ctf.example.com \
  --ctfd-token ctfd_your_token \
  --challenges-dir challenges \
  --max-challenges 10 \
  -v
```

### Solving a Single Challenge

```bash
uv run ctf-solve --challenge challenges/my-challenge -v
```

### Sending Operator Messages

While the agent is running (CLI mode), you can send hints:

```bash
uv run ctf-msg "Focus on the RSA challenge, the key is weak" --port 9400
```

## Coordinator Backends

```bash
# Claude SDK coordinator (default)
uv run ctf-solve --coordinator claude ...
uv run ctf-dashboard --coordinator claude ...

# Codex coordinator (GPT-5.4 via JSON-RPC)
uv run ctf-solve --coordinator codex ...
uv run ctf-dashboard --coordinator codex ...
```

## Solver Models

Default model lineup (configurable in `backend/models.py`):

| Model | Provider | Notes |
|-------|----------|-------|
| Claude Opus 4.6 (medium) | Claude SDK | Balanced speed/quality |
| Claude Opus 4.6 (max) | Claude SDK | Deep reasoning |
| GPT-5.4 | Codex | Best overall solver |
| GPT-5.4-mini | Codex | Fast, good for easy challenges |
| GPT-5.3-codex | Codex | Reasoning model (xhigh effort) |

## Sandbox Tooling

Each solver gets an isolated Docker container pre-loaded with CTF tools:

| Category | Tools |
|----------|-------|
| **Binary** | radare2, GDB, objdump, binwalk, strings, readelf |
| **Pwn** | pwntools, ROPgadget, angr, unicorn, capstone |
| **Crypto** | SageMath, RsaCtfTool, z3, gmpy2, pycryptodome, cado-nfs |
| **Forensics** | volatility3, Sleuthkit (mmls/fls/icat), foremost, exiftool |
| **Stego** | steghide, stegseek, zsteg, ImageMagick, tesseract OCR |
| **Web** | curl, nmap, Python requests, flask |
| **Misc** | ffmpeg, sox, Pillow, numpy, scipy, PyTorch, podman |

## Features

- **Multi-model racing** — multiple AI models attack each challenge simultaneously
- **Web dashboard** — real-time UI to monitor progress, costs, and solver traces
- **Auto-spawn** — new challenges detected and attacked automatically
- **Coordinator LLM** — reads solver traces, crafts targeted technical guidance
- **Cross-solver insights** — findings shared between models via message bus
- **Docker sandboxes** — isolated containers with full CTF tooling
- **Operator messaging** — send hints to running solvers mid-competition
- **Cost tracking** — per-model token usage and cost breakdown

## Project Structure

```
ctf-agent/
├── backend/
│   ├── agents/            # Coordinator + solver implementations
│   │   ├── claude_coordinator.py
│   │   ├── claude_solver.py
│   │   ├── codex_coordinator.py
│   │   ├── codex_solver.py
│   │   ├── coordinator_core.py
│   │   ├── coordinator_loop.py
│   │   ├── solver.py      # Pydantic AI solver
│   │   └── swarm.py       # Challenge swarm (parallel solvers)
│   ├── tools/             # Solver tools (bash, flag submit, vision)
│   ├── api.py             # FastAPI REST + WebSocket API
│   ├── dashboard.py       # Dashboard CLI entry point
│   ├── cli.py             # Original CLI entry point
│   ├── config.py          # Settings (from .env)
│   ├── cost_tracker.py    # Token/cost tracking
│   ├── ctfd.py            # CTFd client
│   ├── models.py          # Model resolution
│   ├── poller.py          # CTFd challenge poller
│   ├── prompts.py         # System prompt builder
│   └── sandbox.py         # Docker sandbox management
├── frontend/
│   ├── index.html         # Dashboard HTML
│   ├── styles.css         # Dashboard CSS
│   └── app.js             # Dashboard JavaScript
├── sandbox/
│   ├── Dockerfile.sandbox # Sandbox container image
│   └── sandbox-tools.txt  # Tool list
├── .env.example           # Credential template
└── pyproject.toml         # Project configuration
```

## Configuration

Copy `.env.example` to `.env` and fill in your keys:

```bash
cp .env.example .env
```

```env
CTFD_URL=https://ctf.example.com
CTFD_TOKEN=ctfd_your_token
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
GEMINI_API_KEY=...
```

All settings can also be passed as environment variables or CLI flags.

## Requirements

- Python 3.14+
- Docker
- API keys for at least one provider (Anthropic, OpenAI, Google)
- `codex` CLI (for Codex solver/coordinator)
- `claude` CLI (bundled with claude-agent-sdk)

## Acknowledgements

- [es3n1n/Eruditus](https://github.com/es3n1n/Eruditus) — CTFd interaction and HTML helpers in `pull_challenges.py`
