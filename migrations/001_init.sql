-- 001_init.sql — Initial, hardened schema for RETRO GAMES
-- Target: PostgreSQL 13+ (works on Neon/Serverless PG)
-- Design goals
--  - Idempotent (safe to re-run)
--  - Atomic (wrapped in a single TX)
--  - Observable (helpful indexes & views)
--  - Guarded (CHECKs, FKs, generated columns)
--  - Operational (timestamps, small utilities, trigger-based invariants)
--
-- Notes
--  - We keep functional parity with the original file (same tables & purpose),
--    but add: stricter constraints, idempotency keys, trigger-based balance
--    propagation to user_stats, defensive CHECKs, and read-optimized indexes.
--  - Extended for wallet C-architecture:
--      * user_stats: coins + tickets + exp + games_played
--      * transactions: meta / game / exp_delta / tickets_delta / plays_delta / reason
--      * apply_wallet_transaction(): coins + exp + tickets + games_played 동시 갱신
--  - v_user_profile, v_recent_events는 새 wallet 구조(exp/tickets/plays)를 포함하도록 확장.

BEGIN;

-- ──────────────────────────────────────────────────────────────────────────────
-- Extensions (safe to re-run)
-- ──────────────────────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS pgcrypto;     -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;       -- case-insensitive text

-- ──────────────────────────────────────────────────────────────────────────────
-- Enum types (create if missing)
-- ──────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'oauth_provider') THEN
    CREATE TYPE oauth_provider AS ENUM ('google','naver','facebook','kakao');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'txn_type') THEN
    CREATE TYPE txn_type AS ENUM ('earn','spend','purchase','reward');
  END IF;
END
$$;

-- Ensure 'game' value exists in txn_type (for wallet game rewards)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_enum
    WHERE enumtypid = 'txn_type'::regtype
      AND enumlabel = 'game'
  ) THEN
    ALTER TYPE txn_type ADD VALUE 'game';
  END IF;
END
$$;

-- ──────────────────────────────────────────────────────────────────────────────
-- Utility: updated_at auto-bump trigger
-- ──────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ──────────────────────────────────────────────────────────────────────────────
-- Core: users
--  - email/username using CITEXT (case-insensitive)
--  - defensive CHECKs for size/patterns (lightweight)
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email              CITEXT UNIQUE,
  email_verified_at  TIMESTAMPTZ,
  username           CITEXT UNIQUE,
  display_name       TEXT,
  avatar_url         TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Soft hygiene (does not block legitimate data but keeps it reasonable)
  CONSTRAINT users_username_len_chk CHECK (username IS NULL OR length(username)::int BETWEEN 2 AND 64),
  CONSTRAINT users_email_len_chk    CHECK (email IS NULL OR length(email)::int BETWEEN 3 AND 254)
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'users_set_updated_at') THEN
    CREATE TRIGGER users_set_updated_at
      BEFORE UPDATE ON users
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END
$$;

-- ──────────────────────────────────────────────────────────────────────────────
-- OAuth accounts (per provider)
--  - unique(provider, provider_account_id)
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS oauth_accounts (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider              oauth_provider NOT NULL,
  provider_account_id   TEXT NOT NULL,
  access_token          TEXT,
  refresh_token         TEXT,
  expires_at            TIMESTAMPTZ,
  scope                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(provider, provider_account_id)
);
CREATE INDEX IF NOT EXISTS idx_oauth_user                  ON oauth_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_oauth_provider_account_id   ON oauth_accounts(provider, provider_account_id);

-- ──────────────────────────────────────────────────────────────────────────────
-- Sessions
--  - token is an opaque ID (can carry a JWT id)
--  - optional device/user-agent metadata
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token        TEXT NOT NULL UNIQUE,
  user_agent   TEXT,
  ip_address   INET,
  expires_at   TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sessions_user   ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_token  ON sessions(token);

-- ──────────────────────────────────────────────────────────────────────────────
-- User stats / wallet snapshot
--  - xp / level: 기존 구조 유지 (xp 기반 레벨)
--  - coins / tickets / exp / games_played: wallet C안에서 사용 (정식 지갑 스냅샷)
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_stats (
  user_id        UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  xp             BIGINT NOT NULL DEFAULT 0,
  level          INT GENERATED ALWAYS AS (GREATEST(1, (xp/1000)::INT + 1)) STORED,
  coins          BIGINT NOT NULL DEFAULT 0 CHECK (coins >= 0),
  -- 새 필드: wallet C안용
  exp            BIGINT NOT NULL DEFAULT 0,
  tickets        BIGINT NOT NULL DEFAULT 0,
  games_played   BIGINT NOT NULL DEFAULT 0,
  last_login_at  TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 기존 DB에도 exp/tickets/games_played 컬럼을 보강 (있으면 무시)
ALTER TABLE user_stats
  ADD COLUMN IF NOT EXISTS exp          BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tickets      BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS games_played BIGINT NOT NULL DEFAULT 0;

-- exp / tickets / games_played 음수 방지 제약 (idempotent)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'user_stats'::regclass
      AND conname = 'user_stats_exp_nonneg'
  ) THEN
    ALTER TABLE user_stats
      ADD CONSTRAINT user_stats_exp_nonneg CHECK (exp >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'user_stats'::regclass
      AND conname = 'user_stats_tickets_nonneg'
  ) THEN
    ALTER TABLE user_stats
      ADD CONSTRAINT user_stats_tickets_nonneg CHECK (tickets >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'user_stats'::regclass
      AND conname = 'user_stats_games_played_nonneg'
  ) THEN
    ALTER TABLE user_stats
      ADD CONSTRAINT user_stats_games_played_nonneg CHECK (games_played >= 0);
  END IF;
END
$$;

-- xp → exp 1회 동기화 (exp가 0일 때만)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'user_stats' AND column_name = 'xp'
  )
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'user_stats' AND column_name = 'exp'
  ) THEN
    UPDATE user_stats SET exp = xp WHERE exp = 0;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'user_stats_set_updated_at') THEN
    CREATE TRIGGER user_stats_set_updated_at
      BEFORE UPDATE ON user_stats
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END
$$;

-- user_stats 읽기 최적화를 위한 인덱스 (leaderboard/대시보드 용도)
CREATE INDEX IF NOT EXISTS idx_user_stats_exp_desc      ON user_stats(exp DESC);
CREATE INDEX IF NOT EXISTS idx_user_stats_coins_desc    ON user_stats(coins DESC);
CREATE INDEX IF NOT EXISTS idx_user_stats_games_desc    ON user_stats(games_played DESC);

-- ──────────────────────────────────────────────────────────────────────────────
-- Games catalog
--  - slug unique with soft pattern check
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS games (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        TEXT NOT NULL UNIQUE,   -- e.g., '2048', 'brick-breaker'
  title       TEXT NOT NULL,
  category    TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT games_slug_len_chk CHECK (length(slug) BETWEEN 1 AND 64),
  CONSTRAINT games_slug_pat_chk CHECK (slug ~ '^[a-z0-9_\-]+$')
);
CREATE INDEX IF NOT EXISTS idx_games_slug     ON games(slug);
CREATE INDEX IF NOT EXISTS idx_games_category ON games(category);

-- ──────────────────────────────────────────────────────────────────────────────
-- Individual play runs (scores are stored here)
--  - ended_at optional; duration computed
--  - metadata for client-side details (seed, mode, etc.)
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS game_runs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_id       UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at      TIMESTAMPTZ,
  duration_sec  INTEGER GENERATED ALWAYS AS (
                   COALESCE(EXTRACT(EPOCH FROM (ended_at - started_at))::INT, 0)
                 ) STORED,
  score         BIGINT NOT NULL DEFAULT 0,
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT runs_score_nonneg CHECK (score >= 0)
);
CREATE INDEX IF NOT EXISTS idx_runs_user                ON game_runs(user_id);
CREATE INDEX IF NOT EXISTS idx_runs_game                ON game_runs(game_id);
CREATE INDEX IF NOT EXISTS idx_runs_game_score          ON game_runs(game_id, score DESC);
CREATE INDEX IF NOT EXISTS idx_runs_user_started_desc   ON game_runs(user_id, started_at DESC);

-- ──────────────────────────────────────────────────────────────────────────────
-- Shop items
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shop_items (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku           TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  description   TEXT,
  price_coins   BIGINT NOT NULL CHECK (price_coins >= 0),
  image_url     TEXT,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT shop_sku_len_chk CHECK (length(sku) BETWEEN 1 AND 64)
);
CREATE INDEX IF NOT EXISTS idx_shop_active ON shop_items(active);

-- ──────────────────────────────────────────────────────────────────────────────
-- Purchases (user acquires items)
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS purchases (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id       UUID NOT NULL REFERENCES shop_items(id) ON DELETE RESTRICT,
  amount_paid   BIGINT NOT NULL CHECK (amount_paid >= 0),
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_purchases_user ON purchases(user_id);
CREATE INDEX IF NOT EXISTS idx_purchases_item ON purchases(item_id);

-- ──────────────────────────────────────────────────────────────────────────────
-- Wallet transactions (earn/spend with traceability)
--  - balance_after is set by a trigger to reflect user_stats.coins
--  - idempotency_key prevents accidental double-posts
--  - C안 확장: reason, meta, game, exp_delta, tickets_delta, plays_delta 추가
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS transactions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type            txn_type NOT NULL,
  amount          BIGINT NOT NULL,                 -- 0도 허용(경험치/티켓만 변동될 수 있음)
  balance_after   BIGINT,
  ref_table       TEXT,                            -- e.g., 'game_runs', 'purchases', 'daily_luck_spins'
  ref_id          UUID,
  note            TEXT,
  idempotency_key TEXT UNIQUE,
  reason          TEXT,                            -- wallet.ts 의 reason
  meta            JSONB NOT NULL DEFAULT '{}'::jsonb,
  game            TEXT,
  exp_delta       BIGINT NOT NULL DEFAULT 0,
  tickets_delta   BIGINT NOT NULL DEFAULT 0,
  plays_delta     BIGINT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 기존 테이블에 새 컬럼 보강
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS reason         TEXT,
  ADD COLUMN IF NOT EXISTS meta           JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS game           TEXT,
  ADD COLUMN IF NOT EXISTS exp_delta      BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tickets_delta  BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS plays_delta    BIGINT NOT NULL DEFAULT 0;

-- amount 체크 제약 조건을 완화: 적어도 한 가지 값은 변해야 함
DO $$
DECLARE
  c_name TEXT;
BEGIN
  SELECT conname INTO c_name
  FROM pg_constraint
  WHERE conrelid = 'transactions'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%amount <> 0%';

  IF c_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE transactions DROP CONSTRAINT %I', c_name);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'transactions'::regclass
      AND conname = 'transactions_amount_nonzero_or_deltas'
  ) THEN
    ALTER TABLE transactions
      ADD CONSTRAINT transactions_amount_nonzero_or_deltas
      CHECK (
        amount <> 0
        OR exp_delta <> 0
        OR tickets_delta <> 0
        OR plays_delta <> 0
      );
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_txn_user_time    ON transactions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_txn_user_ref     ON transactions(user_id, ref_table, ref_id);

-- Helper: ensure user_stats row exists for a user
CREATE OR REPLACE FUNCTION ensure_user_stats_row(p_user UUID) RETURNS void AS $$
BEGIN
  INSERT INTO user_stats(user_id) VALUES (p_user)
  ON CONFLICT (user_id) DO NOTHING;
END;
$$ LANGUAGE plpgsql;

-- Trigger to apply a transaction into user_stats (coins + exp + tickets + games_played)
--  - BEFORE INSERT: compute candidate new balance, enforce non-negative coins
--  - After successful check, set balance_after and upsert stats
CREATE OR REPLACE FUNCTION apply_wallet_transaction() RETURNS TRIGGER AS $$
DECLARE
  v_stats        user_stats;
  v_new_coins    BIGINT;
  v_new_tickets  BIGINT;
  v_new_exp      BIGINT;
  v_new_games    BIGINT;
BEGIN
  PERFORM ensure_user_stats_row(NEW.user_id);

  SELECT * INTO v_stats
  FROM user_stats
  WHERE user_id = NEW.user_id
  FOR UPDATE;

  v_new_coins   := GREATEST(0, COALESCE(v_stats.coins, 0)          + COALESCE(NEW.amount, 0));
  v_new_tickets := GREATEST(0, COALESCE(v_stats.tickets, 0)        + COALESCE(NEW.tickets_delta, 0));
  v_new_exp     := GREATEST(0, COALESCE(v_stats.exp, 0)            + COALESCE(NEW.exp_delta, 0));
  v_new_games   := GREATEST(0, COALESCE(v_stats.games_played, 0)   + COALESCE(NEW.plays_delta, 0));

  -- coins 음수 방지 (추가로 5000 cap 등은 wallet.ts / delta 계산에서 처리)
  IF v_new_coins < 0 THEN
    RAISE EXCEPTION 'Insufficient balance: % + % = %', v_stats.coins, NEW.amount, v_new_coins
      USING ERRCODE = '23514';
  END IF;

  NEW.balance_after := v_new_coins;

  UPDATE user_stats
  SET coins        = v_new_coins,
      tickets      = v_new_tickets,
      exp          = v_new_exp,
      xp           = v_new_exp,   -- xp와 exp를 동기화 (기존 level 계산 보호)
      games_played = v_new_games,
      updated_at   = NOW()
  WHERE user_id = NEW.user_id;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'transactions_apply') THEN
    CREATE TRIGGER transactions_apply
      BEFORE INSERT ON transactions
      FOR EACH ROW EXECUTE FUNCTION apply_wallet_transaction();
  ELSE
    -- 이미 존재하면 함수만 최신 버전으로 교체된 상태이므로 OK
    NULL;
  END IF;
END
$$;

-- ──────────────────────────────────────────────────────────────────────────────
-- Daily luck (once per day)
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS daily_luck_spins (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  spin_date    DATE NOT NULL DEFAULT CURRENT_DATE,
  prize_key    TEXT NOT NULL,         -- e.g., 'coins', 'item', 'nothing'
  prize_value  BIGINT NOT NULL DEFAULT 0,
  metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, spin_date)
);
CREATE INDEX IF NOT EXISTS idx_spins_user      ON daily_luck_spins(user_id);
CREATE INDEX IF NOT EXISTS idx_spins_spin_date ON daily_luck_spins(spin_date);

-- ──────────────────────────────────────────────────────────────────────────────
-- Simple audit log for sensitive actions
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  action      TEXT NOT NULL,
  payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_user_time ON audit_logs(user_id, created_at DESC);

-- ──────────────────────────────────────────────────────────────────────────────
-- Seed minimal games (idempotent upsert by slug)
-- ──────────────────────────────────────────────────────────────────────────────
INSERT INTO games (id, slug, title, category)
VALUES
  (gen_random_uuid(), '2048',           '2048',           'puzzle'),
  (gen_random_uuid(), 'brick-breaker',  'Brick Breaker',  'arcade'),
  (gen_random_uuid(), 'brick-match',    'Retro Match',    'match-3'),
  (gen_random_uuid(), 'retro-runner',   'Retro Runner',   'runner'),
  (gen_random_uuid(), 'tetris',         'Tetris',         'puzzle')
ON CONFLICT (slug)
DO UPDATE SET title = EXCLUDED.title, category = EXCLUDED.category;

-- ──────────────────────────────────────────────────────────────────────────────
-- Helpful, read-optimized views
-- ──────────────────────────────────────────────────────────────────────────────

-- v_user_profile: denormalized profile summary (as in original, kept stable)
--  - wallet C안 필드(exp, tickets, games_played)를 함께 노출하여
--    프론트/관리 대시보드에서 바로 사용할 수 있게 확장.
CREATE OR REPLACE VIEW v_user_profile AS
SELECT
  u.id,
  COALESCE(u.username::text, split_part(u.email::text,'@',1)) AS handle,
  u.display_name,
  u.avatar_url,
  u.email,
  s.xp,
  s.level,
  s.coins,
  s.exp,
  s.tickets,
  s.games_played,
  s.last_login_at,
  (SELECT COUNT(1)                FROM game_runs r WHERE r.user_id = u.id) AS total_runs,
  (SELECT COALESCE(MAX(score),0)  FROM game_runs r WHERE r.user_id = u.id) AS best_score_any
FROM users u
LEFT JOIN user_stats s ON s.user_id = u.id;

-- v_leaderboard_top: best score per user for a given game (windowed)
--   Usage example:
--     SELECT * FROM v_leaderboard_top WHERE game_slug = '2048' ORDER BY top_score DESC LIMIT 100;
CREATE OR REPLACE VIEW v_leaderboard_top AS
WITH runs AS (
  SELECT
    g.slug                  AS game_slug,
    r.user_id,
    r.score,
    r.started_at,
    row_number() OVER (PARTITION BY g.slug, r.user_id ORDER BY r.score DESC, r.started_at ASC) AS rn
  FROM game_runs r
  JOIN games g ON g.id = r.game_id
)
SELECT game_slug, user_id, score AS top_score
FROM runs
WHERE rn = 1;

-- v_recent_events: last 50 wallet transactions by user (for quick feeds)
--  - C안 확장 필드(reason, game, exp_delta, tickets_delta, plays_delta, meta)를 모두 포함.
CREATE OR REPLACE VIEW v_recent_events AS
SELECT
  t.user_id,
  t.created_at,
  t.type,
  t.amount,
  t.balance_after,
  t.ref_table,
  t.ref_id,
  t.note,
  t.reason,
  t.game,
  t.exp_delta,
  t.tickets_delta,
  t.plays_delta,
  t.meta
FROM transactions t
ORDER BY t.created_at DESC
LIMIT 5000;  -- “recent” for dashboards (scan friendly thanks to idx_txn_user_time)

COMMIT;

-- ──────────────────────────────────────────────────────────────────────────────
-- DOWN (manual rollback plan — run in a TX)
-- BEGIN;
-- DROP VIEW IF EXISTS v_recent_events;
-- DROP VIEW IF EXISTS v_leaderboard_top;
-- DROP VIEW IF EXISTS v_user_profile;
-- DROP TABLE IF EXISTS audit_logs;
-- DROP TABLE IF EXISTS daily_luck_spins;
-- DROP TRIGGER IF EXISTS transactions_apply ON transactions;
-- DROP FUNCTION IF EXISTS apply_wallet_transaction();
-- DROP FUNCTION IF EXISTS ensure_user_stats_row(UUID);
-- DROP TABLE IF EXISTS transactions;
-- DROP TABLE IF EXISTS purchases;
-- DROP TABLE IF EXISTS shop_items;
-- DROP TABLE IF EXISTS game_runs;
-- DROP TABLE IF EXISTS games;
-- DROP TABLE IF EXISTS user_stats;
-- DROP TABLE IF EXISTS sessions;
-- DROP TABLE IF EXISTS oauth_accounts;
-- DROP TABLE IF EXISTS users;
-- DROP FUNCTION IF EXISTS set_updated_at();
-- DROP TYPE IF EXISTS txn_type;
-- DROP TYPE IF EXISTS oauth_provider;
-- COMMIT;
