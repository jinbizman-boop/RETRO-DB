-- 011_transactions_run_id_idempotency.sql
-- -------------------------------------------------------------------
-- 목적
--   • 게임 1회 플레이(run) 단위로 보상이 중복 지급되지 않도록,
--     transactions 테이블에 run_id 컬럼을 추가하고
--     (user_id, run_id) 조합에 UNIQUE 인덱스를 건다.
--   • run_id 는 /api/games/finish.ts, /api/wallet/reward.ts 등에서
--     "한 판"을 대표하는 식별자(클라이언트 runId 또는 서버에서 생성한 UUID)로 사용한다.
-- -------------------------------------------------------------------

BEGIN;

-- 1) run_id 컬럼 추가 (이미 있으면 건너뜀)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'transactions'
      AND column_name  = 'run_id'
  ) THEN
    ALTER TABLE transactions
      ADD COLUMN run_id TEXT;
  END IF;
END
$$;

-- 2) (user_id, run_id) 조합에 UNIQUE 인덱스
--    • run_id 가 NULL 인 레코드는 제외 (WHERE 절)
CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_user_run
  ON transactions(user_id, run_id)
  WHERE run_id IS NOT NULL;

-- 3) 주석으로 의미 명시
COMMENT ON COLUMN transactions.run_id IS
  '게임 1회 플레이 단위 idempotency key. 같은 (user_id, run_id) 조합은 한 번만 보상 반영.';

COMMIT;
