-- 005_user_stats_wallet_extension.sql
-- Retro Games – Wallet System Full Extension (C안 반영)
-- Safe, idempotent, and compatible with 001_init.sql, 002_rename_tables.sql
-- Target: Neon/PostgreSQL 13+

BEGIN;

-- ───────────────────────────────────────────────────────────────
-- 1) user_stats 확장: tickets, exp, games_played 정식 반영
--    (기존 coins 전용 구조 → wallet API C안 구조로 확장)
-- ───────────────────────────────────────────────────────────────

-- coins → 그대로 사용 (001_init.sql 기준)
-- xp, level 필드는 제거하고 exp, games_played, tickets 로 교체

-- STEP 1: xp/level 컬럼 제거 (존재할 경우에만)
ALTER TABLE user_stats
  DROP COLUMN IF EXISTS xp,
  DROP COLUMN IF EXISTS level;

-- STEP 2: 신규 컬럼 생성 (없을 경우만)
ALTER TABLE user_stats
  ADD COLUMN IF NOT EXISTS tickets       BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS exp           BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS games_played  BIGINT NOT NULL DEFAULT 0;

-- STEP 3: coins, tickets, exp, games_played 모두 음수 불가
ALTER TABLE user_stats
  DROP CONSTRAINT IF EXISTS user_stats_coins_check,
  ADD CONSTRAINT user_stats_coins_check CHECK (coins >= 0);

ALTER TABLE user_stats
  DROP CONSTRAINT IF EXISTS user_stats_tickets_check,
  ADD CONSTRAINT user_stats_tickets_check CHECK (tickets >= 0);

ALTER TABLE user_stats
  DROP CONSTRAINT IF EXISTS user_stats_exp_check,
  ADD CONSTRAINT user_stats_exp_check CHECK (exp >= 0);

ALTER TABLE user_stats
  DROP CONSTRAINT IF EXISTS user_stats_games_check,
  ADD CONSTRAINT user_stats_games_check CHECK (games_played >= 0);


-- ───────────────────────────────────────────────────────────────
-- 2) transactions 확장: exp_delta / tickets_delta / plays_delta / game / reason / meta
-- ───────────────────────────────────────────────────────────────

ALTER TABLE wallet_transactions
  ADD COLUMN IF NOT EXISTS exp_delta      BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tickets_delta  BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS plays_delta    BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS game           TEXT,
  ADD COLUMN IF NOT EXISTS reason         TEXT,
  ADD COLUMN IF NOT EXISTS meta           JSONB DEFAULT '{}'::jsonb;

-- amount(코인 증감)는 이미 존재함
-- balance_after 도 이미 존재함


-- ───────────────────────────────────────────────────────────────
-- 3) ensure_user_stats_row(p_user) 보강
--    user_stats의 새로운 필드를 포함한 안전한 UPSERT
-- ───────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION ensure_user_stats_row(p_user UUID) RETURNS void AS $$
BEGIN
  INSERT INTO user_stats (user_id, coins, tickets, exp, games_played)
  VALUES (p_user, 0, 0, 0, 0)
  ON CONFLICT (user_id) DO NOTHING;
END;
$$ LANGUAGE plpgsql;


-- ───────────────────────────────────────────────────────────────
-- 4) apply_wallet_transaction 트리거 확장
--    (C안 : coins + tickets + exp + games_played를 모두 업데이트)
-- ───────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION apply_wallet_transaction() RETURNS TRIGGER AS $$
DECLARE
  s_coins    BIGINT;
  s_tickets  BIGINT;
  s_exp      BIGINT;
  s_plays    BIGINT;

  new_coins   BIGINT;
  new_tickets BIGINT;
  new_exp     BIGINT;
  new_plays   BIGINT;
BEGIN
  -- Ensure stats row exists
  PERFORM ensure_user_stats_row(NEW.user_id);

  -- FOR UPDATE – locking
  SELECT coins, tickets, exp, games_played
  INTO s_coins, s_tickets, s_exp, s_plays
  FROM user_stats
  WHERE user_id = NEW.user_id
  FOR UPDATE;

  -- Calculate new values
  new_coins   := GREATEST(0, LEAST(5000, s_coins + NEW.amount));
  new_tickets := GREATEST(0, s_tickets + NEW.tickets_delta);
  new_exp     := GREATEST(0, s_exp + NEW.exp_delta);
  new_plays   := GREATEST(0, s_plays + NEW.plays_delta);

  -- Write result back to user_stats
  UPDATE user_stats
  SET
    coins        = new_coins,
    tickets      = new_tickets,
    exp          = new_exp,
    games_played = new_plays,
    updated_at = NOW()
  WHERE user_id = NEW.user_id;

  -- Set balance_after
  NEW.balance_after := new_coins;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 트리거 적용 (이미 있으면 Skip)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'wallet_transactions_apply'
  ) THEN
    CREATE TRIGGER wallet_transactions_apply
      BEFORE INSERT ON wallet_transactions
      FOR EACH ROW
      EXECUTE FUNCTION apply_wallet_transaction();
  END IF;
END;
$$;


-- ───────────────────────────────────────────────────────────────
-- 5) 보조 인덱스 최적화
-- ───────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_user_stats_exp        ON user_stats(exp DESC);
CREATE INDEX IF NOT EXISTS idx_user_stats_plays      ON user_stats(games_played DESC);
CREATE INDEX IF NOT EXISTS idx_wallet_tx_game        ON wallet_transactions(game);
CREATE INDEX IF NOT EXISTS idx_wallet_tx_user_time   ON wallet_transactions(user_id, created_at DESC);


COMMIT;

-- END OF FILE
