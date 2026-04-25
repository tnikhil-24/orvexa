import { Server, Socket } from 'socket.io'
import {
  createRoom,
  addParticipant,
  removeParticipant,
  getParticipants,
  roomExists,
} from './roomManager'

// Track who is typing per room
const typingUsers = new Map<string, Set<string>>()

// Track board state per room (in memory)
// key = roomSlug, value = array of cards
interface BoardCard {
  id: string
  type: 'aria' | 'manual'
  agentType?: string
  title: string
  content: string
  sourceUrl?: string
  sourceTitle?: string
  confidenceScore?: number
  hasConflict?: boolean
  pinned: boolean
  position: { x: number; y: number }
  sessionId?: string
  queryText?: string
  createdBy: string
  createdAt: string
}

const boardState = new Map<string, BoardCard[]>()

// ── Grid constants ────────────────────────────────────────────
const COLS     = 3
const CARD_W   = 260  // card width (240px) + gap (20px)
const ROW_H    = 180
const ORIGIN_X = 80
const ORIGIN_Y = 80

function findFreePosition(
  existingCards: BoardCard[],
  slotIndex: number
): { x: number; y: number } {
  const occupied = new Set<string>()
  for (const card of existingCards) {
    const col = Math.round((card.position.x - ORIGIN_X) / CARD_W)
    const row = Math.round((card.position.y - ORIGIN_Y) / ROW_H)
    if (col >= 0 && col < COLS && row >= 0) {
      occupied.add(`${col},${row}`)
    }
  }

  let found = 0
  for (let row = 0; row < 100; row++) {
    for (let col = 0; col < COLS; col++) {
      if (!occupied.has(`${col},${row}`)) {
        if (found === slotIndex) {
          return { x: ORIGIN_X + col * CARD_W, y: ORIGIN_Y + row * ROW_H }
        }
        found++
      }
    }
  }

  // Fallback: should never be reached with a 100-row grid
  return { x: ORIGIN_X + (slotIndex % COLS) * CARD_W, y: ORIGIN_Y + Math.floor(slotIndex / COLS) * ROW_H }
}

export function registerEvents(io: Server, socket: Socket): void {

  // ── ROOM: CREATE ─────────────────────────────────────────
  socket.on('room:create', (callback: (data: { slug: string }) => void) => {
    const room = createRoom()
    console.log(`[room:create] New room created: ${room.slug}`)
    callback({ slug: room.slug })
  })

  // ── ROOM: JOIN ───────────────────────────────────────────
  socket.on('room:join', (
    data: { slug: string; displayName: string },
    callback: (data: {
      success: boolean
      error?: string
      participants?: ReturnType<typeof getParticipants>
      board?: BoardCard[]
    }) => void
  ) => {
    const { slug, displayName } = data

    if (!roomExists(slug)) {
      callback({ success: false, error: 'Room not found' })
      return
    }

    if (!displayName || displayName.trim().length === 0) {
      callback({ success: false, error: 'Display name is required' })
      return
    }

    if (displayName.trim().length > 30) {
      callback({ success: false, error: 'Display name must be 30 characters or less' })
      return
    }

    const participant = addParticipant(slug, socket.id, displayName.trim())
    if (!participant) {
      callback({ success: false, error: 'Room is locked or full' })
      return
    }

    socket.join(slug)
    socket.data.slug = slug
    socket.data.displayName = displayName.trim()

    if (!typingUsers.has(slug)) {
      typingUsers.set(slug, new Set())
    }

    // Initialize board for this room if needed
    if (!boardState.has(slug)) {
      boardState.set(slug, [])
    }

    const participants = getParticipants(slug)
    const board = boardState.get(slug) || []

    console.log(`[room:join] ${displayName} joined room: ${slug} (${participants.length} total)`)

    // Send participant list AND current board state to joining user
    callback({ success: true, participants, board })

    socket.to(slug).emit('room:presence', { participants })

    io.to(slug).emit('chat:system', {
      message: `${displayName.trim()} joined the room`,
      timestamp: new Date().toISOString(),
    })
  })

  // ── CHAT: MESSAGE ─────────────────────────────────────────
  socket.on('chat:message', (data: { content: string }) => {
    const slug = socket.data.slug
    const displayName = socket.data.displayName

    if (!slug || !displayName) return

    const content = data.content?.trim()
    if (!content || content.length === 0) return
    if (content.length > 1000) return

    const typing = typingUsers.get(slug)
    if (typing) {
      typing.delete(displayName)
      io.to(slug).emit('chat:typing', { users: Array.from(typing) })
    }

    const isAriatrigger = content.toLowerCase().startsWith('@aria')

    const message = {
      id: `${Date.now()}-${socket.id}`,
      senderId: socket.id,
      senderName: displayName,
      content,
      timestamp: new Date().toISOString(),
      isAria: false,
      isAriatrigger,
    }

    console.log(`[chat:message] ${displayName} in ${slug}: ${content.substring(0, 50)}`)

    io.to(slug).emit('chat:message', message)

    if (isAriatrigger) {
      const query = content.replace(/@aria\s*/i, '').trim()

      io.to(slug).emit('aria:status', { status: 'searching' })

      // Simulate ARIA dropping cards onto the board (placeholder until Week 3)
      setTimeout(() => {
        const ts = Date.now()
        const board = boardState.get(slug) || []
        const sessionId = `session-${ts}`
        const queryText = query

        const cards: BoardCard[] = [
          {
            id: `card-${ts}-1`,
            type: 'aria',
            agentType: 'search',
            title: `Search result for: "${query}"`,
            content: 'Real search results coming in Week 3 when the Python agent server is connected.',
            sourceUrl: 'https://example.com',
            sourceTitle: 'Example Source',
            confidenceScore: 0.85,
            hasConflict: false,
            pinned: false,
            position: findFreePosition(board, 0),
            sessionId,
            queryText,
            createdBy: 'ARIA',
            createdAt: new Date().toISOString(),
          },
          {
            id: `card-${ts}-2`,
            type: 'aria',
            agentType: 'summary',
            title: 'AI Summary',
            content: `Summary of findings for "${query}" will appear here once agents are connected.`,
            confidenceScore: 0.78,
            hasConflict: false,
            pinned: false,
            position: findFreePosition(board, 1),
            sessionId,
            queryText,
            createdBy: 'ARIA',
            createdAt: new Date().toISOString(),
          },
          {
            id: `card-${ts}-3`,
            type: 'aria',
            agentType: 'factcheck',
            title: 'Fact Check',
            content: 'Fact-check results will appear here. Confidence scores and conflict flags coming in Week 3.',
            confidenceScore: 0.91,
            hasConflict: false,
            pinned: false,
            position: findFreePosition(board, 2),
            sessionId,
            queryText,
            createdBy: 'ARIA',
            createdAt: new Date().toISOString(),
          },
        ]

        // Add cards to board state
        cards.forEach(card => board.push(card))
        boardState.set(slug, board)

        // Stream cards one by one with delay — the "live appearance" effect
        io.to(slug).emit('aria:status', { status: 'reading' })

        cards.forEach((card, index) => {
          setTimeout(() => {
            io.to(slug).emit('board:card:new', { card })
          }, index * 600)
        })

        // ARIA chat response
        io.to(slug).emit('chat:message', {
          id: `aria-${Date.now()}`,
          senderId: 'aria',
          senderName: 'ARIA',
          content: `Searching for "${query}"... dropping findings onto the board.`,
          timestamp: new Date().toISOString(),
          isAria: true,
          isAriatrigger: false,
        })

        // After all cards have streamed: done → idle
        setTimeout(() => {
          io.to(slug).emit('aria:status', { status: 'done' })
          setTimeout(() => {
            io.to(slug).emit('aria:status', { status: 'idle' })
          }, 2500)
        }, (cards.length - 1) * 600 + 200)
      }, 1500)
    }
  })

  // ── CHAT: TYPING ──────────────────────────────────────────
  socket.on('chat:typing:start', () => {
    const slug = socket.data.slug
    const displayName = socket.data.displayName
    if (!slug || !displayName) return

    const typing = typingUsers.get(slug)
    if (!typing) return

    typing.add(displayName)
    socket.to(slug).emit('chat:typing', { users: Array.from(typing) })
  })

  socket.on('chat:typing:stop', () => {
    const slug = socket.data.slug
    const displayName = socket.data.displayName
    if (!slug || !displayName) return

    const typing = typingUsers.get(slug)
    if (!typing) return

    typing.delete(displayName)
    socket.to(slug).emit('chat:typing', { users: Array.from(typing) })
  })

  // ── BOARD: CARD PIN ───────────────────────────────────────
  socket.on('board:card:pin', (data: { cardId: string; pinned: boolean }) => {
    const slug = socket.data.slug
    if (!slug) return

    const board = boardState.get(slug)
    if (!board) return

    const card = board.find(c => c.id === data.cardId)
    if (card) {
      card.pinned = data.pinned
      // Broadcast to everyone including sender
      io.to(slug).emit('board:card:update', { cardId: data.cardId, pinned: data.pinned })
      console.log(`[board:pin] card ${data.cardId} pinned=${data.pinned} in ${slug}`)
    }
  })

  // ── BOARD: CARD DISMISS ───────────────────────────────────
  socket.on('board:card:dismiss', (data: { cardId: string }) => {
    const slug = socket.data.slug
    if (!slug) return

    const board = boardState.get(slug)
    if (!board) return

    const index = board.findIndex(c => c.id === data.cardId)
    if (index !== -1) {
      board.splice(index, 1)
      io.to(slug).emit('board:card:dismiss', { cardId: data.cardId })
      console.log(`[board:dismiss] card ${data.cardId} dismissed in ${slug}`)
    }
  })

  // ── BOARD: CARD MOVE ──────────────────────────────────────
  socket.on('board:card:move', (data: { cardId: string; x: number; y: number }) => {
    const slug = socket.data.slug
    if (!slug) return

    const board = boardState.get(slug)
    if (!board) return

    const card = board.find(c => c.id === data.cardId)
    if (card) {
      card.position = { x: data.x, y: data.y }
      // Last-write-wins: broadcast to everyone EXCEPT sender
      socket.to(slug).emit('board:card:move', {
        cardId: data.cardId,
        x: data.x,
        y: data.y,
      })
    }
  })

  // ── BOARD: MANUAL CARD ────────────────────────────────────
  socket.on('board:card:add', (data: { title: string; content: string }) => {
    const slug = socket.data.slug
    const displayName = socket.data.displayName
    if (!slug || !displayName) return

    const title = data.title?.trim()
    const content = data.content?.trim()
    if (!title || !content) return

    const board = boardState.get(slug) || []

    const card: BoardCard = {
      id: `manual-${Date.now()}-${socket.id}`,
      type: 'manual',
      title,
      content,
      pinned: false,
      position: findFreePosition(board, 0),
      createdBy: displayName,
      createdAt: new Date().toISOString(),
    }

    board.push(card)
    boardState.set(slug, board)

    io.to(slug).emit('board:card:new', { card })
    console.log(`[board:add] manual card added by ${displayName} in ${slug}`)
  })

  // ── ROOM: LEAVE ──────────────────────────────────────────
  socket.on('room:leave', () => {
    handleLeave(io, socket)
  })

  // ── DISCONNECT ───────────────────────────────────────────
  socket.on('disconnect', () => {
    handleLeave(io, socket)
  })
}

function handleLeave(io: Server, socket: Socket): void {
  const slug = socket.data.slug
  const displayName = socket.data.displayName
  if (!slug) return

  const typing = typingUsers.get(slug)
  if (typing && displayName) {
    typing.delete(displayName)
    io.to(slug).emit('chat:typing', { users: Array.from(typing) })
  }

  const { participant, newHost } = removeParticipant(slug, socket.id)
  if (!participant) return

  socket.leave(slug)
  const participants = getParticipants(slug)

  console.log(`[room:leave] ${participant.displayName} left room: ${slug}`)

  io.to(slug).emit('room:presence', {
    participants,
    leftUser: participant.displayName,
    newHost: newHost ? newHost.displayName : null,
  })

  if (participants.length > 0) {
    io.to(slug).emit('chat:system', {
      message: `${participant.displayName} left the room`,
      timestamp: new Date().toISOString(),
    })
  }

  socket.data.slug = undefined
  socket.data.displayName = undefined
}