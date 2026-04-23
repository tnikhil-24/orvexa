import { Server, Socket } from 'socket.io'
import {
  createRoom,
  getRoom,
  addParticipant,
  removeParticipant,
  getParticipants,
  roomExists,
} from './roomManager'

export function registerEvents(io: Server, socket: Socket): void {

  // ── ROOM: CREATE ─────────────────────────────────────────
  // Client emits this from the landing page
  // Server creates the room and returns the slug
  socket.on('room:create', (callback: (data: { slug: string }) => void) => {
    const room = createRoom()
    console.log(`[room:create] New room created: ${room.slug}`)
    callback({ slug: room.slug })
  })

  // ── ROOM: JOIN ───────────────────────────────────────────
  // Client emits this when navigating to /room/[slug]
  // displayName is what the user typed before entering
  socket.on('room:join', (
    data: { slug: string; displayName: string },
    callback: (data: { success: boolean; error?: string; participants?: ReturnType<typeof getParticipants> }) => void
  ) => {
    const { slug, displayName } = data

    // Check room exists
    if (!roomExists(slug)) {
      callback({ success: false, error: 'Room not found' })
      return
    }

    // Check display name
    if (!displayName || displayName.trim().length === 0) {
      callback({ success: false, error: 'Display name is required' })
      return
    }

    if (displayName.trim().length > 30) {
      callback({ success: false, error: 'Display name must be 30 characters or less' })
      return
    }

    // Add participant to room
    const participant = addParticipant(slug, socket.id, displayName.trim())
    if (!participant) {
      callback({ success: false, error: 'Room is locked or full' })
      return
    }

    // Join the Socket.io room (this is how Socket.io groups sockets)
    socket.join(slug)

    // Store slug on socket for cleanup on disconnect
    socket.data.slug = slug
    socket.data.displayName = displayName.trim()

    const participants = getParticipants(slug)

    console.log(`[room:join] ${displayName} joined room: ${slug} (${participants.length} total)`)

    // Tell the joining user: success + current participant list
    callback({ success: true, participants })

    // Tell EVERYONE ELSE in the room: new person joined
    socket.to(slug).emit('room:presence', { participants })
  })

  // ── ROOM: LEAVE ──────────────────────────────────────────
  // Client emits this when they deliberately leave
  socket.on('room:leave', () => {
    handleLeave(io, socket)
  })

  // ── DISCONNECT ───────────────────────────────────────────
  // Fires automatically when browser tab closes or connection drops
  socket.on('disconnect', () => {
    handleLeave(io, socket)
  })
}

// Shared leave logic — used by both room:leave and disconnect
function handleLeave(io: Server, socket: Socket): void {
  const slug = socket.data.slug
  if (!slug) return

  const { participant, newHost } = removeParticipant(slug, socket.id)
  if (!participant) return

  socket.leave(slug)
  const participants = getParticipants(slug)

  console.log(`[room:leave] ${participant.displayName} left room: ${slug} (${participants.length} remaining)`)

  // Tell everyone still in the room: updated participant list
  io.to(slug).emit('room:presence', {
    participants,
    leftUser: participant.displayName,
    newHost: newHost ? newHost.displayName : null,
  })

  // Clear socket data
  socket.data.slug = undefined
  socket.data.displayName = undefined
}