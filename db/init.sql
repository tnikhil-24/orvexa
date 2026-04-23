-- ============================================================
-- Orvexa v1 — PostgreSQL Initialization Script
-- Run automatically by Docker on first container start
-- ============================================================

-- ── EXTENSIONS ──────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "vector";


-- ============================================================
-- TABLE: rooms
-- ============================================================
CREATE TABLE IF NOT EXISTS rooms (
  id              UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  slug            VARCHAR(20)   NOT NULL UNIQUE,
  topic           TEXT,
  is_active       BOOLEAN       NOT NULL DEFAULT TRUE,
  is_locked       BOOLEAN       NOT NULL DEFAULT FALSE,
  is_deleted      BOOLEAN       NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  last_active_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  deleted_at      TIMESTAMPTZ   DEFAULT NULL,

  CONSTRAINT chk_rooms_deleted_at CHECK (
    (is_deleted = FALSE AND deleted_at IS NULL) OR
    (is_deleted = TRUE  AND deleted_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_rooms_slug        ON rooms (slug);
CREATE INDEX IF NOT EXISTS idx_rooms_is_active   ON rooms (is_active)   WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_rooms_is_deleted  ON rooms (is_deleted)  WHERE is_deleted = FALSE;
CREATE INDEX IF NOT EXISTS idx_rooms_last_active ON rooms (last_active_at);


-- ============================================================
-- TABLE: participants
-- ============================================================
CREATE TABLE IF NOT EXISTS participants (
  id            SERIAL        PRIMARY KEY,
  room_id       UUID          NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  display_name  VARCHAR(30)   NOT NULL,
  session_id    VARCHAR(64)   NOT NULL UNIQUE,
  is_host       BOOLEAN       NOT NULL DEFAULT FALSE,
  is_deleted    BOOLEAN       NOT NULL DEFAULT FALSE,
  joined_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  left_at       TIMESTAMPTZ   DEFAULT NULL
);

CREATE INDEX IF NOT EXISTS idx_participants_room_id    ON participants (room_id);
CREATE INDEX IF NOT EXISTS idx_participants_session_id ON participants (session_id);
CREATE INDEX IF NOT EXISTS idx_participants_active     ON participants (room_id, is_deleted)
  WHERE is_deleted = FALSE;

-- Only one host per room at a time
CREATE UNIQUE INDEX IF NOT EXISTS idx_participants_one_host
  ON participants (room_id)
  WHERE is_host = TRUE AND is_deleted = FALSE;

-- Trigger: max 10 active participants per room
CREATE OR REPLACE FUNCTION check_participant_limit()
RETURNS TRIGGER AS $$
BEGIN
  IF (
    SELECT COUNT(*)
    FROM participants
    WHERE room_id = NEW.room_id
      AND is_deleted = FALSE
  ) >= 10 THEN
    RAISE EXCEPTION 'Room % has reached the maximum limit of 10 participants', NEW.room_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_participant_limit ON participants;
CREATE TRIGGER trg_participant_limit
  BEFORE INSERT ON participants
  FOR EACH ROW EXECUTE FUNCTION check_participant_limit();


-- ============================================================
-- TABLE: aria_sessions
-- Tracks every ARIA trigger — queue, stop, history
-- ============================================================
CREATE TABLE IF NOT EXISTS aria_sessions (
  id              SERIAL        PRIMARY KEY,
  room_id         UUID          NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  triggered_by    INT           NOT NULL REFERENCES participants(id),
  query           TEXT          NOT NULL,
  status          VARCHAR(20)   NOT NULL DEFAULT 'queued',
  queue_position  INT           NOT NULL DEFAULT 0,
  started_at      TIMESTAMPTZ   DEFAULT NULL,
  completed_at    TIMESTAMPTZ   DEFAULT NULL,
  stopped_at      TIMESTAMPTZ   DEFAULT NULL,
  stopped_by      INT           DEFAULT NULL REFERENCES participants(id),
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_aria_status CHECK (
    status IN ('queued', 'running', 'completed', 'stopped', 'failed')
  ),
  CONSTRAINT chk_aria_stopped CHECK (
    (stopped_by IS NULL AND stopped_at IS NULL) OR
    (stopped_by IS NOT NULL AND stopped_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_aria_room_id  ON aria_sessions (room_id);
CREATE INDEX IF NOT EXISTS idx_aria_status   ON aria_sessions (status);
CREATE INDEX IF NOT EXISTS idx_aria_created  ON aria_sessions (created_at DESC);

-- Only one running ARIA session per room at a time
CREATE UNIQUE INDEX IF NOT EXISTS idx_aria_one_running_per_room
  ON aria_sessions (room_id)
  WHERE status = 'running';


-- ============================================================
-- TABLE: findings
-- Individual research cards produced by ARIA agents
-- ============================================================
CREATE TABLE IF NOT EXISTS findings (
  id               SERIAL        PRIMARY KEY,
  room_id          UUID          NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  aria_session_id  INT           DEFAULT NULL REFERENCES aria_sessions(id),
  triggered_by     INT           DEFAULT NULL REFERENCES participants(id),
  query            TEXT          NOT NULL DEFAULT '',
  agent_type       VARCHAR(20)   NOT NULL,
  content          TEXT          NOT NULL,
  source_url       TEXT          DEFAULT NULL,
  source_title     VARCHAR(255)  DEFAULT NULL,
  confidence_score FLOAT         DEFAULT NULL,
  has_conflict     BOOLEAN       NOT NULL DEFAULT FALSE,
  pinned           BOOLEAN       NOT NULL DEFAULT FALSE,
  is_deleted       BOOLEAN       NOT NULL DEFAULT FALSE,
  position_x       FLOAT         NOT NULL DEFAULT 100,
  position_y       FLOAT         NOT NULL DEFAULT 100,
  embedding        vector(1536)  DEFAULT NULL,
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  deleted_at       TIMESTAMPTZ   DEFAULT NULL,

  CONSTRAINT chk_findings_agent_type CHECK (
    agent_type IN ('search', 'summary', 'factcheck', 'manual')
  ),
  CONSTRAINT chk_findings_confidence CHECK (
    confidence_score IS NULL OR confidence_score BETWEEN 0 AND 1
  ),
  CONSTRAINT chk_findings_source_url CHECK (
    agent_type = 'manual' OR source_url IS NOT NULL
  ),
  CONSTRAINT chk_findings_deleted_at CHECK (
    (is_deleted = FALSE AND deleted_at IS NULL) OR
    (is_deleted = TRUE  AND deleted_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_findings_room_id      ON findings (room_id);
CREATE INDEX IF NOT EXISTS idx_findings_session      ON findings (aria_session_id);
CREATE INDEX IF NOT EXISTS idx_findings_agent_type   ON findings (agent_type);
CREATE INDEX IF NOT EXISTS idx_findings_pinned       ON findings (pinned) WHERE pinned = TRUE;
CREATE INDEX IF NOT EXISTS idx_findings_not_deleted  ON findings (is_deleted) WHERE is_deleted = FALSE;
CREATE INDEX IF NOT EXISTS idx_findings_created      ON findings (created_at DESC);

-- pgvector index for cosine similarity deduplication
CREATE INDEX IF NOT EXISTS idx_findings_embedding
  ON findings USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 50);


-- ============================================================
-- TABLE: boards
-- One board per room — stores React Flow canvas state
-- ============================================================
CREATE TABLE IF NOT EXISTS boards (
  id          SERIAL        PRIMARY KEY,
  room_id     UUID          NOT NULL UNIQUE REFERENCES rooms(id) ON DELETE CASCADE,
  nodes       JSONB         NOT NULL DEFAULT '[]',
  edges       JSONB         NOT NULL DEFAULT '[]',
  updated_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_boards_room_id  ON boards (room_id);
CREATE INDEX IF NOT EXISTS idx_boards_updated  ON boards (updated_at DESC);

-- Auto-update updated_at on every board write
CREATE OR REPLACE FUNCTION update_board_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_boards_updated_at ON boards;
CREATE TRIGGER trg_boards_updated_at
  BEFORE UPDATE ON boards
  FOR EACH ROW EXECUTE FUNCTION update_board_timestamp();


-- ============================================================
-- TABLE: reports
-- Generated by host at end of session
-- ============================================================
CREATE TABLE IF NOT EXISTS reports (
  id            SERIAL        PRIMARY KEY,
  room_id       UUID          NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  generated_by  INT           NOT NULL REFERENCES participants(id),
  content       TEXT          NOT NULL,
  storage_url   TEXT          DEFAULT NULL,
  is_deleted    BOOLEAN       NOT NULL DEFAULT FALSE,
  generated_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  deleted_at    TIMESTAMPTZ   DEFAULT NULL,

  CONSTRAINT chk_reports_deleted_at CHECK (
    (is_deleted = FALSE AND deleted_at IS NULL) OR
    (is_deleted = TRUE  AND deleted_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_reports_room_id   ON reports (room_id);
CREATE INDEX IF NOT EXISTS idx_reports_generated ON reports (generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_active    ON reports (is_deleted) WHERE is_deleted = FALSE;


-- ============================================================
-- UTILITY: soft-delete rooms inactive for 30 days
-- Wire this to pg_cron or an external scheduler
-- ============================================================
CREATE OR REPLACE FUNCTION soft_delete_inactive_rooms()
RETURNS void AS $$
BEGIN
  UPDATE rooms
  SET
    is_deleted     = TRUE,
    is_active      = FALSE,
    deleted_at     = NOW()
  WHERE
    is_deleted     = FALSE
    AND last_active_at < NOW() - INTERVAL '30 days';
END;
$$ LANGUAGE plpgsql;


-- ============================================================
-- SEED DATA — local development only
-- Safe to re-run: uses ON CONFLICT DO NOTHING
-- ============================================================

-- Seed rooms
INSERT INTO rooms (id, slug, topic, is_active)
VALUES
  (
    'aaaaaaaa-0000-4000-a000-000000000001',
    'orvexa-dev-room',
    'EdTech market research — Southeast Asia',
    TRUE
  ),
  (
    'bbbbbbbb-0000-4000-b000-000000000002',
    'startup-ideas-26',
    'AI startup ideas for 2026',
    TRUE
  )
ON CONFLICT (slug) DO NOTHING;

-- Seed participants
INSERT INTO participants (room_id, display_name, session_id, is_host)
VALUES
  ('aaaaaaaa-0000-4000-a000-000000000001', 'Dev Host',  'sess_dev_host_001',  TRUE),
  ('aaaaaaaa-0000-4000-a000-000000000001', 'Dev Guest', 'sess_dev_guest_002', FALSE),
  ('bbbbbbbb-0000-4000-b000-000000000002', 'Host Two',  'sess_dev_host_003',  TRUE)
ON CONFLICT (session_id) DO NOTHING;

-- Seed aria_session
INSERT INTO aria_sessions (room_id, triggered_by, query, status, started_at, completed_at)
VALUES (
  'aaaaaaaa-0000-4000-a000-000000000001',
  1,
  'What is the EdTech market size in Southeast Asia?',
  'completed',
  NOW() - INTERVAL '10 minutes',
  NOW() - INTERVAL '9 minutes'
);

-- Seed findings
INSERT INTO findings
  (room_id, aria_session_id, triggered_by, query, agent_type, content, source_url, source_title, confidence_score, pinned, position_x, position_y)
VALUES
  (
    'aaaaaaaa-0000-4000-a000-000000000001',
    1, 1,
    'What is the EdTech market size in Southeast Asia?',
    'search',
    'The EdTech market in Southeast Asia is projected to reach $6.4B by 2025, growing at 15% CAGR driven by mobile-first learners in Indonesia and Vietnam.',
    'https://example.com/edtech-sea-2024',
    'EdTech SEA Market Report 2024',
    0.91,
    TRUE,
    80, 80
  ),
  (
    'aaaaaaaa-0000-4000-a000-000000000001',
    1, 1,
    'What is the EdTech market size in Southeast Asia?',
    'factcheck',
    '$6.4B figure corroborated by two independent sources. 15% CAGR confirmed. Indonesia accounts for ~40% of total market share.',
    'https://example.com/edtech-verify-2024',
    'EdTech Cross-Reference Report',
    0.87,
    FALSE,
    340, 80
  ),
  (
    'aaaaaaaa-0000-4000-a000-000000000001',
    NULL, 1,
    '',
    'manual',
    'Follow-up question: who are the top 3 EdTech players in Southeast Asia right now?',
    NULL,
    NULL,
    NULL,
    TRUE,
    600, 80
  );

-- Seed board
INSERT INTO boards (room_id, nodes, edges)
VALUES (
  'aaaaaaaa-0000-4000-a000-000000000001',
  '[
    {"id":"f-1","type":"findingCard","position":{"x":80,"y":80},"data":{"findingId":1}},
    {"id":"f-2","type":"findingCard","position":{"x":340,"y":80},"data":{"findingId":2}},
    {"id":"f-3","type":"manualCard","position":{"x":600,"y":80},"data":{"findingId":3}}
  ]',
  '[]'
)
ON CONFLICT (room_id) DO NOTHING;

-- Seed report
INSERT INTO reports (room_id, generated_by, content)
VALUES (
  'aaaaaaaa-0000-4000-a000-000000000001',
  1,
'# Orvexa Research Report
## Topic: EdTech Market in Southeast Asia

### Executive Summary
The Southeast Asian EdTech market represents a high-growth investment opportunity,
projected to reach $6.4B by 2025 at a 15% compound annual growth rate.

### Key Findings
- Market size projected at $6.4B by 2025 (15% CAGR)
- Indonesia accounts for approximately 40% of total regional market share
- Mobile-first delivery is the dominant learning model across the region
- Vietnam emerging as second largest growth market

### Sources
1. EdTech SEA Market Report 2024 — https://example.com/edtech-sea-2024
2. EdTech Cross-Reference Report — https://example.com/edtech-verify-2024

### Contradictions & Caveats
None identified. All key figures corroborated across multiple independent sources.'
);