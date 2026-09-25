/* ═══════════════════════════════════════════════════════════════════════════
   CTF Agent Dashboard — Client Application
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
    'use strict';

    // ─── State ───────────────────────────────────────────────────────────
    const state = {
        ws: null,
        connected: false,
        challenges: [],
        swarms: {},
        events: [],
        messages: [],
        activeFilter: 'all',
        searchQuery: '',
        startTime: Date.now(),
        uptimeInterval: null,
        pollInterval: null,
    };

    // ─── DOM Helpers ─────────────────────────────────────────────────────
    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => document.querySelectorAll(sel);
    const el = (tag, attrs = {}, children = []) => {
        const e = document.createElement(tag);
        Object.entries(attrs).forEach(([k, v]) => {
            if (k === 'className') e.className = v;
            else if (k === 'textContent') e.textContent = v;
            else if (k === 'innerHTML') e.innerHTML = v;
            else if (k.startsWith('on')) e.addEventListener(k.slice(2).toLowerCase(), v);
            else e.setAttribute(k, v);
        });
        children.forEach(c => {
            if (typeof c === 'string') e.appendChild(document.createTextNode(c));
            else if (c) e.appendChild(c);
        });
        return e;
    };

    function formatTime(ts) {
        const d = new Date(ts * 1000);
        return d.toLocaleTimeString('en-US', { hour12: false });
    }

    function formatDuration(seconds) {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }

    function formatTokens(n) {
        if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
        if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
        return String(n);
    }

    function stripHtml(html) {
        const tmp = document.createElement('div');
        tmp.innerHTML = html;
        return tmp.textContent || tmp.innerText || '';
    }

    // ─── SVG Gradient ────────────────────────────────────────────────────
    function injectSVGGradient() {
        const svg = document.querySelector('.progress-ring');
        if (!svg) return;
        const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
        defs.innerHTML = `
            <linearGradient id="progress-gradient" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stop-color="#10b981" />
                <stop offset="100%" stop-color="#06b6d4" />
            </linearGradient>
        `;
        svg.prepend(defs);
    }

    // ─── Navigation ──────────────────────────────────────────────────────
    function setupNavigation() {
        $$('.nav-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const panel = btn.dataset.panel;
                $$('.nav-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                $$('.panel').forEach(p => p.classList.remove('active'));
                $(`#panel-${panel}`).classList.add('active');

                // Load data for the panel
                if (panel === 'challenges') fetchChallenges();
                if (panel === 'swarms') fetchSwarms();
                if (panel === 'costs') fetchCosts();
                if (panel === 'logs') fetchEvents();
            });
        });
    }

    // ─── WebSocket ───────────────────────────────────────────────────────
    function connectWebSocket() {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const url = `${proto}//${location.host}/ws`;

        try {
            state.ws = new WebSocket(url);
        } catch (e) {
            updateConnectionStatus(false);
            setTimeout(connectWebSocket, 3000);
            return;
        }

        state.ws.onopen = () => {
            state.connected = true;
            updateConnectionStatus(true);
        };

        state.ws.onmessage = (evt) => {
            try {
                const data = JSON.parse(evt.data);
                handleWSEvent(data);
            } catch (e) {
                console.warn('WS parse error:', e);
            }
        };

        state.ws.onclose = () => {
            state.connected = false;
            updateConnectionStatus(false);
            setTimeout(connectWebSocket, 3000);
        };

        state.ws.onerror = () => {
            state.connected = false;
            updateConnectionStatus(false);
        };

        // Keepalive ping
        setInterval(() => {
            if (state.ws && state.ws.readyState === WebSocket.OPEN) {
                state.ws.send('ping');
            }
        }, 30000);
    }

    function updateConnectionStatus(connected) {
        const el = $('#ws-status');
        el.className = `connection-status ${connected ? 'connected' : 'disconnected'}`;
        el.querySelector('.status-text').textContent = connected ? 'Connected' : 'Disconnected';
    }

    function handleWSEvent(data) {
        if (data.type === 'init') {
            // Initial state dump from server
            return;
        }
        if (data.type === 'pong') return;

        // Add to event log
        addEvent(data);

        // Refresh relevant panels
        fetchStatus();
    }

    // ─── Event Log ───────────────────────────────────────────────────────
    function addEvent(event) {
        state.events.unshift(event);
        if (state.events.length > 500) state.events.length = 500;

        // Update activity feed on overview
        renderActivityFeed();

        // If events panel is active, render there too
        if ($('#panel-logs').classList.contains('active')) {
            renderEventLog();
        }
    }

    function renderActivityFeed() {
        const feed = $('#activity-feed');
        const recent = state.events.slice(0, 10);
        if (recent.length === 0) return;

        feed.innerHTML = '';
        recent.forEach(evt => {
            const icon = getEventIcon(evt.type);
            const text = getEventText(evt);
            const time = evt.ts ? formatTime(evt.ts) : '';

            feed.appendChild(el('div', { className: 'activity-item' }, [
                el('span', { className: 'activity-icon', textContent: icon }),
                el('span', { className: 'activity-text', textContent: text }),
                el('span', { className: 'activity-time', textContent: time }),
            ]));
        });
    }

    function renderEventLog() {
        const log = $('#event-log');
        log.innerHTML = '';

        if (state.events.length === 0) {
            log.innerHTML = '<div class="activity-empty">Waiting for events...</div>';
            return;
        }

        state.events.forEach(evt => {
            const cssClass = getEventClass(evt.type);
            const time = evt.ts ? formatTime(evt.ts) : '';
            const text = getEventText(evt);

            log.appendChild(el('div', { className: `event-entry ${cssClass}` }, [
                el('span', { className: 'event-time', textContent: `[${time}]` }),
                document.createTextNode(` ${text}`),
            ]));
        });
    }

    function getEventIcon(type) {
        const icons = {
            swarm_spawned: '🐝',
            swarm_killed: '💀',
            operator_message: '💬',
            challenge_solved: '🏆',
            new_challenge: '🆕',
        };
        return icons[type] || '📌';
    }

    function getEventClass(type) {
        if (type?.includes('solved')) return 'type-solved';
        if (type?.includes('spawn')) return 'type-spawn';
        if (type?.includes('kill')) return 'type-kill';
        if (type?.includes('message')) return 'type-message';
        return '';
    }

    function getEventText(evt) {
        switch (evt.type) {
            case 'swarm_spawned':
                return `Swarm spawned for "${evt.challenge}" — ${evt.result || ''}`;
            case 'swarm_killed':
                return `Swarm killed for "${evt.challenge}"`;
            case 'operator_message':
                return `Operator: ${evt.message}`;
            case 'challenge_solved':
                return `Challenge solved: ${evt.challenge}`;
            case 'new_challenge':
                return `New challenge: ${evt.challenge}`;
            default:
                return JSON.stringify(evt).slice(0, 120);
        }
    }

    // ─── API Calls ───────────────────────────────────────────────────────
    async function apiFetch(path) {
        try {
            const resp = await fetch(`/api${path}`);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            return await resp.json();
        } catch (e) {
            console.warn(`API error (${path}):`, e);
            return null;
        }
    }

    async function apiPost(path, body = {}) {
        try {
            const resp = await fetch(`/api${path}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            return await resp.json();
        } catch (e) {
            console.warn(`API POST error (${path}):`, e);
            return null;
        }
    }

    // ─── Fetch & Render: Status ──────────────────────────────────────────
    async function fetchStatus() {
        const data = await apiFetch('/status');
        if (!data || data.error) return;

        // Top bar stats
        $('#solved-count').textContent = data.solved_count;
        $('#unsolved-count').textContent = data.unsolved_count;
        $('#active-swarm-count').textContent = data.active_swarm_count;
        $('#total-cost').textContent = `$${data.total_cost_usd.toFixed(2)}`;

        // Overview panel
        $('#overview-total').textContent = data.total_challenges;
        $('#overview-solved').textContent = data.solved_count;
        $('#overview-unsolved').textContent = data.unsolved_count;
        $('#overview-models').textContent = data.models ? data.models.length : 0;
        $('#ctfd-url').textContent = data.ctfd_url || '';

        // Progress ring
        const pct = data.total_challenges > 0
            ? Math.round((data.solved_count / data.total_challenges) * 100)
            : 0;
        $('#progress-pct').textContent = `${pct}%`;
        const circumference = 2 * Math.PI * 85; // r=85
        const offset = circumference - (pct / 100) * circumference;
        $('#progress-ring-fill').style.strokeDashoffset = offset;

        // Uptime
        if (data.uptime_s) {
            state.startTime = Date.now() - data.uptime_s * 1000;
        }
    }

    // ─── Fetch & Render: Challenges ──────────────────────────────────────
    async function fetchChallenges() {
        const data = await apiFetch('/challenges');
        if (!data || !data.challenges) return;

        state.challenges = data.challenges;
        renderChallenges();
        renderCategoryGrid();
    }

    function renderChallenges() {
        const grid = $('#challenge-grid');
        let items = [...state.challenges];

        // Filter
        if (state.activeFilter === 'solved') items = items.filter(c => c.solved);
        else if (state.activeFilter === 'unsolved') items = items.filter(c => !c.solved);
        else if (state.activeFilter === 'active') items = items.filter(c => c.has_swarm);

        // Search
        if (state.searchQuery) {
            const q = state.searchQuery.toLowerCase();
            items = items.filter(c =>
                c.name.toLowerCase().includes(q) ||
                c.category.toLowerCase().includes(q)
            );
        }

        // Sort: unsolved first, then by category
        items.sort((a, b) => {
            if (a.solved !== b.solved) return a.solved ? 1 : -1;
            return a.category.localeCompare(b.category) || a.name.localeCompare(b.name);
        });

        grid.innerHTML = '';
        if (items.length === 0) {
            grid.innerHTML = '<div class="activity-empty">No challenges match your filters.</div>';
            return;
        }

        items.forEach(ch => {
            const classes = ['challenge-card'];
            if (ch.solved) classes.push('solved');
            if (ch.has_swarm) classes.push('active');

            const card = el('div', { className: classes.join(' ') }, [
                el('div', { className: 'challenge-name', textContent: ch.name }),
                el('div', { className: 'challenge-meta' }, [
                    el('span', { className: 'challenge-tag category', textContent: ch.category || '—' }),
                    el('span', { className: 'challenge-tag points', textContent: `${ch.value} pts` }),
                    el('span', { className: 'challenge-tag solves', textContent: `${ch.solves} solves` }),
                ]),
                el('div', { className: 'challenge-desc', textContent: stripHtml(ch.description || 'No description') }),
                el('div', { className: 'challenge-actions' }, [
                    !ch.has_swarm && !ch.solved
                        ? el('button', {
                            className: 'btn btn-spawn',
                            textContent: '🐝 Spawn Swarm',
                            onClick: (e) => { e.stopPropagation(); spawnSwarm(ch.name); },
                        })
                        : null,
                    ch.has_swarm
                        ? el('button', {
                            className: 'btn btn-kill',
                            textContent: '✕ Kill',
                            onClick: (e) => { e.stopPropagation(); killSwarm(ch.name); },
                        })
                        : null,
                ].filter(Boolean)),
            ]);

            grid.appendChild(card);
        });
    }

    function renderCategoryGrid() {
        const grid = $('#category-grid');
        const categories = {};

        state.challenges.forEach(ch => {
            const cat = ch.category || 'misc';
            if (!categories[cat]) categories[cat] = { total: 0, solved: 0 };
            categories[cat].total++;
            if (ch.solved) categories[cat].solved++;
        });

        grid.innerHTML = '';
        Object.entries(categories).sort((a, b) => a[0].localeCompare(b[0])).forEach(([name, stats]) => {
            const pct = stats.total > 0 ? Math.round((stats.solved / stats.total) * 100) : 0;

            grid.appendChild(el('div', { className: 'category-card' }, [
                el('div', { className: 'category-name', textContent: name }),
                el('div', { className: 'category-bar' }, [
                    el('div', { className: 'category-bar-fill', style: `width: ${pct}%` }),
                ]),
                el('div', { className: 'category-stats' }, [
                    el('span', { textContent: `${stats.solved}/${stats.total}` }),
                    el('span', { textContent: `${pct}%` }),
                ]),
            ]));
        });
    }

    // ─── Fetch & Render: Swarms ──────────────────────────────────────────
    async function fetchSwarms() {
        const data = await apiFetch('/swarms');
        if (!data || !data.swarms) return;

        state.swarms = data.swarms;
        renderSwarms();
    }

    function renderSwarms() {
        const grid = $('#swarm-grid');
        const entries = Object.entries(state.swarms);

        if (entries.length === 0) {
            grid.innerHTML = '<div class="activity-empty">No active swarms. Spawn one from the Challenges panel.</div>';
            return;
        }

        grid.innerHTML = '';
        entries.forEach(([name, swarm]) => {
            const isRunning = !swarm.cancelled && !swarm.task_done;
            const hasWinner = !!swarm.winner;
            const statusText = hasWinner ? 'solved' : (isRunning ? 'running' : 'finished');
            const statusClass = hasWinner ? 'finished' : (isRunning ? 'running' : 'cancelled');

            const agentCards = Object.entries(swarm.agents || {}).map(([spec, info]) => {
                const agentStatusClass = info.status === 'won' ? 'won' : (info.status === 'running' ? 'running' : '');

                return el('div', {
                    className: 'agent-card',
                    onClick: () => showTrace(name, spec),
                }, [
                    el('div', { className: 'agent-model', textContent: spec }),
                    el('div', { className: `agent-status ${agentStatusClass}`, textContent: `● ${info.status}` }),
                    info.findings
                        ? el('div', { className: 'agent-findings', textContent: info.findings })
                        : null,
                    el('button', { className: 'btn btn-trace', textContent: '📜 Trace', onClick: (e) => { e.stopPropagation(); showTrace(name, spec); } }),
                ].filter(Boolean));
            });

            const card = el('div', { className: 'swarm-card' }, [
                el('div', { className: 'swarm-header' }, [
                    el('div', { className: 'swarm-name', textContent: name }),
                    el('div', { className: 'swarm-actions', innerHTML: '' }, [
                        isRunning ? el('button', {
                            className: 'btn btn-kill',
                            textContent: '✕ Kill',
                            onClick: () => killSwarm(name),
                        }) : null,
                        el('span', { className: `swarm-status-badge ${statusClass}`, textContent: statusText }),
                    ].filter(Boolean)),
                ]),
                hasWinner ? el('div', {
                    className: 'activity-item',
                    innerHTML: `<span class="activity-icon">🏆</span><span class="activity-text" style="color:var(--accent-green);font-weight:700;">FLAG: ${swarm.winner}</span>`,
                }) : null,
                el('div', { className: 'swarm-agents' }, agentCards),
            ].filter(Boolean));

            grid.appendChild(card);
        });
    }

    // ─── Fetch & Render: Costs ───────────────────────────────────────────
    async function fetchCosts() {
        const data = await apiFetch('/costs');
        if (!data) return;

        $('#cost-hero-total').textContent = `$${data.total_cost_usd.toFixed(2)}`;
        $('#cost-hero-tokens').textContent = formatTokens(data.total_tokens);

        // By Model table
        const modelContainer = $('#cost-by-model');
        const modelEntries = Object.entries(data.by_model || {});
        if (modelEntries.length === 0) {
            modelContainer.innerHTML = '<div class="activity-empty">No cost data yet.</div>';
        } else {
            const table = el('table', { className: 'cost-table' });
            table.innerHTML = `
                <thead><tr>
                    <th>Model</th><th>Cost</th><th>Input</th><th>Cached</th><th>Output</th>
                </tr></thead>
            `;
            const tbody = el('tbody');
            modelEntries.forEach(([model, s]) => {
                const tr = el('tr');
                tr.innerHTML = `
                    <td class="mono">${model}</td>
                    <td class="mono cost-value">$${s.cost.toFixed(4)}</td>
                    <td class="mono">${formatTokens(s.input)}</td>
                    <td class="mono">${formatTokens(s.cached)}</td>
                    <td class="mono">${formatTokens(s.output)}</td>
                `;
                tbody.appendChild(tr);
            });
            table.appendChild(tbody);
            modelContainer.innerHTML = '';
            modelContainer.appendChild(table);
        }

        // By Agent table
        const agentContainer = $('#cost-by-agent');
        const agentEntries = Object.entries(data.by_agent || {});
        if (agentEntries.length === 0) {
            agentContainer.innerHTML = '<div class="activity-empty">No agent data yet.</div>';
        } else {
            const table = el('table', { className: 'cost-table' });
            table.innerHTML = `
                <thead><tr>
                    <th>Agent</th><th>Model</th><th>Cost</th><th>Input</th><th>Output</th><th>Duration</th>
                </tr></thead>
            `;
            const tbody = el('tbody');
            agentEntries.forEach(([name, a]) => {
                const tr = el('tr');
                tr.innerHTML = `
                    <td class="mono">${name}</td>
                    <td class="mono">${a.model}</td>
                    <td class="mono cost-value">$${a.cost_usd.toFixed(4)}</td>
                    <td class="mono">${formatTokens(a.input_tokens)}</td>
                    <td class="mono">${formatTokens(a.output_tokens)}</td>
                    <td class="mono">${a.duration_s}s</td>
                `;
                tbody.appendChild(tr);
            });
            table.appendChild(tbody);
            agentContainer.innerHTML = '';
            agentContainer.appendChild(table);
        }
    }

    // ─── Fetch & Render: Events ──────────────────────────────────────────
    async function fetchEvents() {
        const data = await apiFetch('/events?last_n=200');
        if (!data || !data.events) return;

        // Merge with local events, deduplicate by timestamp
        data.events.forEach(evt => {
            if (!state.events.some(e => e.ts === evt.ts && e.type === evt.type)) {
                state.events.push(evt);
            }
        });
        state.events.sort((a, b) => (b.ts || 0) - (a.ts || 0));
        renderEventLog();
    }

    // ─── Actions ─────────────────────────────────────────────────────────
    async function spawnSwarm(name) {
        const data = await apiPost(`/spawn/${encodeURIComponent(name)}`);
        if (data) {
            addEvent({ type: 'swarm_spawned', challenge: name, result: data.result, ts: Date.now() / 1000 });
            fetchSwarms();
            fetchStatus();
        }
    }

    async function killSwarm(name) {
        const data = await apiPost(`/kill/${encodeURIComponent(name)}`);
        if (data) {
            addEvent({ type: 'swarm_killed', challenge: name, ts: Date.now() / 1000 });
            fetchSwarms();
            fetchStatus();
        }
    }

    async function sendMessage() {
        const textarea = $('#operator-message');
        const message = textarea.value.trim();
        if (!message) return;

        const data = await apiPost('/message', { message });
        if (data && data.ok) {
            state.messages.unshift({
                text: message,
                time: Date.now() / 1000,
                response: 'Queued',
            });
            textarea.value = '';
            renderMessages();
        }
    }

    function renderMessages() {
        const container = $('#message-history');
        if (state.messages.length === 0) {
            container.innerHTML = '<div class="activity-empty">No messages sent yet.</div>';
            return;
        }

        container.innerHTML = '';
        state.messages.forEach(msg => {
            container.appendChild(el('div', { className: 'message-item' }, [
                el('div', { className: 'message-item-time', textContent: formatTime(msg.time) }),
                el('div', { className: 'message-item-text', textContent: msg.text }),
                msg.response ? el('div', { className: 'message-item-response', textContent: `→ ${msg.response}` }) : null,
            ].filter(Boolean)));
        });
    }

    // ─── Trace Modal ─────────────────────────────────────────────────────
    async function showTrace(challengeName, modelSpec) {
        const overlay = $('#modal-overlay');
        const title = $('#modal-title');
        const trace = $('#modal-trace');

        title.textContent = `${challengeName} — ${modelSpec}`;
        trace.textContent = 'Loading trace...';
        overlay.classList.add('active');

        const data = await apiFetch(`/logs/${encodeURIComponent(challengeName)}/${encodeURIComponent(modelSpec)}?last_n=100`);
        if (data && data.trace) {
            trace.textContent = data.trace;
        } else {
            trace.textContent = 'No trace data available.';
        }
    }

    function closeModal() {
        $('#modal-overlay').classList.remove('active');
    }

    // ─── Uptime Clock ────────────────────────────────────────────────────
    function startUptimeClock() {
        state.uptimeInterval = setInterval(() => {
            const elapsed = (Date.now() - state.startTime) / 1000;
            $('#uptime').textContent = formatDuration(elapsed);
        }, 1000);
    }

    // ─── Auto-Refresh Polling ────────────────────────────────────────────
    function startPolling() {
        // Fetch status every 5 seconds
        state.pollInterval = setInterval(() => {
            fetchStatus();

            // Refresh active panel data
            const activePanel = document.querySelector('.panel.active');
            if (!activePanel) return;

            switch (activePanel.id) {
                case 'panel-swarms': fetchSwarms(); break;
                case 'panel-costs': fetchCosts(); break;
            }
        }, 5000);
    }

    // ─── Filter & Search Handlers ────────────────────────────────────────
    function setupFilters() {
        $$('.filter-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                $$('.filter-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                state.activeFilter = btn.dataset.filter;
                renderChallenges();
            });
        });

        const search = $('#challenge-search');
        if (search) {
            search.addEventListener('input', (e) => {
                state.searchQuery = e.target.value;
                renderChallenges();
            });
        }
    }

    // ─── Initialize ──────────────────────────────────────────────────────
    function init() {
        injectSVGGradient();
        setupNavigation();
        setupFilters();

        // Modal close
        $('#modal-close').addEventListener('click', closeModal);
        $('#modal-overlay').addEventListener('click', (e) => {
            if (e.target === e.currentTarget) closeModal();
        });

        // Operator send
        $('#btn-send-message').addEventListener('click', sendMessage);
        $('#operator-message').addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) sendMessage();
        });

        // Swarm refresh
        $('#btn-refresh-swarms').addEventListener('click', fetchSwarms);

        // Clear events
        $('#btn-clear-events').addEventListener('click', () => {
            state.events = [];
            renderEventLog();
        });

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closeModal();
        });

        // Initial data load
        fetchStatus();
        fetchChallenges();

        // Start WebSocket, clock, and polling
        connectWebSocket();
        startUptimeClock();
        startPolling();
    }

    // Boot
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
