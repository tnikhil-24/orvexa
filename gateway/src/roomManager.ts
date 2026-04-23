import { v4 as uuidv4 } from 'uuid'

export interface Participant {
  id: string
  displayName: string
  sessionId: string
  isHost: boolean
  joinedAt: string
}

export interface Room {
  id: string
  slug: string
  participants: Map<string, Participant>  // key = socketId
  createdAt: string
  isLocked: boolean
}

// In-memory store — all active rooms live here
// This resets on server restart (fine for v1)
const rooms = new Map<string, Room>()

// Generate a random human-readable slug
// e.g. "blue-falcon-42"
function generateSlug(): string {
  const adjectives = [
    'blue', 'red', 'green', 'swift', 'bold',
    'calm', 'dark', 'bright', 'sharp', 'cold'
  ]
  const nouns = [
    'falcon', 'river', 'stone', 'cloud', 'spark',
    'wave', 'light', 'storm', 'flame', 'frost'
  ]
  const number = Math.floor(Math.random() * 90) + 10
  const adj  = adjectives[Math.floor(Math.random() * adjectives.length)]
  const noun = nouns[Math.floor(Math.random() * nouns.length)]
  return `${adj}-${noun}-${number}`
}

// Create a brand new room
export function createRoom(): Room {
  const slug = generateSlug()
  const room: Room = {
    id: uuidv4(),
    slug,
    participants: new Map(),
    createdAt: new Date().toISOString(),
    isLocked: false,
  }
  rooms.set(slug, room)
  return room
}

// Get a room by its slug
export function getRoom(slug: string): Room | undefined {
  return rooms.get(slug)
}

// Add a participant to a room
// First person to join becomes host automatically
export function addParticipant(
  slug: string,
  socketId: string,
  displayName: string
): Participant | null {
  const room = rooms.get(slug)
  if (!room) return null
  if (room.isLocked) return null

  const isHost = room.participants.size === 0  // first person = host
  const participant: Participant = {
    id: uuidv4(),
    displayName,
    sessionId: socketId,
    isHost,
    joinedAt: new Date().toISOString(),
  }

  room.participants.set(socketId, participant)
  return participant
}

// Remove a participant from a room
// If the host leaves, promote the next oldest participant
export function removeParticipant(
  slug: string,
  socketId: string
): { participant: Participant | null; newHost: Participant | null } {
  const room = rooms.get(slug)
  if (!room) return { participant: null, newHost: null }

  const participant = room.participants.get(socketId)
  if (!participant) return { participant: null, newHost: null }

  room.participants.delete(socketId)

  // If room is now empty, delete it
  if (room.participants.size === 0) {
    rooms.delete(slug)
    return { participant, newHost: null }
  }

  // If the person who left was host, promote next participant
  let newHost: Participant | null = null
  if (participant.isHost) {
    const nextParticipant = room.participants.values().next().value
    if (nextParticipant) {
      nextParticipant.isHost = true
      newHost = nextParticipant
    }
  }

  return { participant, newHost }
}

// Get all participants in a room as a plain array
// (Map → Array so it can be sent over the socket)
export function getParticipants(slug: string): Participant[] {
  const room = rooms.get(slug)
  if (!room) return []
  return Array.from(room.participants.values())
}

// Check if a room exists and is joinable
export function roomExists(slug: string): boolean {
  return rooms.has(slug)
}