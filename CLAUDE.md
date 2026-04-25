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

**Current state:** Week 2 of a 12-week build. Core infrastructure + board polish complete.
Real AI agents (Tavily + Claude) are NOT yet connected — placeholders exist.

---

## Monorepo Structure

```
orvexa/
├── frontend/        — Next.js 14 (App Router), Tailwind v4, React Flow
├── gateway/         — Node.js + Express + Socket.io (real-time layer)
├── agent-server/    — Python + FastAPI + arq (AI agents — not built yet)
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
**Status:** Folder scaffolded, venv created, packages installed. NO code written yet.
FastAPI + arq (Redis-backed job queue) will power the agents in Week 3.

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

### @ARIA trigger flow (current — placeholder):
```
User types "@ARIA [query]" → Chat.tsx detects → socket.emit('chat:message')
Gateway receives → detects @ARIA → setTimeout 1500ms
  → io.to(slug).emit('aria:status', {status: 'searching'})
  → creates 3 BoardCards with sessionId, queryText, findFreePosition slots
  → pushes cards to boardState[slug]
  → io.to(slug).emit('aria:status', {status: 'reading'})
  → streams cards 1-by-1 via board:card:new, 600ms apart
  → io.to(slug).emit('chat:message', {isAria: true, content: '...'})
  → 200ms after last card: aria:status 'done'
  → 2500ms later: aria:status 'idle'
```

### @ARIA trigger flow (Week 3 — real agents):
```
Gateway → POST /api/aria/trigger to Python agent server
Python → enqueues job in arq (Redis-backed)
Python → asyncio.gather() → 3 agents run in parallel:
  Search agent → Tavily API → publishes to Redis channel room:{slug}:findings
  Summarizer → Claude Sonnet API → publishes to Redis channel
  Fact-check → Tavily cross-reference → publishes to Redis channel
Node gateway → subscribes to Redis channel → socket.io broadcast → board updates
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
                              cluster frames, board toolbar with "Clear unpinned"
      Chat.tsx              — Chat sidebar. Messages, typing indicators, @ARIA highlighting
      ARIAAvatar.tsx        — Animated ARIA avatar. Reacts to aria:status socket events
  lib/
    socket.ts               — Socket.io singleton. Call getSocket() anywhere. autoConnect: false

gateway/
  src/
    index.ts                — Express server + Socket.io setup. Health check at /health
    events.ts               — ALL socket event handlers. Room, chat, board, ARIA placeholder.
                              boardState Map<slug, BoardCard[]> for in-memory board.
                              findFreePosition(existingCards, slotIndex): reverse-maps
                              card positions to a 3-col grid, returns slotIndex-th free
                              slot in reading order. ARIA cards tagged with sessionId +
                              queryText for frontend session clustering.
    roomManager.ts          — In-memory room state. Map<slug, Room>. Participant tracking.

agent-server/               — Empty for now. Python FastAPI + arq. Built in Week 3.

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

## What's Built (Weeks 1–2 Complete)

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

---

## What's NOT Built Yet

- Real ARIA agents (Tavily + Claude) — Week 3
- Python agent server — Week 3
- Redis pub/sub for agent results — Week 3
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

---

## Build Roadmap Summary

| Week | Focus | Status |
|---|---|---|
| 1 | Room + Chat + Board infrastructure | ✅ Complete |
| 2 | Board polish + card clustering | ✅ Complete |
| 3 | Real ARIA agents (Tavily + Claude) | ⬜ Next |
| 4 | Claude summarization + streaming | ⬜ |
| 5 | Parallel agents + arq queue | ⬜ |
| 6 | Synthesizer + Report generation | ⬜ |
| 7 | Auth (Clerk) + DB persistence | ⬜ |
| 8 | UI polish + error handling | ⬜ |
| 9 | pgvector deduplication | ⬜ |
| 10 | Monetization (Stripe) + analytics | ⬜ |
| 11 | Landing page + waitlist | ⬜ |
| 12 | Production deploy + demo video | ⬜ |
