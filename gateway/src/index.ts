import express from 'express'
import http from 'http'
import { Server } from 'socket.io'
import cors from 'cors'
import morgan from 'morgan'
import dotenv from 'dotenv'
import { registerEvents } from './events'
import { initRedisSubscriber } from './redis'

dotenv.config()

const PORT = process.env.PORT || 4000
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000'

// ── EXPRESS SETUP ────────────────────────────────────────────
const app = express()
app.use(cors({ origin: FRONTEND_URL, credentials: true }))
app.use(morgan('dev'))
app.use(express.json())

// Health check endpoint — useful to verify server is running
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'orvexa-gateway', timestamp: new Date().toISOString() })
})

// ── HTTP + SOCKET.IO SETUP ───────────────────────────────────
// Socket.io needs a raw HTTP server, not just Express
const httpServer = http.createServer(app)

const io = new Server(httpServer, {
  cors: {
    origin: FRONTEND_URL,
    methods: ['GET', 'POST'],
    credentials: true,
  },
  // How long to wait before giving up on a disconnected client
  pingTimeout: 60000,
  pingInterval: 25000,
})

// ── REDIS SUBSCRIBER ─────────────────────────────────────────
initRedisSubscriber(io)

// ── SOCKET CONNECTION ─────────────────────────────────────────
// Every new browser tab that connects triggers this
io.on('connection', (socket) => {
  console.log(`[connect]    socket ${socket.id} connected`)

  // Register all event handlers for this socket
  registerEvents(io, socket)

  socket.on('disconnect', () => {
    console.log(`[disconnect] socket ${socket.id} disconnected`)
  })
})

// ── START SERVER ──────────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log(`
  ╔════════════════════════════════════╗
  ║     Orvexa Gateway Running         ║
  ║     http://localhost:${PORT}          ║
  ╚════════════════════════════════════╝
  `)
})