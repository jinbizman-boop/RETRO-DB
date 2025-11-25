-- 005_user_stats_wallet_extension.sql
-- Retro Games – Wallet System Full Extension (C안 반영)
-- Safe, idempotent, and compatible with 001_init.sql, 002_rename_tables.sql
-- Target: Neon/PostgreSQL 13+
--
-- 주요 목적
--  - user_stats를 wallet C안 구조(coins + tickets + exp + games_played)로 완전히 정착
--  - transactions(구 wallet_transactions)에 exp_delta/tickets_delta/plays_delta/game/reason/meta 확장
--  - ensure_user_stats_row / apply_wallet_transaction를 통합·강화하여
--    “트랜잭션 1건 = user_stats 스냅샷 자동 반영”이 항상 보장되도록 함
--  - 기존 DB/구조가 있어도 안전하게 재실행 가능한(idempotent) 마이그레이션

BEGIN;

-- ───────────────────────────────────────────────────────────────
-- 0) 테이블/환경 존재 여부 유틸 (이 스크립트 내에서만 사용)
-- ───────────────────────────────────────────────────────────────

-- NOTE: 단순한 IF EXISTS 패턴을 최대한 사용하지만,
--       wallet_transactions/transactions 양쪽 이름을 모두 포용하기 위해
--       ALTER TABLE IF EXISTS 구문과 DO 블록을 함께 사용한다.

-- ───────────────────────────────────────────────────────────────
-- 1) user_stats 확장: tickets, exp, games_played 정식 반영
--    (기존 coins 전용 구조 → wallet API C안 구조로 확장)
-- ───────────────────────────────────────────────────────────────
-- 원래 의도: xp, level 필드를 제거하고 exp, games_played, tickets로 교체.
-- 현 구조(001_init.sql 기준)에서는 xp/level이 이미 존재하며,
-- 여러 뷰/코드에서 참조될 수 있으므로:
--  - xp/level은 유지하되 exp를 정식 지갑 경험치로 사용
--  - xp는 exp와 동기화되도록 apply_wallet_transaction()에서 갱신

-- STEP 1: 신규 컬럼 생성 (없을 경우만)
ALTER TABLE user_stats
  ADD COLUMN IF NOT EXISTS tickets       BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS exp           BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS games_played  BIGINT NOT NULL DEFAULT 0;

-- STEP 2: coins, tickets, exp, games_played 모두 음수 불가 (제약 통일/강화)
DO $$
DECLARE
  c_name TEXT;
BEGIN
  -- coins >= 0
  SELECT conname INTO c_name
  FROM pg_constraint
  WHERE conrelid = 'user_stats'::regclass
    AND contype  = 'c'
    AND pg_get_constraintdef(oid) LIKE '%coins >= 0%';

  IF c_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE user_stats DROP CONSTRAINT %I', c_name);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'user_stats'::regclass
      AND conname  = 'user_stats_coins_nonneg'
  ) THEN
    ALTER TABLE user_stats
      ADD CONSTRAINT user_stats_coins_nonneg CHECK (coins >= 0);
  END IF;

  -- tickets >= 0
  SELECT conname INTO c_name
  FROM pg_constraint
  WHERE conrelid = 'user_stats'::regclass
    AND contype  = 'c'
    AND pg_get_constraintdef(oid) LIKE '%tickets >= 0%';

  IF c_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE user_stats DROP CONSTRAINT %I', c_name);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'user_stats'::regclass
      AND conname  = 'user_stats_tickets_nonneg'
  ) THEN
    ALTER TABLE user_stats
      ADD CONSTRAINT user_stats_tickets_nonneg CHECK (tickets >= 0);
  END IF;

  -- exp >= 0
  SELECT conname INTO c_name
  FROM pg_constraint
  WHERE conrelid = 'user_stats'::regclass
    AND contype  = 'c'
    AND pg_get_constraintdef(oid) LIKE '%exp >= 0%';

  IF c_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE user_stats DROP CONSTRAINT %I', c_name);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'user_stats'::regclass
      AND conname  = 'user_stats_exp_nonneg'
  ) THEN
    ALTER TABLE user_stats
      ADD CONSTRAINT user_stats_exp_nonneg CHECK (exp >= 0);
  END IF;

  -- games_played >= 0
  SELECT conname INTO c_name
  FROM pg_constraint
  WHERE conrelid = 'user_stats'::regclass
    AND contype  = 'c'
    AND pg_get_constraintdef(oid) LIKE '%games_played >= 0%';

  IF c_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE user_stats DROP CONSTRAINT %I', c_name);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'user_stats'::regclass
      AND conname  = 'user_stats_games_played_nonneg'
  ) THEN
    ALTER TABLE user_stats
      ADD CONSTRAINT user_stats_games_played_nonneg CHECK (games_played >= 0);
  END IF;
END
$$;

-- STEP 3: xp → exp 동기화 (exp가 비어 있는 기존 레거시 DB를 위한 1회성 처리)
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
    UPDATE user_stats
    SET exp = xp
    WHERE exp = 0;
  END IF;
END
$$;

-- NOTE: level 컬럼이 GENERATED ALWAYS AS (GREATEST(1, (xp/1000)::INT + 1)) STORED 인 경우,
--       xp와 exp를 동기화하면 기존 레벨 체계(레벨 UI)는 그대로 유지되면서
--       exp를 C안용 지갑 경험치로 활용할 수 있다.

-- 인덱스 강화 (있으면 유지)
CREATE INDEX IF NOT EXISTS idx_user_stats_exp_desc      ON user_stats(exp DESC);
CREATE INDEX IF NOT EXISTS idx_user_stats_games_desc    ON user_stats(games_played DESC);

-- ───────────────────────────────────────────────────────────────
-- 2) transactions 확장: exp_delta / tickets_delta / plays_delta / game / reason / meta
--    (구 wallet_transactions 이름과의 호환을 고려)
-- ───────────────────────────────────────────────────────────────

-- 우선, 새 표준 테이블명인 transactions에 컬럼을 추가
ALTER TABLE IF EXISTS transactions
  ADD COLUMN IF NOT EXISTS exp_delta      BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tickets_delta  BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS plays_delta    BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS game           TEXT,
  ADD COLUMN IF NOT EXISTS reason         TEXT,
  ADD COLUMN IF NOT EXISTS meta           JSONB DEFAULT '{}'::jsonb;

-- 예전 스키마에서 wallet_transactions 라는 이름을 사용했다면, 그쪽에도 동일 규격을 보강
ALTER TABLE IF EXISTS wallet_transactions
  ADD COLUMN IF NOT EXISTS exp_delta      BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tickets_delta  BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS plays_delta    BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS game           TEXT,
  ADD COLUMN IF NOT EXISTS reason         TEXT,
  ADD COLUMN IF NOT EXISTS meta           JSONB DEFAULT '{}'::jsonb;

-- amount(코인 증감)는 이미 존재함
-- balance_after 도 이미 존재함
-- amount만 0이 아니어야 한다는 제약을 완화하고,
-- 최소 하나의 delta(amount/exp/tickets/plays)가 변해야 하는 제약으로 교체

DO $$
DECLARE
  c_name TEXT;
BEGIN
  -- transactions 테이블용
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'transactions') THEN
    SELECT conname INTO c_name
    FROM pg_constraint
    WHERE conrelid = 'transactions'::regclass
      AND contype  = 'c'
      AND pg_get_constraintdef(oid) LIKE '%amount <> 0%';

    IF c_name IS NOT NULL THEN
      EXECUTE format('ALTER TABLE transactions DROP CONSTRAINT %I', c_name);
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'transactions'::regclass
        AND conname  = 'transactions_amount_nonzero_or_deltas'
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
  END IF;

  -- wallet_transactions 테이블이 별도로 존재하는 경우도 동일하게 처리
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'wallet_transactions') THEN
    SELECT conname INTO c_name
    FROM pg_constraint
    WHERE conrelid = 'wallet_transactions'::regclass
      AND contype  = 'c'
      AND pg_get_constraintdef(oid) LIKE '%amount <> 0%';

    IF c_name IS NOT NULL THEN
      EXECUTE format('ALTER TABLE wallet_transactions DROP CONSTRAINT %I', c_name);
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'wallet_transactions'::regclass
        AND conname  = 'wallet_transactions_amount_nonzero_or_deltas'
    ) THEN
      ALTER TABLE wallet_transactions
        ADD CONSTRAINT wallet_transactions_amount_nonzero_or_deltas
        CHECK (
          amount <> 0
          OR exp_delta <> 0
          OR tickets_delta <> 0
          OR plays_delta <> 0
        );
    END IF;
  END IF;
END
$$;

-- 인덱스 (transactions / wallet_transactions 양쪽 모두 고려)
CREATE INDEX IF NOT EXISTS idx_transactions_user_time   ON transactions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_game        ON transactions(game);
CREATE INDEX IF NOT EXISTS idx_wallet_tx_user_time      ON wallet_transactions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wallet_tx_game           ON wallet_transactions(game);

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
  -- stats row 보장
  PERFORM ensure_user_stats_row(NEW.user_id);

  -- FOR UPDATE – 동시성 대비 락
  SELECT coins, tickets, exp, games_played
  INTO s_coins, s_tickets, s_exp, s_plays
  FROM user_stats
  WHERE user_id = NEW.user_id
  FOR UPDATE;

  -- 새 값 계산
  new_coins   := GREATEST(0, COALESCE(s_coins, 0)   + COALESCE(NEW.amount, 0));
  new_tickets := GREATEST(0, COALESCE(s_tickets, 0) + COALESCE(NEW.tickets_delta, 0));
  new_exp     := GREATEST(0, COALESCE(s_exp, 0)     + COALESCE(NEW.exp_delta, 0));
  new_plays   := GREATEST(0, COALESCE(s_plays, 0)   + COALESCE(NEW.plays_delta, 0));

  -- coins 음수 방지 (추가 상한선/캡은 애플리케이션 레벨에서 처리)
  IF new_coins < 0 THEN
    RAISE EXCEPTION 'Insufficient balance: % + % = %', s_coins, NEW.amount, new_coins
      USING ERRCODE = '23514';
  END IF;

  -- 트랜잭션 레코드에 최종 잔액 기록
  NEW.balance_after := new_coins;

  -- user_stats 스냅샷 업데이트
  UPDATE user_stats
  SET
    coins        = new_coins,
    tickets      = new_tickets,
    exp          = new_exp,
    xp           = new_exp,  -- xp와 exp 동기화 (level GENERATED 규칙 유지)
    games_played = new_plays,
    updated_at   = NOW()
  WHERE user_id = NEW.user_id;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 트리거 적용
DO $$
BEGIN
  -- 표준 테이블명: transactions
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'transactions') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgname = 'transactions_apply'
    ) THEN
      CREATE TRIGGER transactions_apply
        BEFORE INSERT ON transactions
        FOR EACH ROW
        EXECUTE FUNCTION apply_wallet_transaction();
    END IF;
  END IF;

  -- 예전 명칭: wallet_transactions (존재하는 경우에만)
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'wallet_transactions') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgname = 'wallet_transactions_apply'
    ) THEN
      CREATE TRIGGER wallet_transactions_apply
        BEFORE INSERT ON wallet_transactions
        FOR EACH ROW
        EXECUTE FUNCTION apply_wallet_transaction();
    END IF;
  END IF;
END
$$;

-- ───────────────────────────────────────────────────────────────
-- 5) user_stats 관련 인덱스 최적화 (추가)
-- ───────────────────────────────────────────────────────────────

-- coins/exp/tickets/games_played 기준 랭킹/대시보드를 위한 인덱스 보강
CREATE INDEX IF NOT EXISTS idx_user_stats_coins_desc    ON user_stats(coins DESC);
CREATE INDEX IF NOT EXISTS idx_user_stats_tickets_desc  ON user_stats(tickets DESC);

COMMIT;

-- END OF FILE
