# CLAUDE.md — Orvexa AI Assistant Context

This file is for AI assistants (Claude, Cursor, Copilot) working on the Orvexa codebase.
Read this entire file before making any changes. It explains what was built, why decisions
were made, what's broken, and what's coming next.

---

## What Is Orvexa

Orvexa is a multiplayer AI research workspace. Multiple users join a shared room via a
shareable link. They chat in real time. Any user can type `@ARIA [query]` to trigger an
AI agent that searches the web, summarizes results, and streams findings live onto a
shared visual board that all participants see simultaneously.

**One-liner for context:** "Figma meets Perplexity — a live research room where AI does
the searching while your team watches the board fill up in real time."

**Current state:** Week 4 of a 12-week build. Real AI agents live with full streaming —
Tavily search + Claude summarizer + fact-check stream text word-by-word onto the board.

---

## Monorepo Structure

```
orvexa/
├── frontend/        — Next.js 14 (App Router), Tailwind v4, React Flow
├── gateway/         — Node.js + Express + Socket.io (real-time layer)
├── agent-server/    — Python + FastAPI + arq (AI agents — BUILT Week 3)
│                      FastAPI on port 8000, arq worker subscribes to Redis
├── db/
│   └── init.sql     — PostgreSQL schema (runs on Docker start)
├── docker-compose.yml
└── CLAUDE.md        — this file
```

---

## Tech Stack — Every Decision Explained

### Frontend: Next.js 14 (App Router)
**Why:** App Router gives us server components, better routing, and built-in metadata.
We use it purely as a client-side app for now (all components are `'use client'`).
**Important:** Do NOT use the Pages Router. Everything is in `frontend/app/`.

### Styling: Tailwind CSS v4
**Why:** Fastest way to build consistent dark UI.
**Critical gotcha:** Tailwind v4 uses `@import "tailwindcss"` not `@tailwind base/components/utilities`.
Custom animation classes must be inside `@layer utilities {}` placed AFTER the import.
Do NOT place `@layer` before `@import` — it breaks all Tailwind styles.

### Real-time: Socket.io v4
**Why:** Simplest WebSocket library with built-in room management, reconnection, and
acknowledgment callbacks. We use Socket.io rooms that match the URL slug exactly.
**Pattern:** Gateway server is the single source of truth for all room state.
Client never updates state without a server event confirming it.

### Board: React Flow (@xyflow/react)
**Why:** Production-grade node-based canvas. Handles drag, zoom, pan out of the box.
**Critical gotcha:** `nodeTypes` object MUST be defined at MODULE level (outside any
component). If defined inside a component or passed inline, React Flow remounts the
entire canvas on every render, wiping all nodes. This caused our BUG-001 (see below).
**Another gotcha:** Node `data` must extend `Record<string, unknown>`. Use type casting
`as unknown as Record<string, unknown>` when passing typed card data.

### State management: useState + Socket events
**Why:** No Redux/Zustand needed yet. Board state lives in `useState<BoardCard[]>` in Board.tsx.
Room state (participants) lives in the room page. Chat messages live in Chat.tsx.
**Pattern:** Socket events drive all state updates. Never mutate state directly.
Always use functional updates: `setCards(prev => ...)`.
**Z-index:** `topZ` ref (incrementing counter) + `zIndices` Record<id, number> state.
`handleBringToFront` on pointer-down. Pinned cards get `base + 1000` offset.
**Session clustering:** `clusterSessions` derived via `useMemo([cards])` — bounding boxes
per `sessionId` for sessions with 2+ cards. Rendered as a frame layer under cards.

### Gateway: Node.js + Express + Socket.io
**Why:** Node handles WebSockets better than Python for the real-time layer.
Python is reserved for the AI agent server where async libraries are better.
**In-memory state:** Room state (participants, board cards) lives in Maps in memory.
This resets on server restart — acceptable for v1. Database persistence comes in Week 7.

### Database: PostgreSQL 16 + pgvector (Docker)
**Why:** pgvector extension allows semantic deduplication of board cards using cosine
similarity. Schema is in `db/init.sql`. Run via Docker — never connect to prod DB locally.
**Status:** Schema exists and Docker runs it, but gateway/agents don't write to it yet.
Writing to PostgreSQL comes in Week 7 (Auth + Persistence phase).

### Python Agent Server
**Why:** Python has better AI/ML library support than Node.
**Status:** Fully built (Week 3). FastAPI accepts trigger requests, arq enqueues jobs,
three agents run with two-phase parallel execution (search → summarizer + factcheck in
`asyncio.gather`). Each agent has a 30s timeout; failures produce error cards without
blocking the others.
**Critical gotcha:** The arq worker does NOT hot-reload. Restart it after any change to
`jobs.py` or any file under `agent_server/agents/`.
**Critical gotcha:** `redis.asyncio.from_url()` is a sync factory — do NOT `await` it.
**Critical gotcha:** Call `load_dotenv()` before any `os.environ` reads in every agent
file. The worker imports modules at startup before env vars are guaranteed to be loaded.

---

## Architecture — How Data Flows

### Room join flow:
```
Browser → socket.connect() → gateway
Browser → socket.emit('room:join', {slug, displayName})
Gateway → addParticipant() → socket.join(slug)
Gateway → callback({success, participants, board})
Gateway → socket.to(slug).emit('room:presence', {participants})
```

### @ARIA trigger flow (current — streaming agents):
```
User types "@ARIA [query]" → Chat.tsx → socket.emit('chat:message')
Gateway → detects @ARIA → emits aria:status 'searching'
Gateway → axios.POST http://localhost:8000/api/aria/trigger {slug, query, sessionId}
FastAPI → enqueues aria_job in arq (Redis-backed queue)
arq worker → picks up job → runs two-phase execution:
  Phase 1 (sequential): run_search() → Tavily API → up to 5 results
    Each result → redis.asyncio.publish(room:{slug}:findings, {type:'aria', ...card})
  Phase 2 (parallel): asyncio.gather(run_summarizer(), run_factcheck())
    Summarizer: generates card_id → publishes {type:'stream_start'} → streams Claude
      response → publishes {type:'stream_chunk', chunk} per delta → publishes
      {type:'stream_end'} in finally block (fires even on error)
    Factcheck: same pattern, but accumulates full text → in finally: parses
      CONFIDENCE score via regex, strips CONFIDENCE line, detects conflicts →
      publishes stream_end with {finalContent, confidenceScore, hasConflict}
  Each phase has 30s timeout → timeout/exception → error card or partial stream_end
  After gather: publish {type:'done'} to Redis channel
Gateway redis.ts → psubscribe('room:*:findings') → pmessage handler:
  type 'aria'/'error' → findFreePosition + push boardState + emit board:card:new
  type 'stream_start' → same activeSessions logic + create card with isStreaming:true
    using Python-provided cardId verbatim → push boardState → emit board:card:new
  type 'stream_chunk' → find card by cardId + append chunk to boardState content
    → emit board:card:content {cardId, chunk}
  type 'stream_end' → set isStreaming:false + apply finalContent/confidenceScore/
    hasConflict if present → emit board:card:complete {cardId, ...optional fields}
  First card of session → emit aria:status 'reading' (before emitting card)
  type 'done' → emit aria:status 'done' → 2500ms → emit aria:status 'idle'
Frontend Board.tsx:
  board:card:new → add card to state; if card.isStreaming: start 60s safety timer
  board:card:content → append chunk to card.content via setCards
  board:card:complete → cancel safety timer, set isStreaming:false, apply optional fields
  CardItem: shows blinking ▌ cursor (anim-aria-thinking) while card.isStreaming === true
    truncation disabled while streaming; cursor gone after board:card:complete

### Streaming Redis message schema:
  stream_start:  {type, cardId, agentType, title, sessionId, queryText, slug}
  stream_chunk:  {type, cardId, chunk, slug}
  stream_end:    {type, cardId, slug, confidenceScore?, hasConflict?, finalContent?}
  (stream_end optional fields only present when agent has values to report)
```

---

## Socket Events — Complete Reference

### Client → Server
| Event | Payload | Description |
|---|---|---|
| `room:create` | callback | Creates room, returns `{slug}` |
| `room:join` | `{slug, displayName}`, callback | Joins room |
| `room:leave` | none | Leaves room |
| `chat:message` | `{content}` | Sends chat message |
| `chat:typing:start` | none | User started typing |
| `chat:typing:stop` | none | User stopped typing |
| `board:card:pin` | `{cardId, pinned}` | Pin/unpin a card |
| `board:card:dismiss` | `{cardId}` | Remove card permanently |
| `board:card:move` | `{cardId, x, y}` | Card dragged to new position |
| `board:card:add` | `{title, content}` | Add manual card |

### Server → Client
| Event | Payload | Description |
|---|---|---|
| `room:presence` | `{participants, leftUser?, newHost?}` | Participant list updated |
| `chat:message` | `{id, senderId, senderName, content, timestamp, isAria, isAriatrigger}` | New message |
| `chat:system` | `{message, timestamp}` | System notification |
| `chat:typing` | `{users: string[]}` | Who is typing |
| `aria:status` | `{status: 'idle'\|'searching'\|'reading'\|'done'\|'error'}` | ARIA state |
| `board:card:new` | `{card: BoardCard}` | New card added to board |
| `board:card:update` | `{cardId, pinned}` | Card pin state changed |
| `board:card:dismiss` | `{cardId}` | Card removed |
| `board:card:move` | `{cardId, x, y}` | Card position changed |
| `board:card:content` | `{cardId, chunk}` | Streaming text chunk to append to card |
| `board:card:complete` | `{cardId, confidenceScore?, hasConflict?, finalContent?}` | Stream finished; cursor removed |

---

## File Map — Key Files and What They Do

```
frontend/
  app/
    page.tsx                — Landing page. Creates room via socket, redirects to /room/[slug]
    layout.tsx              — Root layout. Inter font, metadata, globals.css import
    globals.css             — Tailwind v4 import + custom animations (.anim-* classes)
    room/[slug]/page.tsx    — Main room page. Manages socket connection, participants,
                              renders Board + Chat + ARIAAvatar + participants sidebar
    components/
      Board.tsx             — Board canvas. React Flow background dots only. Cards are
                              plain position:absolute divs (BUG-001 fix). Manages:
                              BoardCard state, z-index stacking, pointer-events drag
                              with bounds clamping, pin/dismiss animations, session
                              cluster frames, board toolbar with "Clear unpinned".
                              Streaming: streamTimers ref (Map<cardId, timeout>),
                              board:card:content appends chunks, board:card:complete
                              finalizes. isStreaming flag on BoardCard shows ▌ cursor.
                              60s safety timer auto-clears cursor if stream_end missed.
      Chat.tsx              — Chat sidebar. Messages, typing indicators, @ARIA highlighting
      ARIAAvatar.tsx        — Animated ARIA avatar. Reacts to aria:status socket events
  lib/
    socket.ts               — Socket.io singleton. Call getSocket() anywhere. autoConnect: false

gateway/
  src/
    index.ts                — Express server + Socket.io setup. Health check at /health
    events.ts               — ALL socket event handlers. Room, chat, board events.
                              Exports boardState + findFreePosition for use by redis.ts.
                              @ARIA handler: emits 'searching', POSTs to Python, done.
                              BoardCard.type includes 'error' for agent failure cards.
    redis.ts                — ioredis subscriber. psubscribe('room:*:findings').
                              pmessage → parse slug from channel → dispatch by type:
                              'aria'/'error' → build card + emit board:card:new.
                              'stream_start' → build card with isStreaming:true using
                              Python-provided cardId + emit board:card:new.
                              'stream_chunk' → append chunk to boardState + emit
                              board:card:content {cardId, chunk}.
                              'stream_end' → set isStreaming:false + apply optional
                              finalContent/confidenceScore/hasConflict + emit
                              board:card:complete (only present fields emitted).
                              'done' → emit aria:status 'done' → 2500ms → 'idle'.
                              Tracks activeSessions for aria:status 'reading' once.
                              CRITICAL: call psubscribe() directly (not in connect handler)
                              — ioredis queues it. Putting it in connect re-subscribes
                              on every reconnect and caused BUG-003 (0 subscribers).
    roomManager.ts          — In-memory room state. Map<slug, Room>. Participant tracking.

agent-server/
  agent_server/
    main.py                 — FastAPI app. POST /api/aria/trigger → enqueue aria_job.
                              arq pool created in lifespan startup, stored on app.state.
    worker.py               — arq WorkerSettings. Parses REDIS_URL → RedisSettings.
                              Run: arq agent_server.worker.WorkerSettings
                              Must be restarted manually after any code change.
    jobs.py                 — aria_job: two-phase execution. Phase 1: run_search with
                              30s timeout. Phase 2: asyncio.gather(summarizer, factcheck)
                              both with 30s timeouts via _run_with_timeout helper.
                              Always publishes {type:'done'} at end. max_tries=1.
    redis_pub.py            — publish_finding(): creates redis.asyncio connection per
                              call (no module-level caching), publishes JSON, closes.
                              NOTE: from_url() is sync — do NOT await it.
    agents/
      search.py             — Tavily POST /search, max 5 results. Publishes each as
                              agentType:'search' card. Returns results list for Phase 2.
      summarizer.py         — Claude Sonnet streaming. Publishes stream_start → streams
                              chunks → stream_end in finally. Empty results → error card.
      factcheck.py          — Claude Sonnet streaming. Accumulates full text, then in
                              finally: parses CONFIDENCE via regex, strips line from
                              content, detects conflicts. stream_end carries finalContent
                              + confidenceScore + hasConflict. Partial stream on timeout
                              still fires finally → defaults confidence 0.5.

db/
  init.sql                  — Full PostgreSQL schema. 6 tables: rooms, participants,
                              aria_sessions, findings, boards, reports. pgvector for dedup.
```

---

## Known Bugs

### BUG-001: React Flow only renders 1 of 3 ARIA cards visually
**Status:** ✅ Resolved (Week 2)
**Root cause:** React Flow's internal Zustand reconciliation dropped rapid successive
`setNodes` calls (600ms apart). The internal node map was overwritten before re-render.
**Fix:** Replaced React Flow nodes with plain `position: absolute` divs in a separate
overlay div. React Flow is now used only for the background dot grid.

### BUG-002: Dragging cards doesn't work
**Status:** ✅ Resolved (Week 2, side effect of BUG-001 fix)
**Fix:** Cards use Pointer Events API (`onPointerDown/Move/Up` + `setPointerCapture`).
Bounds clamped to container via `clampPos()` in `CardItem`.

---

## What's Built (Weeks 1–3 Complete)

### Week 1 — Core infrastructure
- Room creation → unique slug → shareable URL
- Socket.io join/leave/presence — live participant list
- Host promotion when host leaves
- Text chat with real-time sync
- Typing indicators (debounced, 2s timeout)
- @ARIA detection and highlighting in chat
- ARIA placeholder response in chat
- ARIA avatar with animated status (idle/searching/reading/done)
- Board canvas shell (React Flow background dots only after BUG-001 fix)
- Manual note cards (+ Add note button)
- Landing page with feature pills
- Custom scrollbar + CSS animations

### Week 2 — Board polish + card clustering
- BUG-001 fixed: cards render as plain positioned divs, all 3 ARIA cards visible
- BUG-002 fixed: full drag-to-move via Pointer Events API with bounds clamping
- Smart card positioning: `findFreePosition` grid algorithm in gateway (3-col, reading order)
- Z-index stacking: bring-to-front on pointer-down, pinned cards float above all others
- Session clustering: ARIA cards grouped by `sessionId` with a shared frame overlay
- Card dismiss animation: `anim-card-dismiss` 200ms scale-out before removal
- Content truncation: "Show more / Show less" toggle at 120 chars
- Board toolbar: live card count + two-click "Clear unpinned" with 3s confirm timeout

### Week 3 — Real ARIA agents
- Python agent server: FastAPI + arq job queue
- Redis pub/sub bridge: gateway subscribes to `room:*:findings` via ioredis psubscribe
- Search agent: Tavily API, up to 5 real web results per query
- Summarizer agent: Claude Sonnet, 2-3 sentence summary from top 3 snippets
- Fact-check agent: Claude Sonnet, confidence score + conflict detection
- Two-phase parallel execution: search → asyncio.gather(summary, factcheck)
- Per-agent 30s timeouts: timeout/exception produces error card, others continue
- Error card visual style: red-tinted border + background, red title in Board.tsx
- `aria:status` lifecycle now data-driven: reading on first Redis card, done on Python signal

### Week 4 — Claude summarization + streaming
- Streaming summarizer: stream_start → stream_chunk per delta → stream_end in finally
- Streaming factcheck: same pattern + accumulates text → parses confidence + strips
  CONFIDENCE line + detects conflicts → stream_end carries finalContent/confidenceScore/hasConflict
- Gateway redis.ts: handles stream_start/stream_chunk/stream_end message types;
  emits board:card:content and board:card:complete socket events
- Frontend Board.tsx: board:card:content appends chunks live; board:card:complete
  finalizes card; blinking ▌ cursor while isStreaming; truncation disabled during stream
- 60s safety timer per streaming card — auto-clears cursor if stream_end never arrives
- Interruption resilience: arq kill → partial content stays + cursor auto-clears after 60s;
  agent-server down → W2 5s fallback timer returns avatar to idle; Redis restart → ioredis
  reconnects automatically, next query works normally

---

## What's NOT Built Yet

- PostgreSQL writes — Week 7
- Auth (Clerk) — Week 7
- Report generation — Week 6
- Payments (Stripe) — Week 10
- pgvector semantic deduplication — Week 9

---

## Local Dev — How to Run Everything

### Prerequisites
- Node v22+ / npm v11+
- Python 3.13+ with venv
- Docker Desktop running

### Start all services:

```powershell
# Terminal 1 — Database + Redis
cd D:\Claude\Projects\orvexa
docker compose up -d

# Terminal 2 — Gateway
cd D:\Claude\Projects\orvexa\gateway
npm run dev

# Terminal 3 — Frontend
cd D:\Claude\Projects\orvexa\frontend
npm run dev

# Terminal 4 — Agent server (FastAPI)
cd D:\Claude\Projects\orvexa\agent-server
venv\Scripts\activate
uvicorn agent_server.main:app --port 8000 --reload

# Terminal 5 — arq worker (NO hot reload — restart manually after code changes)
cd D:\Claude\Projects\orvexa\agent-server
venv\Scripts\activate
arq agent_server.worker.WorkerSettings
```

### Ports:
- Frontend: http://localhost:3000
- Gateway: http://localhost:4000
- Gateway health: http://localhost:4000/health
- PostgreSQL: localhost:5432
- Redis: localhost:6379

### Environment files:
- `frontend/.env.local` — NEXT_PUBLIC_GATEWAY_URL
- `gateway/.env` — PORT, AGENT_SERVER_URL, REDIS_URL
- `agent-server/.env` — ANTHROPIC_API_KEY, TAVILY_API_KEY, DATABASE_URL, REDIS_URL

---

## Critical Rules for AI Assistants

1. **Never move `nodeTypes` inside a React component.** It must stay at module level.
   Doing so causes React Flow to remount the canvas on every render.

2. **Never call `setState` synchronously inside a `useEffect` body.** Use the useState
   lazy initializer pattern instead: `useState(() => computeInitialValue())`.

3. **Tailwind v4 rule:** `@import "tailwindcss"` must be the first line of globals.css.
   All `@layer` blocks come after. Custom animation classes use `.anim-` prefix not
   `animate-` because Tailwind v4 doesn't auto-generate unknown animate- classes.

4. **Socket cleanup:** Always call `socket.off('event')` before `socket.on('event')`
   inside useEffect. React StrictMode double-invokes effects in development, causing
   duplicate listeners if you don't clean up first.

5. **Gateway is source of truth.** Never trust client-side state for critical operations.
   All room state lives in `roomManager.ts`. Board state lives in the `boardState` Map
   in `events.ts`. Both reset on server restart (acceptable for v1).

6. **Board cards are NOT React Flow nodes.** Cards are plain `position: absolute` divs
   rendered in an overlay div over the React Flow canvas. Do not add cards as RF nodes.
   React Flow is used only for the dot-grid background (empty `<ReactFlow nodes={[]} />`).

7. **Do not add voice/video in v1.** This is explicitly out of scope. WebRTC complexity
   would add 4-6 weeks. Deferred to v2.

8. **Do not add auth in v1.** Clerk integration is planned for Week 7. All room
   joining is session-based with display names only.

9. **ioredis psubscribe must be called directly, not inside the `connect` handler.**
   ioredis queues commands until connected. Calling psubscribe in the connect handler
   causes re-subscription on every reconnect. This was BUG-003 (Week 3) — gateway
   showed 0 Redis subscribers because the connect event wasn't firing as expected.

10. **arq worker does not hot-reload.** Restart `arq agent_server.worker.WorkerSettings`
    manually after any change to `jobs.py` or any agent file. uvicorn `--reload` only
    restarts FastAPI, not the worker process.

---

## Build Roadmap Summary

| Week | Focus | Status |
|---|---|---|
| 1 | Room + Chat + Board infrastructure | ✅ Complete |
| 2 | Board polish + card clustering | ✅ Complete |
| 3 | Real ARIA agents (Tavily + Claude) | ✅ Complete |
| 4 | Claude summarization + streaming | ✅ Complete |
| 5 | Parallel agents + arq queue | ⬜ Next |
| 6 | Synthesizer + Report generation | ⬜ |
| 7 | Auth (Clerk) + DB persistence | ⬜ |
| 8 | UI polish + error handling | ⬜ |
| 9 | pgvector deduplication | ⬜ |
| 10 | Monetization (Stripe) + analytics | ⬜ |
| 11 | Landing page + waitlist | ⬜ |
| 12 | Production deploy + demo video | ⬜ |
