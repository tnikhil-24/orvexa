import { Server, Socket } from 'socket.io'
import {
  createRoom,
  getRoom,
  addParticipant,
  removeParticipant,
  getParticipants,
  roomExists,
} from './roomManager'

// Track who is typing per room
// key = roomSlug, value = Set of display names currently typing
const typingUsers = new Map<string, Set<string>>()

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

    // Initialize typing tracker for this room if needed
    if (!typingUsers.has(slug)) {
      typingUsers.set(slug, new Set())
    }

    const participants = getParticipants(slug)
    console.log(`[room:join] ${displayName} joined room: ${slug} (${participants.length} total)`)

    callback({ success: true, participants })

    // Tell everyone else someone joined
    socket.to(slug).emit('room:presence', { participants })

    // Announce in chat that someone joined
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

    // Clear typing indicator for this user when they send
    const typing = typingUsers.get(slug)
    if (typing) {
      typing.delete(displayName)
      io.to(slug).emit('chat:typing', { users: Array.from(typing) })
    }

    // Detect if this is an @ARIA trigger
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

    // Broadcast to everyone in the room INCLUDING sender
    io.to(slug).emit('chat:message', message)

    // If @ARIA was triggered, send a placeholder response for now
    if (isAriatrigger) {
      setTimeout(() => {
        io.to(slug).emit('chat:message', {
          id: `aria-${Date.now()}`,
          senderId: 'aria',
          senderName: 'ARIA',
          content: `Got it. Searching for: "${content.replace(/@aria\s*/i, '')}"... (Agent coming in Week 3)`,
          timestamp: new Date().toISOString(),
          isAria: true,
          isAriatrigger: false,
        })
        io.to(slug).emit('aria:status', { status: 'idle' })
      }, 1500)

      io.to(slug).emit('aria:status', { status: 'searching' })
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