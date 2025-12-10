-- 009_canonical_wallet_schema.sql (v3 - legacy 컬럼 의존 제거)
-- ------------------------------------------------------------------
-- Purpose
--   1) RETRO GAMES의 “지갑/게임 자원 정본(canonical)”을 명시적으로 선언.
--       - 정본 테이블: user_stats, transactions
--   2) 레거시/브리지 테이블(user_progress, wallet_balances, wallet_items)에
--      명확한 TABLE COMMENT를 부여해서, 향후 혼동을 방지.
--   3) 프론트/백엔드에서 공통으로 사용할 수 있는 조회용 VIEW(v_user_wallet)를
--      제공하여, “어디를 기준으로 잔액을 가져와야 하는지”를 통일.
--
-- Note
--   - 실 운영 DB에서 legacy 테이블 컬럼 구성이 다를 수 있으므로
--     user_progress / wallet_balances / wallet_items 에 대해서는
--     컬럼 단위 COMMENT 를 붙이지 않는다(테이블만 설명).
-- ------------------------------------------------------------------

BEGIN;

-- ───────────────────────────────────────────────────────────────
-- 1) Canonical 자원/지갑 스키마 선언 (user_stats, transactions)
-- ───────────────────────────────────────────────────────────────
DO $$
BEGIN
  -- 1-1) user_stats: coins + tickets + exp + games_played 의 정본
  IF to_regclass('public.user_stats') IS NOT NULL THEN
    COMMENT ON TABLE user_stats IS
      'Canonical user resource snapshot (wallet C-arch): coins, tickets, exp, games_played. 모든 잔액 계산의 기준이 되는 정본 스냅샷.';

    COMMENT ON COLUMN user_stats.user_id IS
      'FK → users.id. 이 계정의 지갑/경험치 정본을 나타내는 PK.';
    COMMENT ON COLUMN user_stats.coins IS
      '현재 코인(포인트) 잔액. 모든 지불/적립은 transactions 를 통해 반영되며, 이 컬럼은 항상 0 이상이어야 한다.';
    COMMENT ON COLUMN user_stats.exp IS
      '게임/이벤트로 획득한 누적 경험치(exp). HUD / 통계에 사용.';
    COMMENT ON COLUMN user_stats.tickets IS
      '티켓/뽑기/이벤트 등에서 사용하는 잔여 티켓 수. 항상 0 이상.';
    COMMENT ON COLUMN user_stats.games_played IS
      '해당 계정이 플레이한 게임 횟수 누계.';
    -- level 컬럼은 DB에 없을 수 있으므로 건드리지 않는다.
  END IF;

  -- 1-2) transactions: 모든 자원 변동의 단일 원장(ledger)
  IF to_regclass('public.transactions') IS NOT NULL THEN
    COMMENT ON TABLE transactions IS
      'Canonical wallet/game ledger. 모든 코인/티켓/경험치/플레이수 변동을 기록하는 단일 원장. user_stats 스냅샷으로 집계된다.';

    COMMENT ON COLUMN transactions.user_id IS
      '자원 변동이 적용되는 대상 계정(FK → users.id).';
    COMMENT ON COLUMN transactions.type IS
      '거래 유형(txn_type). earn/spend/purchase/reward/game 등 비즈니스 이벤트를 표현.';
    COMMENT ON COLUMN transactions.amount IS
      '코인(포인트) 변동량. 0도 허용(경험치/티켓만 변동되는 트랜잭션의 경우).';
    COMMENT ON COLUMN transactions.exp_delta IS
      '이 트랜잭션으로 인해 변동된 경험치(exp) 양.';
    COMMENT ON COLUMN transactions.tickets_delta IS
      '이 트랜잭션으로 인해 변동된 티켓 변동량.';
    COMMENT ON COLUMN transactions.plays_delta IS
      '플레이 횟수(games_played) 변동량. 보통 1 또는 0.';
    COMMENT ON COLUMN transactions.balance_after IS
      '트랜잭션 적용 직후의 코인 잔액 스냅샷. user_stats.coins 와 동기화되어야 한다.';
    COMMENT ON COLUMN transactions.idempotency_key IS
      '멱등성 보장을 위한 키. 동일 이벤트/게임 런(run)에 대해 중복 적립을 방지하는 용도로 사용.';
  END IF;
END $$;

-- ───────────────────────────────────────────────────────────────
-- 2) Legacy / Bridge 테이블에 명시적인 TABLE 주석 부여
--    - 컬럼 구조는 실제 DB마다 다를 수 있으므로 컬럼엔 손대지 않음
-- ───────────────────────────────────────────────────────────────
DO $$
BEGIN
  -- 2-1) user_progress (TEXT 기반 user_id 진행도 테이블)
  IF to_regclass('public.user_progress') IS NOT NULL THEN
    COMMENT ON TABLE user_progress IS
      'LEGACY / BRIDGE: TEXT 기반 user_id 를 사용하는 구(progress) 구조. 정본은 user_stats + transactions 이며, 새 코드는 가능하면 이 테이블을 직접 참조하지 말 것.';
  END IF;

  -- 2-2) wallet_balances (TEXT 기반 잔액 테이블)
  IF to_regclass('public.wallet_balances') IS NOT NULL THEN
    COMMENT ON TABLE wallet_balances IS
      'LEGACY / BRIDGE: TEXT 기반 user_id + 단일 balance 컬럼을 사용하는 구 지갑 구조. 정본 잔액은 user_stats.coins 이며, 이 테이블은 호환/마이그레이션용으로만 유지.';
  END IF;

  -- 2-3) wallet_items (TEXT 기반 인벤토리 브리지 테이블)
  IF to_regclass('public.wallet_items') IS NOT NULL THEN
    COMMENT ON TABLE wallet_items IS
      'BRIDGE: TEXT 기반 user_id + item_id 조합으로 관리되는 런타임 지갑 인벤토리. 정식 인벤토리는 003_shop_effects.sql 의 user_inventory / user_effects 를 따르며, wallet_items 는 브리지/호환용.';
  END IF;
END $$;

-- ───────────────────────────────────────────────────────────────
-- 3) 조회용 VIEW 추가: v_user_wallet
-- ───────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW v_user_wallet AS
SELECT
  u.id            AS user_id,
  u.email         AS email,
  us.coins        AS coins,
  us.tickets      AS tickets,
  us.exp          AS exp,
  us.games_played AS games_played,
  us.created_at   AS stats_created_at,
  us.updated_at   AS stats_updated_at
FROM users u
LEFT JOIN user_stats us
       ON us.user_id = u.id;

COMMENT ON VIEW v_user_wallet IS
  'Canonical per-user wallet snapshot for HUD/API. users.id 와 user_stats 를 조인하여 coins/tickets/exp/games_played 를 단일 뷰로 제공한다. 정본(user_stats + transactions)에 기반한 조회 전용 뷰.';

COMMIT;
