import Redis from 'ioredis'
import { Server } from 'socket.io'
import { v4 as uuidv4 } from 'uuid'

import { boardState, findFreePosition, BoardCard } from './events'

// Tracks which sessions have already received their first card,
// so we emit aria:status reading exactly once per session.
const activeSessions = new Set<string>()

export function initRedisSubscriber(io: Server): void {
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379'

  const subscriber = new Redis(redisUrl)

  subscriber.on('error', (err: Error) => {
    console.error('[redis] subscriber error:', err.message)
  })

  subscriber.on('connect', () => {
    console.log('[redis] subscriber connected')
  })

  // Call psubscribe directly — ioredis queues it until connected.
  // Do NOT put this inside the connect handler: that pattern re-subscribes
  // on every reconnect, doubling up listeners.
  subscriber.psubscribe('room:*:findings')
    .then(() => console.log('[redis] subscribed to room:*:findings'))
    .catch(err => console.error('[redis] psubscribe failed:', err.message))

  // pmessage fires for pattern subscriptions — signature is 3 args: pattern, channel, message
  subscriber.on('pmessage', (_pattern: string, channel: string, message: string) => {
    // Extract slug from channel name: room:{slug}:findings
    const match = channel.match(/^room:(.+):findings$/)
    if (!match) return
    const slug = match[1]

    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(message)
    } catch {
      console.error('[redis] invalid JSON on channel', channel)
      return
    }

    const type = payload.type as string
    const sessionId = payload.sessionId as string | undefined

    // ── DONE ─────────────────────────────────────────────────
    if (type === 'done') {
      if (sessionId) activeSessions.delete(sessionId)
      io.to(slug).emit('aria:status', { status: 'done' })
      setTimeout(() => {
        io.to(slug).emit('aria:status', { status: 'idle' })
      }, 2500)
      console.log(`[redis] session ${sessionId} done in ${slug}`)
      return
    }

    // ── STREAM START ─────────────────────────────────────────
    if (type === 'stream_start') {
      if (sessionId && !activeSessions.has(sessionId)) {
        activeSessions.add(sessionId)
        io.to(slug).emit('aria:status', { status: 'reading' })
      }

      if (!boardState.has(slug)) {
        boardState.set(slug, [])
      }
      const board = boardState.get(slug)!

      const card: BoardCard = {
        id:          payload.cardId as string,
        type:        'aria',
        agentType:   payload.agentType as string | undefined,
        title:       (payload.title as string) || 'Untitled',
        content:     '',
        pinned:      false,
        isStreaming: true,
        position:    findFreePosition(board, 0),
        sessionId,
        queryText:   payload.queryText as string | undefined,
        createdBy:   'ARIA',
        createdAt:   new Date().toISOString(),
      }

      board.push(card)
      io.to(slug).emit('board:card:new', { card })
      console.log(`[redis] stream_start ${card.id} (${card.agentType}) → ${slug}`)
      return
    }

    // ── STREAM CHUNK ──────────────────────────────────────────
    if (type === 'stream_chunk') {
      const cardId = payload.cardId as string
      const chunk  = payload.chunk  as string
      const board  = boardState.get(slug)
      if (!board) return
      const card = board.find(c => c.id === cardId)
      if (!card) return
      card.content += chunk
      io.to(slug).emit('board:card:content', { cardId, chunk })
      return
    }

    // ── STREAM END ────────────────────────────────────────────
    if (type === 'stream_end') {
      const cardId = payload.cardId as string
      const board  = boardState.get(slug)
      if (!board) return
      const card = board.find(c => c.id === cardId)
      if (!card) return
      card.isStreaming = false
      if (typeof payload.finalContent   === 'string')  card.content         = payload.finalContent
      if (typeof payload.confidenceScore === 'number')  card.confidenceScore = payload.confidenceScore
      if (typeof payload.hasConflict     === 'boolean') card.hasConflict     = payload.hasConflict

      const completePayload: Record<string, unknown> = { cardId }
      if (typeof payload.confidenceScore === 'number')  completePayload.confidenceScore = payload.confidenceScore
      if (typeof payload.hasConflict     === 'boolean') completePayload.hasConflict     = payload.hasConflict
      if (typeof payload.finalContent    === 'string')  completePayload.finalContent    = payload.finalContent
      io.to(slug).emit('board:card:complete', completePayload)
      console.log(`[redis] stream_end ${cardId} → ${slug}`)
      return
    }

    // ── CARD (aria or error) ──────────────────────────────────
    if (type !== 'aria' && type !== 'error') return

    // First card of this session → transition to reading
    if (sessionId && !activeSessions.has(sessionId)) {
      activeSessions.add(sessionId)
      io.to(slug).emit('aria:status', { status: 'reading' })
    }

    if (!boardState.has(slug)) {
      boardState.set(slug, [])
    }
    const board = boardState.get(slug)!

    const card: BoardCard = {
      id: `aria-${Date.now()}-${uuidv4().slice(0, 8)}`,
      type: type as 'aria' | 'error',
      agentType:       payload.agentType as string | undefined,
      title:           (payload.title   as string) || 'Untitled',
      content:         (payload.content as string) || '',
      sourceUrl:       payload.sourceUrl    as string | undefined,
      sourceTitle:     payload.sourceTitle  as string | undefined,
      confidenceScore: payload.confidenceScore as number | undefined,
      hasConflict:     (payload.hasConflict as boolean) ?? false,
      pinned:          false,
      position:        findFreePosition(board, 0),
      sessionId,
      queryText:       payload.queryText as string | undefined,
      createdBy:       'ARIA',
      createdAt:       new Date().toISOString(),
    }

    board.push(card)
    io.to(slug).emit('board:card:new', { card })
    console.log(`[redis] card ${card.id} (${card.agentType}) → ${slug}`)
  })
}
