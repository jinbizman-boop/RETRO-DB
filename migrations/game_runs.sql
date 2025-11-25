-- game_runs.sql — Hardened, idempotent migration for RETRO GAMES run records
-- Target: PostgreSQL 13+ / Neon-compatible
--
-- Contract kept:
--   • Table name `game_runs` and core intent (store per-play runs with user, slug, score, times).
--   • Columns keep original meanings (user_id, slug, score, started_at, finished_at).
--
-- Enhancements (non-breaking, C안 구조와 호환):
--   • Additional safety columns: updated_at, metadata, client_ip (optional), device_hint.
--   • Generated duration (seconds) for quick analytics.
--   • Stronger integrity (regex on slug, finish ≥ start, score ≥ 0).
--   • Optional FK to games(slug) if games table exists (validated only when present).
--   • Audit-friendly triggers to maintain updated_at.
--   • Rich, selective indexes (finished-only partials, composite sort keys).
--   • Helper views for 최근 플레이/유저별 요약 (기존 v_leaderboard_top 과 충돌 없음).
--   • All steps are idempotent (safe to re-run).

BEGIN;

-- ──────────────────────────────────────────────────────────────────────
-- 0) Extensions used by this schema (safe to re-run)
-- ──────────────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()

/* ──────────────────────────────────────────────────────────────────────
 * 1) Core table (create if missing)
 *    - Keep original core columns and meaning.
 *    - Enforce sensible checks, but remain compatible with existing data.
 *    - score는 INT → BIGINT 로 확장 (overflow 방지, 기존 INT와 호환).
 * ──────────────────────────────────────────────────────────────────── */
CREATE TABLE IF NOT EXISTS game_runs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug         TEXT NOT NULL,
  score        BIGINT,                              -- keep nullable; check below allows NULL or >= 0
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ,
  -- Added, non-breaking:
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata     JSONB        NOT NULL DEFAULT '{}'::jsonb,  -- client-provided run context (seed, mode, etc.)
  client_ip    INET,                                        -- optional capture (if provided)
  device_hint  TEXT,                                        -- e.g., 'mobile','desktop','pad'
  -- Invariants:
  CONSTRAINT ck_game_runs_finish_after_start
    CHECK (finished_at IS NULL OR finished_at >= started_at),
  CONSTRAINT ck_game_runs_score_nonneg
    CHECK (score IS NULL OR score >= 0),
  CONSTRAINT ck_game_runs_slug_format
    CHECK (slug ~ '^[a-z0-9][a-z0-9_-]{0,63}$')            -- conservative: 1..64, lowercase, digits, _-
);

COMMENT ON TABLE  game_runs IS 'Per-play run records for arcade games.';
COMMENT ON COLUMN game_runs.user_id      IS 'FK to users.id';
COMMENT ON COLUMN game_runs.slug         IS 'Game slug (e.g., 2048, brick-breaker).';
COMMENT ON COLUMN game_runs.score        IS 'Final score for this run (nullable, non-negative when present).';
COMMENT ON COLUMN game_runs.started_at   IS 'Run start timestamp (server-side).';
COMMENT ON COLUMN game_runs.finished_at  IS 'Run finish timestamp, when known.';
COMMENT ON COLUMN game_runs.updated_at   IS 'Auto-bumped on UPDATE via trigger.';
COMMENT ON COLUMN game_runs.metadata     IS 'JSONB with lightweight run context (seed, mode, extras).';
COMMENT ON COLUMN game_runs.device_hint  IS 'Client device hint string, optional.';
COMMENT ON COLUMN game_runs.client_ip    IS 'Optional client IP captured by API layer when available.';

/* ──────────────────────────────────────────────────────────────────────
 * 1-1) Gentle column backfills / type alignment
 *      - 기존 테이블이 있을 때도 안전하게 보강.
 * ──────────────────────────────────────────────────────────────────── */
DO $$
BEGIN
  -- score INT → BIGINT (이미 BIGINT면 no-op)
  PERFORM 1
  FROM information_schema.columns
  WHERE table_name = 'game_runs'
    AND column_name = 'score';

  -- PostgreSQL 은 INT → BIGINT 캐스팅이 안전하기 때문에 단순 ALTER 로 확장 가능
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'game_runs'
      AND column_name = 'score'
      AND data_type = 'integer'
  ) THEN
    ALTER TABLE game_runs
      ALTER COLUMN score TYPE BIGINT;
  END IF;

  -- updated_at / metadata / client_ip / device_hint 컬럼 보강 (없으면 추가)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'game_runs' AND column_name = 'updated_at'
  ) THEN
    ALTER TABLE game_runs
      ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'game_runs' AND column_name = 'metadata'
  ) THEN
    ALTER TABLE game_runs
      ADD COLUMN metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'game_runs' AND column_name = 'client_ip'
  ) THEN
    ALTER TABLE game_runs
      ADD COLUMN client_ip INET;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'game_runs' AND column_name = 'device_hint'
  ) THEN
    ALTER TABLE game_runs
      ADD COLUMN device_hint TEXT;
  END IF;
END
$$;

/* ──────────────────────────────────────────────────────────────────────
 * 2) Generated helper column: duration in seconds
 *    - Purely additive; DOES NOT break existing code.
 *    - Uses finished_at - started_at when finished_at present; otherwise 0.
 * ──────────────────────────────────────────────────────────────────── */
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'game_runs' AND column_name = 'duration_sec'
  ) THEN
    EXECUTE $SQL$
      ALTER TABLE game_runs
      ADD COLUMN duration_sec INT
        GENERATED ALWAYS AS (
          GREATEST(
            0,
            COALESCE(
              (EXTRACT(EPOCH FROM (finished_at - started_at)))::INT,
              0
            )
          )
        ) STORED
    $SQL$;
  END IF;
END
$$;

/* ──────────────────────────────────────────────────────────────────────
 * 3) Optional FK to games(slug)
 *    - Only add if `games.slug` exists AND is UNIQUE.
 *    - Use NOT VALID first to avoid legacy data failures; validate if possible.
 * ──────────────────────────────────────────────────────────────────── */
DO $$
DECLARE
  has_games_slug boolean := EXISTS (
    SELECT 1
    FROM   information_schema.columns c
    JOIN   information_schema.table_constraints tc
           ON tc.table_schema = c.table_schema
          AND tc.table_name   = c.table_name
    JOIN   information_schema.key_column_usage k
           ON k.table_schema = tc.table_schema
          AND k.table_name   = tc.table_name
          AND k.column_name  = c.column_name
    WHERE  c.table_schema = 'public'
      AND  c.table_name   = 'games'
      AND  c.column_name  = 'slug'
      AND  tc.constraint_type IN ('UNIQUE', 'PRIMARY KEY')
  );
  fk_exists boolean := EXISTS (
    SELECT 1
    FROM   pg_constraint
    WHERE  conname = 'fk_game_runs_games_slug'
  );
BEGIN
  IF has_games_slug AND NOT fk_exists THEN
    EXECUTE 'ALTER TABLE game_runs
             ADD CONSTRAINT fk_game_runs_games_slug
             FOREIGN KEY (slug) REFERENCES games(slug)
             ON DELETE RESTRICT
             NOT VALID';
    -- Try to validate; if it fails due to legacy rows, leave as NOT VALID.
    BEGIN
      EXECUTE 'ALTER TABLE game_runs VALIDATE CONSTRAINT fk_game_runs_games_slug';
    EXCEPTION WHEN others THEN
      -- Intentionally swallow: ops can fix data and VALIDATE later.
      NULL;
    END;
  END IF;
END
$$;

/* ──────────────────────────────────────────────────────────────────────
 * 4) updated_at trigger (idempotent)
 * ──────────────────────────────────────────────────────────────────── */
CREATE OR REPLACE FUNCTION set_updated_at_game_runs() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE  tgname = 'tr_game_runs_set_updated_at'
       AND tgrelid = 'public.game_runs'::regclass
  ) THEN
    EXECUTE 'CREATE TRIGGER tr_game_runs_set_updated_at
             BEFORE UPDATE ON public.game_runs
             FOR EACH ROW
             EXECUTE FUNCTION set_updated_at_game_runs()';
  END IF;
END
$$;

/* ──────────────────────────────────────────────────────────────────────
 * 5) Index suite (all idempotent)
 *    Query patterns optimized for:
 *      - Latest runs per user
 *      - Leaderboards by game (max score)
 *      - Time-based slices
 *      - Finished-only scans (partial indexes)
 * ──────────────────────────────────────────────────────────────────── */

-- Basic locality for user-based lookups
CREATE INDEX IF NOT EXISTS ix_game_runs_user
  ON game_runs(user_id);

-- Latest finished runs per user (common dashboard query)
CREATE INDEX IF NOT EXISTS ix_game_runs_user_finished
  ON game_runs(user_id, finished_at DESC)
  WHERE finished_at IS NOT NULL;

-- Time slicing (global timeline, ops analytics)
CREATE INDEX IF NOT EXISTS ix_game_runs_started
  ON game_runs(started_at DESC);

CREATE INDEX IF NOT EXISTS ix_game_runs_finished
  ON game_runs(finished_at DESC)
  WHERE finished_at IS NOT NULL;

-- By slug for leaderboards / game dashboards
CREATE INDEX IF NOT EXISTS ix_game_runs_slug_finished
  ON game_runs(slug, finished_at)
  WHERE finished_at IS NOT NULL;

-- Best score scans per game (descending score with early finish tiebreaker)
CREATE INDEX IF NOT EXISTS ix_game_runs_slug_score
  ON game_runs(slug, score DESC, finished_at ASC)
  WHERE finished_at IS NOT NULL;

-- Composite for “my best in a game”
CREATE INDEX IF NOT EXISTS ix_game_runs_user_slug_score
  ON game_runs(user_id, slug, score DESC, finished_at ASC)
  WHERE finished_at IS NOT NULL;

-- Fast “recent by game” feed
CREATE INDEX IF NOT EXISTS ix_game_runs_slug_started_desc
  ON game_runs(slug, started_at DESC);

-- Optional: GIN on metadata (for property-based searches; lightweight path ops)
CREATE INDEX IF NOT EXISTS ix_game_runs_metadata_gin
  ON game_runs USING GIN (metadata jsonb_path_ops);

/* ──────────────────────────────────────────────────────────────────────
 * 6) Helpful uniqueness guard (very conservative)
 *    - Avoid exact duplicates produced by retries: same (user_id, slug, started_at).
 *    - NOT enforcing finished_at uniqueness to allow reconnect/resume semantics.
 * ──────────────────────────────────────────────────────────────────── */
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM   pg_indexes
    WHERE  schemaname = 'public'
       AND indexname  = 'ux_game_runs_user_slug_started'
  ) THEN
    EXECUTE 'CREATE UNIQUE INDEX ux_game_runs_user_slug_started
             ON game_runs(user_id, slug, started_at)';
  END IF;
END
$$;

/* ──────────────────────────────────────────────────────────────────────
 * 7) Defaults / gentle backfills (no rewrites on big tables)
 *    - Ensure JSONB defaults are present for future inserts.
 * ──────────────────────────────────────────────────────────────────── */
ALTER TABLE game_runs
  ALTER COLUMN metadata SET DEFAULT '{}'::jsonb;

/* ──────────────────────────────────────────────────────────────────────
 * 8) Helper views for analytics (non-breaking)
 *    - 기존 v_leaderboard_top(001_init.sql)과 이름 충돌 없이 별도 제공.
 * ──────────────────────────────────────────────────────────────────── */

-- 최근 n일 동안의 유저별 플레이 요약 (RUN TIME 시점에 WHERE로 days 조정)
CREATE OR REPLACE VIEW v_game_runs_recent AS
SELECT
  r.id,
  r.user_id,
  r.slug,
  r.score,
  r.started_at,
  r.finished_at,
  r.duration_sec,
  r.device_hint,
  r.client_ip,
  r.metadata
FROM game_runs r
WHERE r.finished_at IS NOT NULL
ORDER BY r.finished_at DESC
LIMIT 5000;

-- 유저별 게임별 최고 점수 요약 뷰 (slug 기준)
CREATE OR REPLACE VIEW v_game_runs_user_best AS
WITH ranked AS (
  SELECT
    r.user_id,
    r.slug,
    r.score,
    r.finished_at,
    row_number() OVER (
      PARTITION BY r.user_id, r.slug
      ORDER BY r.score DESC NULLS LAST, r.finished_at ASC NULLS LAST
    ) AS rn
  FROM game_runs r
)
SELECT
  user_id,
  slug,
  score AS best_score,
  finished_at AS best_score_at
FROM ranked
WHERE rn = 1;

-- 유저별 최근 플레이 한 게임과 마지막 점수
CREATE OR REPLACE VIEW v_game_runs_user_last_play AS
WITH ranked AS (
  SELECT
    r.user_id,
    r.slug,
    r.score,
    r.finished_at,
    row_number() OVER (
      PARTITION BY r.user_id
      ORDER BY r.finished_at DESC NULLS LAST, r.started_at DESC
    ) AS rn
  FROM game_runs r
)
SELECT
  user_id,
  slug,
  score AS last_score,
  finished_at AS last_played_at
FROM ranked
WHERE rn = 1;

COMMIT;

-- DOWN (optional, order-aware; run inside a transaction if needed)
-- BEGIN;
-- DROP VIEW IF EXISTS v_game_runs_user_last_play;
-- DROP VIEW IF EXISTS v_game_runs_user_best;
-- DROP VIEW IF EXISTS v_game_runs_recent;
-- DROP INDEX IF EXISTS ix_game_runs_metadata_gin;
-- DROP INDEX IF EXISTS ix_game_runs_slug_started_desc;
-- DROP INDEX IF EXISTS ix_game_runs_user_slug_score;
-- DROP INDEX IF EXISTS ix_game_runs_slug_score;
-- DROP INDEX IF EXISTS ix_game_runs_slug_finished;
-- DROP INDEX IF EXISTS ix_game_runs_finished;
-- DROP INDEX IF EXISTS ix_game_runs_started;
-- DROP INDEX IF EXISTS ix_game_runs_user_finished;
-- DROP INDEX IF EXISTS ix_game_runs_user;
-- DROP INDEX IF EXISTS ux_game_runs_user_slug_started;
-- ALTER TABLE game_runs DROP CONSTRAINT IF EXISTS fk_game_runs_games_slug;
-- DROP TRIGGER IF EXISTS tr_game_runs_set_updated_at ON game_runs;
-- DROP FUNCTION IF EXISTS set_updated_at_game_runs;
-- DROP TABLE IF EXISTS game_runs;
-- COMMIT;
